#!/usr/bin/env bash
# Logical backup of the app database `ultralink` (pg_dump custom format) + a manifest that a restore test
# can verify against.
#
#   bash scripts/backup.sh [--keep N] [--dir DIR]          (npm run db:backup)
#
# Output: backups/ultralink-YYYYmmdd-HHMMSS.dump  and  backups/ultralink-YYYYmmdd-HHMMSS.json
# Manifest: schema_migrations (version/name/checksum), EXACT row counts per table, sha256 + size of the dump.
#
# Consistency: the dump and the row counts come from ONE exported snapshot (REPEATABLE READ READ ONLY
# transaction held open by a psql coprocess while pg_dump runs with --snapshot), so the counts match the
# dump exactly even while the app and worker keep writing. Read-only: nothing in the database is changed.
# Retention: the newest N backups are kept (default 7, env UL_BACKUP_KEEP); older dump+manifest pairs are deleted.
# Credentials are read from .env (DATABASE_URL, or UL_BACKUP_URL if set) and passed to libpq through
# environment variables, never on the command line.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
KEEP="${UL_BACKUP_KEEP:-7}"
DIR="$ROOT/backups"
while [ $# -gt 0 ]; do
  case "$1" in
    --keep) KEEP="$2"; shift 2 ;;
    --dir) DIR="$2"; shift 2 ;;
    -h|--help) sed -n '2,16p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
[[ "$KEEP" =~ ^[1-9][0-9]*$ ]] || { echo "--keep must be a positive integer" >&2; exit 2; }

env_get() { [ -f "$ROOT/.env" ] && grep -E "^$1=" "$ROOT/.env" | tail -1 | cut -d= -f2- | sed -e "s/^['\"]//" -e "s/['\"]$//" || true; }
URL="${UL_BACKUP_URL:-${DATABASE_URL:-$(env_get DATABASE_URL)}}"
[ -n "$URL" ] || { echo "DATABASE_URL not found (.env)" >&2; exit 1; }

# postgres://user:password@host:port/dbname  →  libpq environment
url_to_env() {
  local re='^postgres(ql)?://([^:@/]+)(:([^@]*))?@([^:/?]+)(:([0-9]+))?/([^?]+)'
  [[ "$1" =~ $re ]] || { echo "cannot parse database URL" >&2; exit 1; }
  export PGUSER="${BASH_REMATCH[2]}" PGPASSWORD="$(printf '%b' "${BASH_REMATCH[4]//%/\\x}")" PGHOST="${BASH_REMATCH[5]}" \
    PGPORT="${BASH_REMATCH[7]:-5432}" PGDATABASE="${BASH_REMATCH[8]}"
}
url_to_env "$URL"
DB_NAME="$PGDATABASE"

mkdir -p "$DIR"
chmod 700 "$DIR"
STAMP="$(date -u +%Y%m%d-%H%M%S)"
BASE="$DIR/${DB_NAME}-$STAMP"
DUMP="$BASE.dump"
MANIFEST="$BASE.json"
[ -e "$DUMP" ] && { echo "backup $DUMP already exists" >&2; exit 1; }
PARTIAL="$DUMP.partial"
cleanup() { rm -f "$PARTIAL" "$MANIFEST.partial"; [ -n "${UL_PSQL_PID:-}" ] && kill "$UL_PSQL_PID" 2>/dev/null || true; }
trap cleanup EXIT

# ── hold one snapshot open in a psql coprocess
coproc PSQL { exec psql -X -q -A -t -v ON_ERROR_STOP=1 2>&1; }
UL_PSQL_PID=$PSQL_PID
MARK="__UL_BACKUP_END_$$__"
Q_OUT=""
q() { # q SQL → output lines in $Q_OUT (no subshell: coproc fds are not inherited by $(...)); fails if psql died
  printf '%s\n\\echo %s\n' "$1" "$MARK" >&"${PSQL[1]}"
  local line seen=0
  Q_OUT=""
  while IFS= read -r line <&"${PSQL[0]}"; do
    if [ "$line" = "$MARK" ]; then seen=1; break; fi
    Q_OUT+="$line"$'\n'
  done
  [ "$seen" = 1 ] || { echo "psql failed: $Q_OUT" >&2; exit 1; }
}

q "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY; SELECT pg_export_snapshot();"
SNAP="$(printf '%s' "$Q_OUT" | tail -1)"
[[ "$SNAP" =~ ^[0-9A-F-]+$ ]] || { echo "could not export snapshot: $SNAP" >&2; exit 1; }

T0=$(date +%s%N)
pg_dump --format=custom --compress=6 --snapshot="$SNAP" --no-password --file="$PARTIAL" "$DB_NAME"
DUMP_MS=$(( ($(date +%s%N) - T0) / 1000000 ))
pg_restore --list "$PARTIAL" >/dev/null   # the archive's TOC must be readable

SHA="$(sha256sum "$PARTIAL" | cut -d' ' -f1)"
SIZE="$(stat -c %s "$PARTIAL")"
PG_DUMP_VERSION="$(pg_dump --version | sed 's/^pg_dump (PostgreSQL) //')"

# manifest built inside the SAME snapshot (exact counts of every ordinary table and partition)
q "\\set ul_file '$(basename "$DUMP")'"
q "\\set ul_sha '$SHA'"
q "\\set ul_size '$SIZE'"
q "\\set ul_snap '$SNAP'"
q "\\set ul_dump_ver '$PG_DUMP_VERSION'"
q "\\set ul_dump_ms '$DUMP_MS'"
q "WITH counts AS (
  SELECT c.relname AS t,
         (xpath('/row/n/text()', query_to_xml(format('SELECT count(*) AS n FROM %I.%I', ns.nspname, c.relname), false, true, '')))[1]::text::bigint AS n
    FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
   WHERE ns.nspname = 'public' AND c.relkind = 'r')
