#!/usr/bin/env bash
# Restore test: proves a backup is usable, then throws the copy away.
#
#   bash scripts/restore-test.sh [path/to/ultralink-YYYYmmdd-HHMMSS.dump] [--keep-db]   (npm run db:restore-test)
#
# Default dump: the newest backups/ultralink-*.dump. Its manifest (same name, .json) is required.
# Steps:
#   1. sha256 of the dump == manifest.sha256
#   2. temporary database `ultralink_restore_check` (owner ultralink) cloned from `ultralink_template`
#      (extensions are pre-installed there by the superuser), then
#      pg_restore --no-owner --no-privileges --single-transaction --exit-on-error with the EXTENSION
#      entries filtered out of the TOC (they exist already and need superuser).
#   3. checks: schema_migrations == manifest.migrations (version, name, checksum)
#              exact row count of every table/partition == manifest.row_counts (and same table set)
#              a sample intents→matches join (both sides + match_refs) returns rows when matches exist
#              no orphan intent_refs / matches / intent_scopes
#   4. the temporary database is dropped (also on failure, unless --keep-db).
# Exit code 0 only if every check passed. Never touches the app database.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CHECK_DB="${UL_RESTORE_CHECK_DB:-ultralink_restore_check}"
export PGOPTIONS="-c client_min_messages=warning"
KEEP_DB=0
DUMP=""
for a in "$@"; do
  case "$a" in
    --keep-db) KEEP_DB=1 ;;
    -h|--help) sed -n '2,19p' "$0"; exit 0 ;;
    *) DUMP="$a" ;;
  esac
done
if [ -z "$DUMP" ]; then
  DUMP="$(ls -1 "$ROOT"/backups/ultralink-*.dump 2>/dev/null | sort | tail -1 || true)"
  [ -n "$DUMP" ] || { echo "no backups found in $ROOT/backups — run scripts/backup.sh first" >&2; exit 1; }
fi
[ -f "$DUMP" ] || { echo "dump not found: $DUMP" >&2; exit 1; }
MANIFEST="${DUMP%.dump}.json"
[ -f "$MANIFEST" ] || { echo "manifest not found: $MANIFEST" >&2; exit 1; }

env_get() { [ -f "$ROOT/.env" ] && grep -E "^$1=" "$ROOT/.env" | tail -1 | cut -d= -f2- | sed -e "s/^['\"]//" -e "s/['\"]$//" || true; }
ADMIN_URL="${DATABASE_ADMIN_URL:-$(env_get DATABASE_ADMIN_URL)}"
[ -n "$ADMIN_URL" ] || { echo "DATABASE_ADMIN_URL not found (.env)" >&2; exit 1; }
re='^postgres(ql)?://([^:@/]+)(:([^@]*))?@([^:/?]+)(:([0-9]+))?/([^?]+)'
[[ "$ADMIN_URL" =~ $re ]] || { echo "cannot parse DATABASE_ADMIN_URL" >&2; exit 1; }
export PGUSER="${BASH_REMATCH[2]}" PGPASSWORD="$(printf '%b' "${BASH_REMATCH[4]//%/\\x}")" PGHOST="${BASH_REMATCH[5]}" PGPORT="${BASH_REMATCH[7]:-5432}"
ADMIN_DB="${BASH_REMATCH[8]}"
[[ "$CHECK_DB" =~ ^[a-z_][a-z0-9_]*$ && "$CHECK_DB" != "ultralink" && "$CHECK_DB" != "ultralink_test" ]] || { echo "refusing to use database $CHECK_DB" >&2; exit 2; }

FAILS=0
ok() { echo "  OK    $*"; }
bad() { echo "  FAIL  $*"; FAILS=$((FAILS + 1)); }
psql_q() { psql -X -q -A -t -v ON_ERROR_STOP=1 "$@"; }

TMP="$(mktemp -d)"
cleanup() {
  rm -rf "$TMP"
  if [ "$KEEP_DB" = 0 ]; then psql_q -d "$ADMIN_DB" -c "DROP DATABASE IF EXISTS $CHECK_DB WITH (FORCE)" >/dev/null 2>&1 || true; fi
}
trap cleanup EXIT

echo "restore test: $(basename "$DUMP")"
# 1) integrity of the file itself
WANT_SHA="$(grep -oE '"sha256": "[0-9a-f]{64}"' "$MANIFEST" | grep -oE '[0-9a-f]{64}')"
GOT_SHA="$(sha256sum "$DUMP" | cut -d' ' -f1)"
if [ "$WANT_SHA" = "$GOT_SHA" ]; then ok "sha256 $GOT_SHA"; else bad "sha256 mismatch: manifest $WANT_SHA, file $GOT_SHA"; exit 1; fi

# 2) restore into a throw-away database
psql_q -d "$ADMIN_DB" -c "DROP DATABASE IF EXISTS $CHECK_DB WITH (FORCE)" >/dev/null
psql_q -d "$ADMIN_DB" -c "CREATE DATABASE $CHECK_DB TEMPLATE ultralink_template" >/dev/null
pg_restore --list "$DUMP" | grep -vE '^[0-9]+; [0-9]+ [0-9]+ (EXTENSION|COMMENT - EXTENSION) ' > "$TMP/toc.list"
T0=$(date +%s%N)
if pg_restore --no-owner --no-privileges --single-transaction --exit-on-error --use-list="$TMP/toc.list" -d "$CHECK_DB" "$DUMP" 2>"$TMP/restore.err"; then
  ok "pg_restore into $CHECK_DB ($(( ($(date +%s%N) - T0) / 1000000 )) ms, $(grep -vc '^;' "$TMP/toc.list") TOC entries)"
else
  bad "pg_restore failed: $(head -5 "$TMP/restore.err")"; exit 1
fi

# 3) verification against the manifest (all comparisons done in SQL; the manifest is passed as a variable)
REPORT="$(psql_q -d "$CHECK_DB" -v manifest="$(cat "$MANIFEST")" <<'SQL'
WITH m AS (SELECT :'manifest'::jsonb AS j),
mig AS (
  SELECT coalesce(jsonb_agg(jsonb_build_object('version', version, 'name', name, 'checksum', checksum) ORDER BY version), '[]') AS got,
         (SELECT j->'migrations' FROM m) AS want
    FROM schema_migrations),
actual AS (
  SELECT c.relname AS t,
         (xpath('/row/n/text()', query_to_xml(format('SELECT count(*) AS n FROM %I.%I', ns.nspname, c.relname), false, true, '')))[1]::text::bigint AS n
    FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
   WHERE ns.nspname = 'public' AND c.relkind = 'r'),
expected AS (SELECT key AS t, value::bigint AS n FROM m, jsonb_each_text((SELECT j->'row_counts' FROM m))),
diff AS (
  SELECT coalesce(e.t, a.t) AS t, e.n AS want, a.n AS got FROM expected e FULL JOIN actual a ON a.t = e.t
   WHERE e.n IS DISTINCT FROM a.n)
SELECT 'migrations|' || CASE WHEN got = want THEN 'ok|' || jsonb_array_length(got) || ' migration(s): ' || (SELECT string_agg(x->>'version', ',') FROM jsonb_array_elements(got) x)
                            ELSE 'fail|restored ' || got::text || ' manifest ' || want::text END FROM mig
UNION ALL
SELECT 'counts|' || CASE WHEN NOT EXISTS (SELECT 1 FROM diff)
                         THEN 'ok|' || (SELECT count(*) FROM actual) || ' tables, ' || (SELECT sum(n) FROM actual) || ' rows identical'
                         ELSE 'fail|' || (SELECT string_agg(t || ' want=' || coalesce(want::text, 'absent') || ' got=' || coalesce(got::text, 'absent'), '; ') FROM diff) END
SQL
)"
while IFS='|' read -r what status detail; do
  [ -n "$what" ] || continue
  if [ "$status" = ok ]; then ok "$what: $detail"; else bad "$what: $detail"; fi
