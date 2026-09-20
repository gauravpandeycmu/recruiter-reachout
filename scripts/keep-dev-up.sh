#!/bin/bash
set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LOG="/tmp/rr-keep-dev-up.log"
API_PID_FILE="/tmp/rr-api-dev.pid"
WEB_PID_FILE="/tmp/rr-web-dev.pid"
WATCHDOG_PID_FILE="/tmp/rr-watchdog.pid"
CHECK_SECONDS=5
FAILURES_BEFORE_RESTART=3

cd "$ROOT" || exit 1

existing_watchdog="$(tr -dc '0-9' <"$WATCHDOG_PID_FILE" 2>/dev/null || true)"
if [[ -n "$existing_watchdog" ]] && [[ "$existing_watchdog" != "$$" ]] && kill -0 "$existing_watchdog" 2>/dev/null; then
  exit 0
fi
echo "$$" >"$WATCHDOG_PID_FILE"

log() {
  echo "[$(date)] $*" >>"$LOG"
}

api_ok() {
  curl -sf -o /dev/null --max-time 2 http://127.0.0.1:4000/api/state
}

web_ok() {
  curl -sf -o /dev/null --max-time 2 http://127.0.0.1:3000/
}

stop_recorded_process() {
  local pid_file="$1"
  if [[ ! -f "$pid_file" ]]; then
    return
  fi
  local pid
  pid="$(tr -dc '0-9' <"$pid_file")"
  if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
    pkill -TERM -P "$pid" 2>/dev/null || true
    kill -TERM "$pid" 2>/dev/null || true
  fi
  rm -f "$pid_file"
}

start_api() {
  stop_recorded_process "$API_PID_FILE"
  log "starting API (watch mode)"
  nohup npm run dev -w @recruiter/api >>"$LOG" 2>&1 </dev/null &
  echo "$!" >"$API_PID_FILE"
}

start_web() {
  stop_recorded_process "$WEB_PID_FILE"
  log "starting web app"
  nohup npm run dev -w @recruiter/web >>"$LOG" 2>&1 </dev/null &
  echo "$!" >"$WEB_PID_FILE"
}

log "watchdog starting"
api_ok || start_api
web_ok || start_web

api_failures=0
web_failures=0

while true; do
  if api_ok; then
    api_failures=0
  else
    api_failures=$((api_failures + 1))
    if (( api_failures >= FAILURES_BEFORE_RESTART )); then
      log "API remained unavailable for $((CHECK_SECONDS * FAILURES_BEFORE_RESTART))s; restarting it"
      start_api
      api_failures=0
    fi
  fi

  if web_ok; then
    web_failures=0
  else
    web_failures=$((web_failures + 1))
    if (( web_failures >= FAILURES_BEFORE_RESTART )); then
      log "web app remained unavailable for $((CHECK_SECONDS * FAILURES_BEFORE_RESTART))s; restarting it"
      start_web
      web_failures=0
    fi
  fi

  sleep "$CHECK_SECONDS"
done