SELECT jsonb_pretty(jsonb_build_object(
  'format', 'ultralink-backup/1',
  'database', current_database(),
  'file', :'ul_file',
  'sha256', :'ul_sha',
  'size_bytes', (:'ul_size')::bigint,
  'created_at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"'),
  'snapshot', :'ul_snap',
  'dump_ms', (:'ul_dump_ms')::int,
  'server_version', current_setting('server_version'),
  'pg_dump_version', :'ul_dump_ver',
  'migrations', (SELECT coalesce(jsonb_agg(jsonb_build_object('version', version, 'name', name, 'checksum', checksum) ORDER BY version), '[]') FROM schema_migrations),
  'total_rows', (SELECT coalesce(sum(n), 0) FROM counts),
  'row_counts', (SELECT coalesce(jsonb_object_agg(t, n), '{}') FROM counts)
));"
printf '%s' "$Q_OUT" > "$MANIFEST.partial"
q "COMMIT;"
exec {PSQL[1]}>&-
wait "$UL_PSQL_PID" 2>/dev/null || true
UL_PSQL_PID=""

mv "$PARTIAL" "$DUMP"
mv "$MANIFEST.partial" "$MANIFEST"
chmod 600 "$DUMP" "$MANIFEST"

# ── retention: keep the newest $KEEP dumps (names sort chronologically)
mapfile -t ALL < <(ls -1 "$DIR"/"$DB_NAME"-*.dump 2>/dev/null | sort)
REMOVED=0
if [ "${#ALL[@]}" -gt "$KEEP" ]; then
  for old in "${ALL[@]:0:${#ALL[@]}-KEEP}"; do rm -f "$old" "${old%.dump}.json"; REMOVED=$((REMOVED + 1)); done
fi

TOTAL_ROWS="$(grep -oE '"total_rows": [0-9]+' "$MANIFEST" | grep -oE '[0-9]+$')"
echo "backup ok: $DUMP"
echo "  size:      $SIZE bytes ($(( (SIZE + 1023) / 1024 )) KiB), pg_dump ${DUMP_MS} ms, snapshot $SNAP"
echo "  sha256:    $SHA"
echo "  manifest:  $MANIFEST ($(grep -c '"version"' "$MANIFEST") migrations, $TOTAL_ROWS rows counted exactly)"
echo "  retention: keep $KEEP, removed $REMOVED old backup(s), $(ls -1 "$DIR"/"$DB_NAME"-*.dump | wc -l) on disk"
