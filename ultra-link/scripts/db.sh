#!/usr/bin/env bash
# Dedicated local PostgreSQL cluster for Ultra Link.
# Lives entirely under ultra-link/var — never touches the system cluster or its data.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# PGBIN: Debian/Ubuntu default; on macOS use e.g. PGBIN="$(brew --prefix postgresql@16)/bin"
PGBIN="${PGBIN:-$( [ -x /usr/lib/postgresql/16/bin/postgres ] && echo /usr/lib/postgresql/16/bin || dirname "$(command -v postgres 2>/dev/null || echo /usr/lib/postgresql/16/bin/postgres)")}"
DATA="$ROOT/var/pgdata"
RUN="$ROOT/var/run"
LOG="$ROOT/var/log/postgres.log"
PORT="${UL_PG_PORT:-5544}"
ENV_FILE="$ROOT/.env"

as_pg() {
  # PostgreSQL refuses to run as root; use the postgres OS user when we are root.
  if [ "$(id -u)" = "0" ]; then runuser -u postgres -- "$@"; else "$@"; fi
}

ensure_dirs() {
  mkdir -p "$ROOT/var/log" "$RUN"
  if [ "$(id -u)" = "0" ]; then chown postgres:postgres "$ROOT/var" "$RUN" "$ROOT/var/log"; chmod 755 "$ROOT/var"; fi
  touch "$LOG"; [ "$(id -u)" = "0" ] && chown postgres:postgres "$LOG" || true
  # only when running as root (postgres runs as another OS user and must traverse the path to var/);
  # a normal user runs postgres as themselves, so no permission changes are made on their machine
  if [ "$(id -u)" = "0" ]; then local d="$ROOT"; while [ "$d" != "/" ]; do chmod o+x "$d" 2>/dev/null || true; d="$(dirname "$d")"; done; fi
}

init_cluster() {
  ensure_dirs
  if [ ! -f "$DATA/PG_VERSION" ]; then
    echo "→ initdb $DATA"
    mkdir -p "$DATA"; [ "$(id -u)" = "0" ] && chown postgres:postgres "$DATA"
    as_pg "$PGBIN/initdb" -D "$DATA" -E UTF8 --locale=C -U postgres --auth-local=peer --auth-host=scram-sha-256 >/dev/null
    cat >> "$DATA/postgresql.conf" <<CONF
# --- ultra-link local settings ---
listen_addresses = '127.0.0.1'
port = $PORT
unix_socket_directories = '$RUN'
shared_preload_libraries = 'pg_stat_statements'
pg_stat_statements.track = all
shared_buffers = 512MB
work_mem = 16MB
maintenance_work_mem = 256MB
effective_cache_size = 4GB
random_page_cost = 1.1
max_connections = 100
log_min_duration_statement = 500
CONF
  fi
}

start() {
  init_cluster
  if as_pg "$PGBIN/pg_ctl" -D "$DATA" status >/dev/null 2>&1; then echo "postgres already running on :$PORT"; else
    as_pg "$PGBIN/pg_ctl" -D "$DATA" -l "$LOG" -w -t 30 start >/dev/null && echo "postgres started on 127.0.0.1:$PORT"
  fi
  provision
}

psql_admin() { PGOPTIONS="-c client_min_messages=warning" as_pg "$PGBIN/psql" -h "$RUN" -p "$PORT" -U postgres -v ON_ERROR_STOP=1 -qAt "$@"; }

provision() {
  # Create app role + databases once; password is generated locally and stored only in .env (git-ignored).
  touch "$ENV_FILE"; chmod 600 "$ENV_FILE"
  if ! grep -q '^DATABASE_URL=' "$ENV_FILE"; then
    local pw; pw="$(head -c 24 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 32)"
    psql_admin -d postgres -c "DO \$\$BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='ultralink') THEN CREATE ROLE ultralink LOGIN; END IF; END\$\$;"
    psql_admin -d postgres -c "ALTER ROLE ultralink PASSWORD '$pw';"
    {
      echo "DATABASE_URL=postgres://ultralink:$pw@127.0.0.1:$PORT/ultralink"
      echo "TEST_DATABASE_URL=postgres://ultralink:$pw@127.0.0.1:$PORT/ultralink_test"
      echo "DATABASE_ADMIN_URL=postgres://ultralink:$pw@127.0.0.1:$PORT/postgres"
    } >> "$ENV_FILE"
  fi
  for db in ultralink ultralink_test; do
    if [ -z "$(psql_admin -d postgres -c "SELECT 1 FROM pg_database WHERE datname='$db'")" ]; then
      psql_admin -d postgres -c "CREATE DATABASE $db OWNER ultralink;"
      echo "created database $db"
    fi
    # Extensions need superuser; create them here so migrations can rely on them.
    psql_admin -d "$db" -c "CREATE EXTENSION IF NOT EXISTS btree_gist; CREATE EXTENSION IF NOT EXISTS pg_trgm; CREATE EXTENSION IF NOT EXISTS pg_stat_statements; CREATE EXTENSION IF NOT EXISTS pgcrypto;"
  done
  psql_admin -d postgres -c "ALTER ROLE ultralink CREATEDB;" # needed by restore-test and per-test databases
  # template with extensions pre-installed (extensions need superuser); tests clone it
  if [ -z "$(psql_admin -d postgres -c "SELECT 1 FROM pg_database WHERE datname='ultralink_template'")" ]; then
    psql_admin -d postgres -c "CREATE DATABASE ultralink_template OWNER ultralink;"
    psql_admin -d ultralink_template -c "CREATE EXTENSION IF NOT EXISTS btree_gist; CREATE EXTENSION IF NOT EXISTS pg_trgm; CREATE EXTENSION IF NOT EXISTS pgcrypto; CREATE EXTENSION IF NOT EXISTS pg_stat_statements;"
    psql_admin -d postgres -c "UPDATE pg_database SET datistemplate = true WHERE datname = 'ultralink_template';"
    echo "created template database ultralink_template"
  fi
}

stop() {
  if as_pg "$PGBIN/pg_ctl" -D "$DATA" status >/dev/null 2>&1; then as_pg "$PGBIN/pg_ctl" -D "$DATA" -m fast -w stop >/dev/null && echo "postgres stopped"; else echo "postgres not running"; fi
}

status() {
  if [ -f "$DATA/PG_VERSION" ] && as_pg "$PGBIN/pg_ctl" -D "$DATA" status >/dev/null 2>&1; then echo "postgres: running (127.0.0.1:$PORT, data=$DATA)"; else echo "postgres: stopped"; fi
}

case "${1:-status}" in
  start) start ;; stop) stop ;; status) status ;; provision) provision ;;
  psql) shift; psql_admin "$@" ;;
  *) echo "usage: db.sh start|stop|status|psql"; exit 1 ;;
esac
