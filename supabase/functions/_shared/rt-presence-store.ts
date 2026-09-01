// Server-authoritative persistence + Realtime wiring for the Presence-driven
// pause / rejoin transitions of a real-time game session
// (Requirements 6.6, 6.7, 6.8).
//
// Infrastructure only: every decision is made by pure code — the 30-second
// disconnect evaluation in `rt-presence.ts` and the authoritative state
// transitions in `@ldr/core/rt-session` (`pauseSession` preserves the game
// state, `resumeSession` restores it). This module loads the session, commits
// the transition with a CONDITIONAL update so concurrent reports cannot pause
// or resume twice, records the notification, and publishes the Broadcast signal
// both partners listen to.

import { type SupabaseClient } from "@supabase/supabase-js";

import { broadcast, gameChannelTopic } from "./realtime.ts";
import {
  type NotificationInsert,
  type PairingMembers,
  type RTSessionRow,
  type RTSessionSnapshot,
  toSnapshot,
} from "./rt-presence.ts";

/** Columns of `rt_sessions` these functions read. */
const SESSION_COLUMNS =
  "id, pairing_id, game_id, state, game_state, outcome, pending_since, paused_since";

/** A loaded session together with the two accounts allowed to play it. */
export interface LoadedSession {
  readonly session: RTSessionSnapshot;
  readonly members: PairingMembers;
}

/**
 * Load a real-time session and its pairing's members, or `null` when the
 * session does not exist (or its pairing has vanished). Uses the service-role
 * client, so RLS is bypassed — callers MUST check membership themselves before
 * revealing anything about the session.
 */
export async function loadSession(
  db: SupabaseClient,
  sessionId: string,
): Promise<LoadedSession | null> {
  const { data: row, error } = await db
    .from("rt_sessions")
    .select(SESSION_COLUMNS)
    .eq("id", sessionId)
    .maybeSingle();

  if (error || !row) return null;

  const session = toSnapshot(row as unknown as RTSessionRow);

  const { data: pairing, error: pairingErr } = await db
    .from("pairings")
    .select("id, member_a, member_b")
    .eq("id", session.pairingId)
    .maybeSingle();

  if (pairingErr || !pairing) return null;

  return {
    session,
    members: {
      a: pairing.member_a as string,
      b: pairing.member_b as string,
    },
  };
}

/**
 * Commit the pause transition: `active -> paused`, stamping `paused_since` so
 * the 5-minute rejoin window (Req 6.7) and the termination job (Req 6.10) both
 * run from the same instant. `game_state` is deliberately NOT written — the
 * preserved state is the row that is already there (Req 6.6).
 *
 * The `state = 'active'` predicate makes this a compare-and-set: if a
 * concurrent report already paused the session (or a move terminated it), no row
 * matches and `null` is returned so the caller reports the current state
 * instead of pausing twice.
 */
export async function commitPause(
  db: SupabaseClient,
  sessionId: string,
  pausedSince: number,
): Promise<RTSessionSnapshot | null> {
  const at = new Date(pausedSince).toISOString();
  const { data, error } = await db
    .from("rt_sessions")
    .update({ state: "paused", paused_since: at, updated_at: at })
    .eq("id", sessionId)
    .eq("state", "active")
    .select(SESSION_COLUMNS)
    .maybeSingle();

  if (error || !data) return null;
  return toSnapshot(data as unknown as RTSessionRow);
}

/**
 * Commit the resume transition: `paused -> active`, clearing `paused_since`.
 * `game_state` is again left untouched, which is exactly what makes the resumed
 * session start from the preserved state and present identical state to both
 * partners (Req 6.7).
 *
 * The predicates pin the update to the *same* pause that was validated against
 * the 5-minute window (`paused_since` unchanged), so a concurrent rejoin or a
 * cron termination cannot be overwritten; `null` means the caller should re-read
 * the session.
 */
export async function commitResume(
  db: SupabaseClient,
  sessionId: string,
  pausedSince: number,
  now: number,
): Promise<RTSessionSnapshot | null> {
  const { data, error } = await db
    .from("rt_sessions")
    .update({
      state: "active",
      paused_since: null,
      updated_at: new Date(now).toISOString(),
    })
    .eq("id", sessionId)
    .eq("state", "paused")
    .eq("paused_since", new Date(pausedSince).toISOString())
    .select(SESSION_COLUMNS)
    .maybeSingle();

  if (error || !data) return null;
  return toSnapshot(data as unknown as RTSessionRow);
}

/**
 * Record a derived notification. Duplicates are ignored via the
 * `(recipient_account_id, dedupe_key)` unique index, so a retried presence
 * report never notifies the remaining partner twice for one pause (Req 11.6).
 * Delivery itself (in-app Realtime + best-effort push) is the notification
 * wiring's job; the durable row is what guarantees the partner eventually sees
 * it.
 */
export async function recordNotification(
  db: SupabaseClient,
  notification: NotificationInsert,
): Promise<void> {
  await db
    .from("notifications")
    .upsert(notification, {
      onConflict: "recipient_account_id,dedupe_key",
      ignoreDuplicates: true,
    });
}

/**
 * Publish a Broadcast signal on the session's game channel so both partners
 * converge on the same view (paused, resumed, or the recorded outcome).
 * Best-effort: the authoritative state is the `rt_sessions` row, which either
 * client can re-read on reconnect.
 */
export async function publishSessionEvent(
  sessionId: string,
  event: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  try {
    await broadcast(serviceRoleKey, [
      { topic: gameChannelTopic(sessionId), event, payload },
    ]);
  } catch {
    // Swallow: clients re-derive state from the row on reconnect.
  }
}
