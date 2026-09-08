// Unit tests for the pure sync write-path logic (Req 5.2, 5.5, 5.6).
//
// The conflict-resolution rule itself is exhaustively property-tested in
// `@ldr/core` (Property 18, task 4.2); these tests cover the wiring task 14.1
// adds around it: composite item-id parsing, request validation (including the
// column whitelist that keeps `pairing_id` server-owned), the stale-vs-newer
// commit decision against the HLC stored on the row, and the oldest-first batch
// ordering that makes a drained queue converge on its newest change.
//
// Run with: deno test supabase/functions/_shared/sync-items.test.ts
import { assert, assertEquals, assertFalse } from "std/assert/mod.ts";

import {
  accountId,
  type DataChange,
  type HLCTimestamp,
} from "./sync-hlc.ts";
import {
  decideCommit,
  isSharedItemType,
  orderByHLC,
  parseChange,
  parseItemKey,
  parseStoredHLC,
  SYNC_ITEM_SPECS,
} from "./sync-items.ts";

const ALICE = "11111111-1111-4111-8111-111111111111";
const BOB = "22222222-2222-4222-8222-222222222222";
const DATE_ID = "33333333-3333-4333-8333-333333333333";

function hlc(
  physical: number,
  counter = 0,
  originAccountId = ALICE,
): HLCTimestamp {
  return { physical, counter, originAccountId: accountId(originAccountId) };
}

function change(overrides: Partial<DataChange> = {}): DataChange {
  return {
    itemId: DATE_ID,
    itemType: "relationship_date",
    payload: { title: "Anniversary" },
    hlc: hlc(1_000),
    originAccountId: accountId(ALICE),
    ...overrides,
  };
}

Deno.test("every shared item type has a spec", () => {
  assert(isSharedItemType("relationship_date"));
  assert(isSharedItemType("notification_settings"));
  assertFalse(isSharedItemType("reminder"));
  assertFalse(isSharedItemType("notification"));
  assertEquals(Object.keys(SYNC_ITEM_SPECS).length, 7);
});

Deno.test("a composite itemId splits into the table's key columns", () => {
  const spec = SYNC_ITEM_SPECS.quiz_self_answer;
  assertEquals(parseItemKey(spec, `s:${ALICE}:q`), {
    session_id: "s",
    account_id: ALICE,
    question_id: "q",
  });
  // Wrong arity and empty parts are rejected.
  assertEquals(parseItemKey(spec, `s:${ALICE}`), null);
  assertEquals(parseItemKey(spec, `s::q`), null);
});

Deno.test("a well-formed change is normalized", () => {
  const result = parseChange(
    {
      itemId: DATE_ID,
      itemType: "relationship_date",
      payload: { title: "Anniversary", date: "2026-08-26" },
      hlc: { physical: 1_000, counter: 2, originAccountId: ALICE },
      originAccountId: ALICE,
    },
    ALICE,
  );
  assert(result.ok);
  assertEquals(result.change.itemType, "relationship_date");
  assertEquals(result.change.hlc, hlc(1_000, 2));
});

Deno.test("a payload writing a server-owned column is rejected", () => {
  const result = parseChange(
    {
      itemId: DATE_ID,
      itemType: "relationship_date",
      // pairing_id is set by the server from the caller's pairing; a client that
      // could write it would re-home the row into another pairing.
      payload: { title: "Anniversary", pairing_id: "other-pairing" },
      hlc: { physical: 1_000, counter: 0, originAccountId: ALICE },
    },
    ALICE,
  );
  assertFalse(result.ok);
  if (!result.ok) {
    assertEquals(result.error.code, "INVALID_CHANGE");
    assertEquals(result.error.details?.unknownFields, ["pairing_id"]);
  }
});

Deno.test("a change stamped by another account is rejected", () => {
  const result = parseChange(
    {
      itemId: DATE_ID,
      itemType: "relationship_date",
      payload: { title: "Anniversary" },
      hlc: { physical: 1_000, counter: 0, originAccountId: BOB },
      originAccountId: BOB,
    },
    ALICE,
  );
  assertFalse(result.ok);
  if (!result.ok) assertEquals(result.error.code, "ORIGIN_MISMATCH");
});

Deno.test("a malformed hlc is rejected", () => {
  for (const bad of [undefined, {}, { physical: 1.5, counter: 0, originAccountId: ALICE }, { physical: 1, counter: -1, originAccountId: ALICE }]) {
    const result = parseChange(
      {
        itemId: DATE_ID,
        itemType: "relationship_date",
        payload: {},
        hlc: bad,
      },
      ALICE,
    );
    assertFalse(result.ok);
    if (!result.ok) assertEquals(result.error.code, "INVALID_HLC");
  }
});

Deno.test("a row with no stored hlc accepts the change", () => {
  assertEquals(parseStoredHLC(null), null);
  assert(decideCommit(change(), null));
});

Deno.test("a newer change commits and a stale one is superseded", () => {
  const stored = hlc(1_000, 0, BOB);
  assert(decideCommit(change({ hlc: hlc(1_001) }), stored));
  assertFalse(decideCommit(change({ hlc: hlc(999) }), stored));
});

Deno.test("identical timestamps keep the stored value (replay is a no-op)", () => {
  const stored = hlc(1_000, 3, ALICE);
  assertFalse(decideCommit(change({ hlc: hlc(1_000, 3, ALICE) }), stored));
});

Deno.test("ties break on counter, then on origin account id", () => {
  // Same physical time, greater counter wins.
  assert(decideCommit(change({ hlc: hlc(1_000, 1) }), hlc(1_000, 0, BOB)));
  assertFalse(decideCommit(change({ hlc: hlc(1_000, 0) }), hlc(1_000, 1, BOB)));
  // Same physical time and counter: the greater origin account id wins, so the
  // decision is the same on both partners' clients (Req 5.6). ALICE < BOB.
  assertFalse(decideCommit(change({ hlc: hlc(1_000, 0, ALICE) }), hlc(1_000, 0, BOB)));
});

Deno.test("a batch is applied oldest-hlc-first, ties in submission order", () => {
  const entries = [
    { change: change({ hlc: hlc(3_000) }), index: 0 },
    { change: change({ hlc: hlc(1_000) }), index: 1 },
    { change: change({ hlc: hlc(2_000, 1) }), index: 2 },
    { change: change({ hlc: hlc(2_000, 1) }), index: 3 },
  ];
  assertEquals(orderByHLC(entries).map((entry) => entry.index), [1, 2, 3, 0]);
});
