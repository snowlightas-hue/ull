#!/usr/bin/env bash
# Start/stop/restart Ultra Link locally: PostgreSQL (dedicated cluster) + API server + background worker.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RUN="$ROOT/var/run"; LOGS="$ROOT/var/log"
mkdir -p "$RUN" "$LOGS"
PORT="${PORT:-8080}"

is_running() { [ -f "$1" ] && kill -0 "$(cat "$1")" 2>/dev/null; }

start_proc() { # name, script
  local name="$1" script="$2" pidf="$RUN/$1.pid"
  if is_running "$pidf"; then echo "$name already running (pid $(cat "$pidf"))"; return; fi
  rm -f "$pidf"
  # the node process writes its own pid (UL_PIDFILE) so stop/status always target the real process
  cd "$ROOT"
  UL_PIDFILE="$pidf" NODE_USE_ENV_PROXY=1 PORT="$PORT" nohup setsid node "$script" >> "$LOGS/$name.log" 2>&1 < /dev/null &
  disown || true
  for _ in $(seq 1 40); do [ -s "$pidf" ] && break; sleep 0.1; done
  if is_running "$pidf"; then echo "$name started (pid $(cat "$pidf"), log var/log/$name.log)"; else echo "$name FAILED to start — see var/log/$name.log"; tail -20 "$LOGS/$name.log"; exit 1; fi
}

stop_proc() {
  local name="$1" pidf="$RUN/$1.pid"
  if is_running "$pidf"; then
    kill "$(cat "$pidf")"; for _ in $(seq 1 50); do is_running "$pidf" || break; sleep 0.1; done
    is_running "$pidf" && kill -9 "$(cat "$pidf")" || true
    echo "$name stopped"
  else echo "$name not running"; fi
  rm -f "$pidf"
}

wait_health() {
  for _ in $(seq 1 60); do
    if curl -sf "http://127.0.0.1:$PORT/api/health" >/dev/null; then echo "ready → http://127.0.0.1:$PORT"; return 0; fi
    sleep 0.25
  done
  echo "server did not become healthy — see var/log/server.log"; return 1
}

case "${1:-status}" in
  start)
    bash "$ROOT/scripts/db.sh" start
    ( cd "$ROOT" && node src/db/migrate.ts )
    if [ "$(bash "$ROOT/scripts/db.sh" psql -d ultralink -c "SELECT count(*) FROM categories")" = "0" ]; then ( cd "$ROOT" && node src/seed/seed.ts ); fi
    start_proc server src/server/main.ts
    start_proc worker src/worker/main.ts
    wait_health ;;
  stop)
    stop_proc worker; stop_proc server
    [ "${2:-}" = "--all" ] && bash "$ROOT/scripts/db.sh" stop || true ;;
  restart)
    stop_proc worker; stop_proc server
    start_proc server src/server/main.ts; start_proc worker src/worker/main.ts; wait_health ;;
  status)
    bash "$ROOT/scripts/db.sh" status
    for n in server worker; do if is_running "$RUN/$n.pid"; then echo "$n: running (pid $(cat "$RUN/$n.pid"))"; else echo "$n: stopped"; fi; done
    curl -s "http://127.0.0.1:$PORT/api/health" && echo || true ;;
  *) echo "usage: app.sh start|stop [--all]|restart|status"; exit 1 ;;
esac
