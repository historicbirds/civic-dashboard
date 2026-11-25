# Civic sound studio

Local infotainment dashboard for a **2011 Honda Civic EX two-door coupe · R18 / 5MT**, a Raspberry Pi 4, and the Kenwood DMX8710s HDMI input. Designed around 1280 × 720 at 60 Hz and mouse/trackpad navigation. All assets are local; there are no external fonts or CDNs.

This project belongs exclusively to [historicbirds/civic-dashboard](https://github.com/historicbirds/civic-dashboard). Personal music in `data/`, credentials, and local virtual environments are excluded from the repository.

## Standalone HTML sample

Open `civic-sound-studio.html` in a browser for the self-contained interface, local file playback, DSP and visualizers. USB discovery and saving music onboard require the Flask backend described below. Rebuild the sample after editing the source with `node scripts/build-sample.cjs`.

## Run on Raspberry Pi OS 64-bit

Install the project at `~/civic-dashboard`, then:

```sh
cd ~/civic-dashboard
python3 -m venv .venv
. .venv/bin/activate
pip install -r requirements.txt
python app.py
```

Open `http://127.0.0.1:5000` on the Pi. The default listener is local to the Pi. For deliberate LAN development, set `CIVIC_HOST` to the intended interface address. `CIVIC_PORT` defaults to `5000`.

Select the Pi's HDMI audio output in Raspberry Pi OS. Set the display to 1280 × 720 at 60 Hz, select the Kenwood HDMI input, and launch Chromium using:

```sh
sh scripts/launch-kiosk.sh
```

## Implemented

- Top-down coupe diagram with all seven physical speakers and their product labels.
- Live stereo source-band trims: bass below 70 Hz, left/right midrange from 70 Hz to 3.5 kHz, and left/right treble above 3.5 kHz. Levels run from 0 to −24 dB, with band audition and restore controls.
- 31-band graphic EQ, 20 Hz–20 kHz, ±12 dB in 0.5 dB steps, presets, and bypass.
- Mid/side stereo separation from mono through 150%, left/right balance, master volume and mute. Width above 100% is normalized to avoid adding matrix gain.
- Local music playback with search, seeking, shuffle, playlist repeat, previous/next, and embedded metadata/artwork for common FLAC and ID3v2.3/v2.4 files. Unsupported tags fall back to filenames; metadata reads are limited to the first 4 MiB and artwork to 3 MiB.
- Flask discovery of music on mounted storage, streamed playback with HTTP byte ranges, and manual file selection. No music is uploaded to an external service.
- **Save to Pi** copies the selected USB or browser-local track into persistent onboard storage, then switches playback to the saved copy. Saved tracks are rediscovered after a browser/server restart and remain playable without the original USB drive.
- Three live post-DSP visualizers: spectrum, waveform, and radial. The waveform uses clearly labeled display scaling; RMS readings remain based on the actual post-volume signal. Rendering is capped around 30 fps and stops when leaving the page.
- Explicit **Save tuning** stores EQ, band trims, width, balance and volume in this browser on this device.
- Home, lighting, vehicle diagnostics, apps, and Bluetooth audio source pages. Plain labels replace the original slogans, and the sidebar uses real Honda and Raspberry Pi assets.

## USB flash drives

Mount the drive in Raspberry Pi OS. Opening **Music** automatically scans `/media`, `/run/media`, and `/mnt`. **Scan USB** refreshes the library after inserting a drive. Supported extensions are FLAC, MP3, WAV, Ogg, M4A, AAC, Opus, AIFF and AIF; decoding still depends on the browser. Chromium lists FLAC among its supported audio formats in its [audio/video documentation](https://www.chromium.org/audio-video/).

For a custom mount location, launch with a colon-separated list of music directories:

```sh
CIVIC_MUSIC_DIRS='/media/your-user/MUSIC:/mnt/music' python app.py
```

Use the actual username and mount paths. Library scans skip hidden items and symlinks, cap directory depth at 24 and tracks at 10,000, and expose only indexed audio IDs. Missing/removable files return a readable error. The app does not mount drives or modify their contents. Direct file-picker selections must be selected again after a reload; server-discovered USB files are found again by scanning.

## Onboard storage

Select a track in **Music**, then press **Save to Pi**. The original stays unchanged. The active player switches to the saved copy while retaining its position. Rows marked **PI** are onboard files; **USB** files still reside on the removable drive; **LOCAL** files are selected in the current browser. Opening Music indexes both onboard and mounted music.

By default, copies live in `data/music/` inside this project. On the Pi this uses its microSD card. To store them on an SSD, set an existing drive location, for example:

```sh
CIVIC_LIBRARY_DIR='/media/your-user/SSD/music' python app.py
```

If using the boot service, add this environment variable there too. Keep this location consistent across restarts. The custom directory's parent must exist so an absent SSD does not silently redirect music onto another disk.

Imports preserve audio bytes without conversion, deduplicate exact content, write hidden temporary files, and expose the copy after it is complete. The per-track limit is 1 GiB; the importer reserves 128 MiB of free storage. Interrupted copies are cleaned up. `data/` is ignored by Git to keep personal music out of the repository. **Delete** appears beside tracks marked **PI** in Music. Confirm **Delete file** to permanently remove that saved copy; USB originals and browser-local files are not deleted. Deleting the selected track stops its playback. A changed file must be rescanned and selected again before it can be deleted. This explicit user action is the only music-deletion path; installation and updates preserve saved tracks.

## Your hardware and shared channels

| Location | Driver | Power |
| --- | --- | --- |
| Front left/right sail panels | Rockford Fosgate P165-SI 1″ PEI component tweeters | R2-200X2, trunk left rack, via passive front crossover |
| Front left/right lower doors | Rockford Fosgate P165-SI 6.5″ component woofers | R2-200X2, trunk left rack |
| Trunk enclosure | Rockford Fosgate R2D4 10″ dual voice coil sub | R2-250X1, trunk right rack |
| Trunk enclosure face, left/right | Kicker CS 6.5″ coaxials | Kenwood DMX8710s |

Source DSP splits and recombines stereo bands using **12 dB/oct Linkwitz–Riley** filters at 70 Hz and 3.5 kHz. Low-band phase compensation and middle-band polarity yield a flat magnitude sum at unity gain. This is a software alignment choice; the physical crossovers have not been measured. The speaker menu clearly identifies when a trim also affects other drivers. Rear coaxial controls adjust the entire corresponding HDMI channel, including the front components and sub feed; separate rear-only levels remain at the head unit.

Pre-EQ gain follows the combined frequency response of all 31 peaking filters. Flat, cut-only and bypassed EQ use unity gain (0 dB). Boosts reserve the estimated combined peak plus at least 0.25 dB, rounded up to 0.1 dB; overlapping filters are included. The EQ page shows this automatic headroom. Changes reserve headroom before moving filters and recover gain smoothly after they settle. A peak compressor remains before master volume, with its automatic makeup gain compensated so below-threshold audio stays at unity. This is not a true-peak brick-wall limiter. The makeup behavior is described in [Chromium’s compressor implementation](https://chromium.googlesource.com/chromium/blink/+/refs/heads/main/Source/platform/audio/DynamicsCompressorKernel.cpp). Playback is decoded and processed as PCM at the browser audio context's sample rate, so this is not a bit-perfect FLAC passthrough or a calibrated speaker-protection system.

## iPhone 15 and Spotify

Bluetooth audio can now use the same DSP and all three visualizers as local/USB music:

**iPhone → PipeWire Bluetooth playback → dedicated silent input → local PCM bridge → browser EQ + DSP → post-DSP visualizer → HDMI.**

After installing requirements, run this as the Pi desktop user:

```sh
sh scripts/enable-bluetooth.sh
```

This enables the local bridge in the existing user service and calibrates the selected HDMI sink to 0 dB (100%, without software over-amplification). `CIVIC_HDMI_UNITY=1` maintains that calibration after audio-service restarts; use the dashboard master volume for level control. If `pactl`/`parec` are missing, the script extracts the official Raspberry Pi OS/Debian `pulseaudio-utils` package into `~/.local/share/civic-audio-tools/`; it does not change the OS audio packages. Alternatively install `pulseaudio-utils` using the OS package manager first. PipeWire, `pipewire-pulse`, WirePlumber and a working HDMI sink must already be running in the desktop session. Set `CIVIC_HDMI_SINK` in the service environment only if there are multiple HDMI outputs and automatic selection chooses the wrong one.

Pair the phone using the Pi's Bluetooth settings. Open **Apps → iPhone + Spotify → Use Bluetooth**. Use Spotify on the phone for playback/track selection and use this dashboard for volume, mute, EQ, shared source-band trims, audition, width and balance. The visualizer reads the audio after the DSP. AVRCP transport buttons and track metadata are not integrated yet; the local transport buttons are disabled while Bluetooth is selected.

The input bridge uses 48 kHz stereo Float32 PCM over a loopback-only, same-origin WebSocket. It adds a bounded jitter buffer (approximately 80 ms target) in addition to Bluetooth and system latency; it is not bit-perfect passthrough. A small adaptive resampler compensates capture/output clock drift. No microphone or audio files are recorded. One dashboard tab can own Bluetooth processing at a time.

Keep the dashboard open. Bluetooth is parked at the silent input in local music mode or if processing disconnects, preventing a second unprocessed HDMI path or a sudden louder fallback. The browser reconnects its bridge after a socket failure. Source selection is stored atomically in `data/audio-source.json` (or `CIVIC_AUDIO_STATE_DIR`) so it survives browser data cleanup and restarts; Chromium's kiosk launcher allows audio to resume. Selecting a library track switches back to local music. The virtual input is recreated and phone streams rerouted after PipeWire restarts or phone reconnections. The backend reports actual stream presence; it does not invent a connected phone.

To disable the bridge and restore ordinary direct Bluetooth playback, stop the dashboard service, move existing `bluez_input.*` sink inputs back to the desired HDMI sink using `pactl move-sink-input`, then remove the `bluetooth.conf` service drop-in and restart the dashboard. Do not unload a sink while capturing it. Saved music is unaffected by enabling/disabling this feature.

[Spotify Connect](https://support.spotify.com/mt/article/spotify-connect/) remains a separate, unimplemented receiver integration. An ordinary USB-C cable is not a verified iPhone audio capture path. [Apple's USB-C guidance](https://support.apple.com/en-gb/105099) describes supported audio connections; wired capture hardware still needs selection and verification. ATOTO lighting and ELM327 diagnostics are described below.

## Display fit

The interface includes an 8 px inset on every edge at 1280 × 720 so the playback bar does not sit at the head unit's crop boundary. The CSS variable `--screen-inset` controls it. Use 100% Chromium site zoom (Ctrl+0); a stored 150% zoom reduces the effective layout to about 853 × 480. The inset does not alter HDMI timing and does not claim to cure flashing pixels caused by a cable, display receiver or graphics scanout. Verify the active output with `WAYLAND_DISPLAY=wayland-0 wlr-randr`; the preferred Kenwood mode is 1280 × 720 at 60 Hz.

## Optional startup templates

The templates assume `~/civic-dashboard` and a configured graphical desktop with automatic login. Update paths if your installation differs.

```sh
mkdir -p ~/.config/systemd/user ~/.config/autostart
cp systemd/civic-dashboard.service ~/.config/systemd/user/
cp systemd/civic-kiosk.desktop ~/.config/autostart/
systemctl --user daemon-reload
systemctl --user enable --now civic-dashboard.service
```

For custom storage roots, add an `Environment=CIVIC_MUSIC_DIRS=...` line to the service, then reload/restart it. The kiosk launcher waits for the local HTTP server before opening Chromium. The user service, local/Bluetooth source switching and 720p kiosk layout were verified on this Pi and Kenwood display. Spotify Connect still needs its own receiver integration.

## Validation

```sh
python -m unittest discover -s tests -v
node tests/dsp.test.cjs
node tests/pcm.test.cjs
node --check static/js/app.js
node --check static/js/metadata.js
```

Backend tests cover scanning, filtering, byte-range streaming, missing files, symlink escape rejection, library limits, concurrent scans, durable onboard copying, deduplication, filename sanitization, storage exhaustion, and interrupted-copy cleanup. DSP checks verify unity reconstruction, crossover cutoffs, rolloff and stereo matrix behavior at 44.1, 48 and 96 kHz.

The UI has been checked at 1280 × 720. A tagged 48 kHz / 16-bit stereo FLAC fixture was discovered through Flask, streamed, decoded, and visualized in the desktop browser. This verifies the software path using a configured test directory; physical USB auto-mounting, Pi performance, and Kenwood HDMI/audio still need an in-car test.


## Logo assets

The sidebar Honda emblem is extracted from the traditional automobile mark in the [Honda logo archive](https://logos-download.com/brands/honda-automobiles), with the shape unchanged and a light fill for the dark interface. The Raspberry Pi image is the [official supplied symbol](https://www.raspberrypi.com/app/uploads/2022/02/COLOUR-Raspberry-Pi-Symbol-Registered.png). Both are bundled locally and embedded in the standalone sample. Honda marks belong to Honda Motor Co., Ltd. Raspberry Pi is a trademark of Raspberry Pi Ltd.


## OBD2 diagnostics

The Vehicle diagnostics page reads a paired ELM327 Bluetooth serial adapter without root or a public serial listener. It displays fresh standard engine readings, additional sensors, and stored trouble codes. Connection status distinguishes a paired adapter from real ECU replies. Missing samples expire to a dash; a failed code request is never reported as “no codes.” Reconnect and code-scan actions are available on the Pi display. No code clearing, actuator control, programming, or arbitrary command endpoint is provided; the serial relay also filters outgoing commands.

Install `requirements.txt` in the Pi virtual environment. Pair the adapter using Bluetooth settings, then discover its actual serial channel with `sdptool search --bdaddr ADDRESS SP`. Bluetooth pairing alone does not establish an ECU connection. Create `~/.config/systemd/user/civic-dashboard.service.d/obd.conf`:

```ini
[Service]
Environment=CIVIC_OBD_ENABLED=1
Environment=CIVIC_OBD_ADDRESS=YOUR_PAIRED_ADAPTER_MAC
Environment=CIVIC_OBD_CHANNEL=2
Environment=CIVIC_OBD_PROTOCOL=7
Environment=CIVIC_OBD_HEADER=18DB33F1
```

These channel/protocol/header settings were verified with this car’s current adapter. Other adapters can use different channels; omitting protocol/header allows python-OBD’s automatic discovery. Reload and restart the existing service with `systemctl --user daemon-reload` and `systemctl --user restart civic-dashboard.service`. Existing Bluetooth audio settings remain in their separate service drop-in. No discovery scan runs during normal polling, and the reader reconnects automatically after adapter loss.

Verified in the running vehicle: RPM, coolant temperature, stationary speed, engine load, throttle position, intake temperature, manifold pressure, long-term fuel trim, adapter supply voltage, and a stored-code response. This adapter intermittently returns NO DATA; individual cards can show dashes until another valid reply arrives. Adapter supply voltage is labeled separately from ECU voltage. No unsupported Honda-specific module or sensor definitions are guessed. The 2011 EX coupe/R18/manual vehicle identity does not itself change standard OBD2 PID decoding. ABS, SRS, TPMS and manufacturer-specific module diagnostics are outside this integration.

The python-OBD dependency is pinned to 0.7.3 because the reader isolates two initialization compatibility hooks for functional addressing and late ECU discovery. Tests exercise the real library through a simulated serial adapter, including intermittent capabilities, zero speed, RPM decoding, code decoding and wire-level rejection of clear commands.


## ATOTO cabin lighting and Bass pulse

The Lights page controls the tested CI-FLT01 controller directly over BLE: power, shared RGB color, and front/rear brightness. Controls enable only after a fresh controller state reply. Disconnected or stale devices are never presented as connected. The owner confirmed the red color test; the controller also reports firmware, color and zone brightness. See [protocol notes](docs/atoto-protocol.md) for the source and tested firmware.

Install requirements and enable the integration as the Pi desktop user, using the address discovered for the actual controller:

```sh
sh scripts/enable-lighting.sh AA:BB:CC:DD:EE:FF
```

This creates a separate user-service drop-in with `CIVIC_LIGHTS_ENABLED=1` and `CIVIC_LIGHTS_ADDRESS`. It preserves Bluetooth audio, HDMI calibration, OBD2 and saved music. Close other lighting apps before connecting. The controller needs power; the Pi tries its cached device first and uses bounded discovery with an address filter only when needed. Connection retries back off to 30 seconds.

Select **Bass pulse** to use the same processed Bluetooth/local music that feeds HDMI. The detector measures stereo bass energy from 25–90 Hz, after EQ and master volume. Sensitivity adjusts bass-hit detection against recent energy; Pulse strength scales peak brightness. Sustained notes decay and silence goes dark. Front/rear sliders set the maximum brightness in this mode. Processing continues when you navigate to another dashboard page. If browser audio processing stops sending levels, the backend restores steady zone brightness after 1.5 seconds. Discrete controller levels and BLE add latency; this is not sample-accurate synchronization. Bass pulse must be enabled again after a dashboard service restart. **Solid** restores steady brightness.

Validation also includes `node tests/bass.test.cjs`, actual controller-state parsing, typed-command validation, bounded brightness, queue limits, missing-audio recovery and controller/session tests. Browser tests verify stereo bass detection, high-frequency rejection, continued operation on other pages, unchanged audio gain, connection states and the 1280 × 720 layout.
