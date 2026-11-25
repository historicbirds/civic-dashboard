#!/bin/sh
# Run as the Pi desktop user; supply the observed CI-FLT01 Bluetooth address.
set -eu
CONTROLLER_ADDRESS="${1:-}"
python3 - "$CONTROLLER_ADDRESS" <<'PY'
import re,sys
if not re.fullmatch(r'(?:[0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}',sys.argv[1]):
    raise SystemExit('Usage: sh scripts/enable-lighting.sh AA:BB:CC:DD:EE:FF')
PY
"$HOME/civic-dashboard/.venv/bin/python" -m pip install -r "$HOME/civic-dashboard/requirements.txt"
mkdir -p "$HOME/.config/systemd/user/civic-dashboard.service.d"
cat > "$HOME/.config/systemd/user/civic-dashboard.service.d/lighting.conf" <<EOF
[Service]
Environment=CIVIC_LIGHTS_ENABLED=1
Environment=CIVIC_LIGHTS_ADDRESS=$CONTROLLER_ADDRESS
EOF
systemctl --user daemon-reload
systemctl --user restart civic-dashboard.service
printf '%s\n' 'Lighting enabled. Open Lights on the dashboard.'
