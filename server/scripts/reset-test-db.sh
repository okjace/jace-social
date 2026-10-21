#!/usr/bin/env bash
# Empties the TEST Supabase project in .env.local before scripts/test-jace-sync.mjs.
# Refuses unless .env.local points Jace at the local mock (so it's never the production project).
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; . ./.env.local; set +a
case "${JACE_URL:-}" in http://localhost:*) ;; *) echo "Not a test setup (JACE_URL isn't the local mock) - refusing"; exit 1;; esac
del() { curl -sS -o /dev/null -w "$1 %{http_code}\n" -X DELETE "$SUPABASE_URL/rest/v1/$1?$2" \
  -H "apikey: $SUPABASE_SECRET_KEY" -H "Authorization: Bearer $SUPABASE_SECRET_KEY"; }
del jace_message_links "jace_id=not.is.null"
del jace_deleted_logins "jace_sub=not.is.null"   # (012) deleted Jace logins
del channels "id=not.is.null"          # group chats and their messages, Jace group links
del oauth_requests "state=not.is.null"
del profiles "uuid=not.is.null"        # people, and everything that's theirs
