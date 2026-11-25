#!/bin/sh
set -eu
# Run this inside the Pi's graphical desktop session, after the Flask service starts.
DASHBOARD_URL="${CIVIC_URL:-http://127.0.0.1:5000}"
export DASHBOARD_URL
python3 - <<'PY'
import os
import time
import urllib.request
for attempt in range(60):
    try:
        with urllib.request.urlopen(os.environ['DASHBOARD_URL'], timeout=2) as response:
            if response.status == 200:
                break
    except OSError:
        time.sleep(1)
else:
    raise SystemExit('Civic dashboard did not become ready within 60 attempts.')
PY
if command -v chromium >/dev/null 2>&1; then
    BROWSER_BIN=chromium
elif command -v chromium-browser >/dev/null 2>&1; then
    BROWSER_BIN=chromium-browser
else
    echo 'Install Chromium before starting the kiosk.' >&2
    exit 1
fi
if [ -n "${WAYLAND_DISPLAY:-}" ]; then
    set -- --ozone-platform=wayland
else
    set --
fi
# Retain this Pi's existing kiosk password-store setting.
exec "$BROWSER_BIN" "$@" --kiosk --password-store=basic --no-first-run --no-default-browser-check --disable-session-crashed-bubble --autoplay-policy=no-user-gesture-required "$DASHBOARD_URL"
