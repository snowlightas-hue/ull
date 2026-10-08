#!/usr/bin/env bash
# Start/stop/restart Ultra Link locally: PostgreSQL (dedicated cluster) + API server + background worker.
#
#   app.sh start | stop [--all] | restart | status | logs [server|worker|postgres|all] [-f] [-n N]
#
# Safety: this script only ever signals processes it started. A pid counts as ours when the process
# carries our UL_PIDFILE in its environment (Linux /proc) or, without /proc, when its command line is
# `node … <our entry script>` running from this checkout. Anything else is a stale pidfile: it is removed
# and the foreign process is left alone. `stop --all` also stops the dedicated PostgreSQL cluster.
#
# Env: PORT (8080), HOST (127.0.0.1), UL_DATABASE_URL (default DATABASE_URL from .env),
#      UL_RUN_DIR / UL_LOG_DIR (default var/run, var/log — set both to run a second, independent instance),
#      UL_STOP_WAIT_S (15: graceful drain before SIGKILL).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RUN="${UL_RUN_DIR:-$ROOT/var/run}"; LOGS="${UL_LOG_DIR:-$ROOT/var/log}"
mkdir -p "$RUN" "$LOGS"
RUN="$(cd "$RUN" && pwd)"; LOGS="$(cd "$LOGS" && pwd)"
PORT="${PORT:-8080}"; HOST="${HOST:-127.0.0.1}"
STOP_WAIT_S="${UL_STOP_WAIT_S:-15}"

script_of() { case "$1" in server) echo src/server/main.ts ;; worker) echo src/worker/main.ts ;; *) return 1 ;; esac; }

# ours NAME PID → 0 when PID is alive and is the NAME process this script started
ours() {
  local name="$1" pid="$2" pidf="$RUN/$1.pid" script cmd cwd
  script="$(script_of "$name")"
  kill -0 "$pid" 2>/dev/null || return 1
  if [ -r "/proc/$pid/environ" ]; then
    grep -qxF "UL_PIDFILE=$pidf" < <(tr '\0' '\n' < "/proc/$pid/environ" 2>/dev/null)
    return
  fi
  cmd="$(ps -o command= -p "$pid" 2>/dev/null || true)"
  case "$cmd" in *node*"$script"*) ;; *) return 1 ;; esac
  if command -v lsof >/dev/null 2>&1; then
    cwd="$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -1)"
    [ -z "$cwd" ] || [ "$cwd" = "$ROOT" ] || return 1
  fi
}

# live_pid NAME → prints the pid when NAME runs; removes a stale pidfile (never signals anything)
live_pid() {
  local name="$1" f="$RUN/$1.pid" pid
  [ -f "$f" ] || return 1
  pid="$(tr -dc '0-9' 2>/dev/null < "$f" || true)"
  if [ -n "$pid" ] && ours "$name" "$pid"; then echo "$pid"; return 0; fi
  rm -f "$f"
  echo "note: removed stale $name pidfile (pid ${pid:-?} is not a $name started by app.sh; left untouched)" >&2
  return 1
}

port_busy() { (exec 3<>"/dev/tcp/$HOST/$1") 2>/dev/null; }

# port_owner PORT → "pid N: command" for each listener (best effort; empty when not identifiable)
port_owner() {
  local port="$1" pids="" p
  if command -v lsof >/dev/null 2>&1; then pids="$(lsof -nP -t -iTCP:"$port" -sTCP:LISTEN 2>/dev/null | sort -u || true)"; fi
  if [ -z "$pids" ] && command -v ss >/dev/null 2>&1; then pids="$(ss -ltnpH "sport = :$port" 2>/dev/null | grep -o 'pid=[0-9]*' | cut -d= -f2 | sort -u || true)"; fi
  if [ -z "$pids" ] && command -v fuser >/dev/null 2>&1; then pids="$(fuser -n tcp "$port" 2>/dev/null | tr -s ' ' '\n' | grep -E '^[0-9]+$' | sort -u || true)"; fi
  for p in $pids; do echo "pid $p: $(ps -o args= -p "$p" 2>/dev/null | cut -c1-100)"; done
}

start_proc() { # NAME
  local name="$1" script pidf="$RUN/$1.pid" pid owner
  script="$(script_of "$name")"
  if pid="$(live_pid "$name")"; then echo "$name already running (pid $pid)"; return 0; fi
  if [ "$name" = server ] && port_busy "$PORT"; then
    owner="$(port_owner "$PORT")"
    echo "port $PORT is already in use by ${owner:-a process this user cannot identify} — server not started (use PORT=<free port>)" >&2
    return 1
  fi
  local launcher=(nohup); command -v setsid >/dev/null 2>&1 && launcher=(nohup setsid)
  # the node process writes its own pid (UL_PIDFILE) so stop/status always target the real process.
  # All fds are redirected for the whole background subshell, and `exec` leaves no shell in between, so
  # nothing keeps the caller's stdout/stderr pipe open (e.g. `app.sh start | tee`, CI, test runners).
  ( cd "$ROOT" && UL_PIDFILE="$pidf" NODE_USE_ENV_PROXY=1 PORT="$PORT" HOST="$HOST" exec "${launcher[@]}" node "$script" ) >> "$LOGS/$name.log" 2>&1 < /dev/null &
  disown 2>/dev/null || true
  for _ in $(seq 1 50); do [ -s "$pidf" ] && break; sleep 0.1; done
  sleep 0.3
  if pid="$(live_pid "$name" 2>/dev/null)"; then echo "$name started (pid $pid, log $LOGS/$name.log)"; return 0; fi
  echo "$name FAILED to start — last lines of $LOGS/$name.log:" >&2
  tail -n 20 "$LOGS/$name.log" >&2
  return 1
}

