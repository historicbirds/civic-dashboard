#!/bin/sh
# Run as the Pi desktop user. Uses official distro audio tools; no OS reset.
set -eu
tools="$HOME/.local/share/civic-audio-tools"
export PATH="$tools/usr/bin:$PATH"
if ! command -v pactl >/dev/null 2>&1 || ! command -v parec >/dev/null 2>&1; then
    mkdir -p "$tools/packages"
    (
        cd "$tools/packages"
        apt-get download pulseaudio-utils
        for package in pulseaudio-utils*.deb; do dpkg-deb -x "$package" "$tools"; done
    )
fi
export PATH="$tools/usr/bin:$PATH"
pactl info >/dev/null
parec --version >/dev/null
mkdir -p "$HOME/.config/systemd/user/civic-dashboard.service.d"
cat > "$HOME/.config/systemd/user/civic-dashboard.service.d/bluetooth.conf" <<EOF
[Service]
Environment=CIVIC_BLUETOOTH=1
Environment=CIVIC_HDMI_UNITY=1
Environment=PATH=$tools/usr/bin:/usr/local/bin:/usr/bin:/bin
EOF
systemctl --user daemon-reload
systemctl --user restart civic-dashboard.service
printf '%s\n' 'Bluetooth bridge enabled. Open Phone audio and select Use Bluetooth.'