done <<< "$REPORT"

# sample join intents→matches (+ refs) and orphan checks
JOIN_REPORT="$(psql_q -d "$CHECK_DB" <<'SQL'
SELECT (SELECT count(*) FROM matches)
     || '|' || (SELECT count(*) FROM (
          SELECT m.id FROM matches m
            JOIN intents a ON a.vertical_id = m.vertical_id AND a.id = m.a_intent_id
            JOIN intents b ON b.vertical_id = m.vertical_id AND b.id = m.b_intent_id
            JOIN match_refs r ON r.vertical_id = m.vertical_id AND r.match_id = m.id
            JOIN intent_refs ra ON ra.vertical_id = a.vertical_id AND ra.intent_id = a.id
           ORDER BY m.updated_at DESC LIMIT 100) s)
     || '|' || (SELECT count(*) FROM intent_refs r LEFT JOIN intents i ON i.vertical_id = r.vertical_id AND i.id = r.intent_id WHERE i.id IS NULL)
     || '|' || (SELECT count(*) FROM matches m WHERE NOT EXISTS (SELECT 1 FROM intents i WHERE i.vertical_id = m.vertical_id AND i.id = m.a_intent_id)
                                                OR NOT EXISTS (SELECT 1 FROM intents i WHERE i.vertical_id = m.vertical_id AND i.id = m.b_intent_id))
     || '|' || (SELECT count(*) FROM intent_scopes s LEFT JOIN intents i ON i.vertical_id = s.vertical_id AND i.id = s.intent_id WHERE i.id IS NULL)
     || '|' || (SELECT count(*) FROM pg_constraint WHERE contype = 'f' AND NOT convalidated);
SQL
)"
IFS='|' read -r N_MATCHES N_JOINED ORPH_REFS ORPH_MATCHES ORPH_SCOPES INVALID_FK <<< "$JOIN_REPORT"
EXPECT_JOINED=$(( N_MATCHES < 100 ? N_MATCHES : 100 ))
if [ "$N_JOINED" = "$EXPECT_JOINED" ]; then ok "sample join intents→matches→match_refs→intent_refs: $N_JOINED/$EXPECT_JOINED rows (of $N_MATCHES matches)"
else bad "sample join returned $N_JOINED rows, expected $EXPECT_JOINED"; fi
if [ "$ORPH_REFS$ORPH_MATCHES$ORPH_SCOPES$INVALID_FK" = "0000" ]; then ok "no orphan intent_refs/matches/intent_scopes, all foreign keys validated"
else bad "orphans: intent_refs=$ORPH_REFS matches=$ORPH_MATCHES intent_scopes=$ORPH_SCOPES invalid_fk=$INVALID_FK"; fi

if [ "$FAILS" = 0 ]; then
  echo "restore test PASSED ($(basename "$DUMP"))$([ "$KEEP_DB" = 1 ] && echo " — kept $CHECK_DB" || echo " — $CHECK_DB dropped")"
  exit 0
fi
echo "restore test FAILED: $FAILS check(s) failed" >&2
exit 1
