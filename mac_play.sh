#!/bin/sh
# ---------------------------------------------------------------------------
#  Rapfi Gomoku launcher. Named for the Mac because that is what it is tested
#  on, but the Linux paths are here too. Windows has windows_play.bat.
#
#    ./mac_play.sh            start the bridge and open the board in a Chrome tab
#    ./mac_play.sh stop       stop a running bridge
#    ./mac_play.sh rescan     forget the cached CPU build and probe again
#    ./mac_play.sh chrome     show which Chrome would be used, without opening it
# ---------------------------------------------------------------------------
set -u
cd "$(dirname "$0")"

PORT="${PORT:-8787}"
URL="http://127.0.0.1:$PORT"

# The macOS entry is the app bundle rather than the binary inside it, so that
# `open -a` can hand the URL to the copy of Chrome that is already running.
find_chrome() {
  CHROME=""
  for c in \
    "/Applications/Google Chrome.app" \
    "$HOME/Applications/Google Chrome.app" \
    "/opt/google/chrome/chrome"
  do
    [ -e "$c" ] && { CHROME="$c"; return 0; }
  done
  for c in google-chrome google-chrome-stable chromium chromium-browser; do
    p=$(command -v "$c" 2>/dev/null) && { CHROME="$p"; return 0; }
  done
  return 0
}

# The board opens as an ordinary tab in the browser you are already using, with
# your own profile, extensions and bookmarks: Chrome hands a plain URL to the
# instance that is running rather than starting a second one.
open_chrome() {
  find_chrome
  if [ -z "$CHROME" ]; then
    if command -v open >/dev/null 2>&1; then
      echo "Chrome was not found - opening your default browser instead."
      open "$URL"
    elif command -v xdg-open >/dev/null 2>&1; then
      echo "Chrome was not found - opening your default browser instead."
      xdg-open "$URL" >/dev/null 2>&1 &
    else
      echo "No browser launcher found. Open $URL yourself."
    fi
  elif [ "${CHROME%.app}" != "$CHROME" ]; then
    open -a "$CHROME" "$URL"
  else
    "$CHROME" "$URL" >/dev/null 2>&1 &
  fi
}

is_running() {
  curl -s -o /dev/null --max-time 2 "$URL/api/status"
}

case "${1:-}" in
  stop)
    PIDS=$(lsof -ti "tcp:$PORT" -sTCP:LISTEN 2>/dev/null)
    if [ -n "$PIDS" ]; then
      echo "$PIDS" | xargs kill 2>/dev/null
      echo "Stopped the bridge on port $PORT."
    else
      echo "Nothing was listening on port $PORT."
    fi
    exit 0
    ;;
  rescan)
    if [ -f engine/selected-build.json ]; then
      rm -f engine/selected-build.json
      echo "Cleared the cached build choice - the next start will probe again."
    else
      echo "No cached build choice to clear."
    fi
    exit 0
    ;;
  chrome)
    find_chrome
    if [ -n "$CHROME" ]; then
      echo "Chrome:  $CHROME"
    else
      echo "Chrome was not found. The launcher would use your default browser."
    fi
    echo "URL:     $URL"
    exit 0
    ;;
  ""|start) ;;
  *)
    echo "Usage:"
    echo "  ./mac_play.sh            start the bridge and open the board in a Chrome tab"
    echo "  ./mac_play.sh stop       stop a running bridge"
    echo "  ./mac_play.sh rescan     forget the cached CPU build and probe again"
    echo "  ./mac_play.sh chrome     show which Chrome would be used, without opening it"
    exit 0
    ;;
esac

# --------------------------------------------------------------------- start

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is required to run the Rapfi bridge."
  echo "Install it from https://nodejs.org (or: brew install node) and run this again."
  exit 1
fi

if [ ! -f server.js ]; then
  echo "server.js is missing - run this from the gomoku folder."
  exit 1
fi

if is_running; then
  echo "Bridge is already running on $URL"
  open_chrome
  exit 0
fi

echo "Rapfi Gomoku"
echo "  serving $URL   (press Ctrl+C to stop)"
echo

# Open the browser from a background copy of the wait loop, once the port
# answers, so the server itself stays in the foreground and owns Ctrl+C.
(
  i=0
  while [ $i -lt 90 ]; do
    is_running && { open_chrome; exit 0; }
    sleep 1
    i=$((i + 1))
  done
  echo
  echo "Gave up waiting for $URL to answer."
) &

exec node server.js
