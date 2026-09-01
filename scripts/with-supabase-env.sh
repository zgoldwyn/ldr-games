#!/usr/bin/env bash
#
# Runs a command with the local Supabase stack's connection details exported.
#
# The integration suites (`*.integration.test.ts`) read SUPABASE_URL,
# SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY through
# `packages/core/src/__harness__/supabase.ts` and SKIP THEMSELVES when the keys
# are absent. That keeps `npm test` green on a machine with no stack, but it also
# means a plain `npm run test:integration` silently proves nothing. This wrapper
# is the "actually run them" entry point:
#
#   npm run test:integration:local
#
# Requires a running stack (`npm run supabase:start`). The keys come from
# `supabase status`, so they are never committed to the repo.
set -euo pipefail

if ! docker info >/dev/null 2>&1; then
  echo "error: Docker is not running. Start Docker Desktop, then 'npm run supabase:start'." >&2
  exit 1
fi

# `supabase status -o env` emits KEY="value" lines (API_URL, ANON_KEY, ...).
status_env="$(npx --no-install supabase status -o env 2>/dev/null || true)"

if [ -z "$status_env" ]; then
  echo "error: could not read 'supabase status'. Is the local stack running?" >&2
  echo "       run: npm run supabase:start" >&2
  exit 1
fi

get() {
  # Extract one KEY's value, stripping the surrounding double quotes.
  printf '%s\n' "$status_env" | sed -n "s/^$1=\"\\(.*\\)\"$/\\1/p" | head -n 1
}

SUPABASE_URL="$(get API_URL)"
SUPABASE_ANON_KEY="$(get ANON_KEY)"
SUPABASE_SERVICE_ROLE_KEY="$(get SERVICE_ROLE_KEY)"

if [ -z "$SUPABASE_ANON_KEY" ] || [ -z "$SUPABASE_SERVICE_ROLE_KEY" ]; then
  echo "error: stack is up but keys are missing from 'supabase status -o env'." >&2
  exit 1
fi

export SUPABASE_URL SUPABASE_ANON_KEY SUPABASE_SERVICE_ROLE_KEY

exec "$@"