stop_proc() { # NAME
  local name="$1" pid i
  if ! pid="$(live_pid "$name")"; then echo "$name not running"; return 0; fi
  kill -TERM "$pid" 2>/dev/null || true
  for ((i = 0; i < STOP_WAIT_S * 10; i++)); do kill -0 "$pid" 2>/dev/null || break; sleep 0.1; done
  if kill -0 "$pid" 2>/dev/null && ours "$name" "$pid"; then
    echo "$name did not stop within ${STOP_WAIT_S}s → SIGKILL" >&2
    kill -KILL "$pid" 2>/dev/null || true
  fi
  # the process removes its own pidfile; only clear it if it still names this pid
  [ "$(tr -dc '0-9' 2>/dev/null < "$RUN/$name.pid" || true)" = "$pid" ] && rm -f "$RUN/$name.pid"
  echo "$name stopped (pid $pid)"
}

wait_health() {
  local code
  for _ in $(seq 1 120); do
    code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 "http://$HOST:$PORT/api/health" || true)"
    if [ "$code" = 200 ]; then echo "ready → http://$HOST:$PORT"; return 0; fi
    live_pid server >/dev/null 2>&1 || break
    sleep 0.25
  done
  echo "server did not become healthy (last status ${code:-none}) — last lines of $LOGS/server.log:" >&2
  tail -n 20 "$LOGS/server.log" >&2
  return 1
}

db_url() {
  if [ -n "${UL_DATABASE_URL:-}" ]; then echo "$UL_DATABASE_URL"; return; fi
  if [ -n "${DATABASE_URL:-}" ]; then echo "$DATABASE_URL"; return; fi
  grep -m1 '^DATABASE_URL=' "$ROOT/.env" 2>/dev/null | cut -d= -f2- | tr -d "\"'"
}

prepare_db() {
  bash "$ROOT/scripts/db.sh" start
  local url name
  url="$(db_url)"; [ -n "$url" ] || { echo "DATABASE_URL is not set (.env missing?)" >&2; return 1; }
  name="${url##*/}"; name="${name%%\?*}"
  # migrate/seed the same database the server will use (loadEnv never overrides an exported variable)
  ( cd "$ROOT" && DATABASE_URL="$url" node src/db/migrate.ts )
  if [ "$(bash "$ROOT/scripts/db.sh" psql -d "$name" -c "SELECT count(*) FROM categories")" = "0" ]; then ( cd "$ROOT" && DATABASE_URL="$url" node src/seed/seed.ts ); fi
}

show_logs() {
  local which=all follow=0 n=40 files=() f
  while [ $# -gt 0 ]; do
    case "$1" in
      server|worker|postgres|all) which="$1" ;;
      -f|--follow) follow=1 ;;
      -n) shift; n="${1:-40}" ;;
      -n*) n="${1#-n}" ;;
      *) echo "usage: app.sh logs [server|worker|postgres|all] [-f] [-n N]" >&2; return 1 ;;
    esac
    shift
  done
  case "$which" in
    all) files=("$LOGS/server.log" "$LOGS/worker.log") ;;
    postgres) files=("$ROOT/var/log/postgres.log") ;;
    *) files=("$LOGS/$which.log") ;;
  esac
  for f in "${files[@]}"; do [ -f "$f" ] || echo "(no log yet: $f)" >&2; done
  local existing=(); for f in "${files[@]}"; do [ -f "$f" ] && existing+=("$f"); done
  [ ${#existing[@]} -gt 0 ] || return 0
  if [ "$follow" = 1 ]; then exec tail -n "$n" -F "${existing[@]}"; else tail -n "$n" "${existing[@]}"; fi
}

status() {
  local n pid owner
  bash "$ROOT/scripts/db.sh" status
  for n in server worker; do
    if pid="$(live_pid "$n")"; then echo "$n: running (pid $pid)"; else echo "$n: stopped"; fi
  done
  if ! live_pid server >/dev/null 2>&1 && port_busy "$PORT"; then
    owner="$(port_owner "$PORT")"
    echo "note: port $PORT is in use by ${owner:-another process} (not started by app.sh)"
  fi
  curl -s --max-time 3 "http://$HOST:$PORT/api/health" && echo || true
}

case "${1:-status}" in
  start)
    prepare_db
    start_proc server
    start_proc worker
    wait_health ;;
  stop)
    stop_proc worker; stop_proc server
    if [ "${2:-}" = "--all" ]; then bash "$ROOT/scripts/db.sh" stop; fi ;;
  restart)
    stop_proc worker; stop_proc server
    start_proc server; start_proc worker; wait_health ;;
  status) status ;;
  logs) shift; show_logs "$@" ;;
  *) echo "usage: app.sh start | stop [--all] | restart | status | logs [server|worker|postgres|all] [-f] [-n N]" >&2; exit 1 ;;
esac
