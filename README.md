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
- Home, lighting, vehicle diagnostics, apps, and iPhone/Spotify connection-planning pages. Plain labels replace the original slogans, and the sidebar uses real Honda and Raspberry Pi assets.

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

Imports preserve audio bytes without conversion, deduplicate exact content, write hidden temporary files, and expose the copy after it is complete. The per-track limit is 1 GiB; the importer reserves 128 MiB of free storage. Interrupted copies are cleaned up. `data/` is ignored by Git to keep personal music out of the repository. There is no delete button in this pass.

## Your hardware and shared channels

| Location | Driver | Power |
| --- | --- | --- |
| Front left/right sail panels | Rockford Fosgate P165-SI 1″ PEI component tweeters | R2-200X2, trunk left rack, via passive front crossover |
| Front left/right lower doors | Rockford Fosgate P165-SI 6.5″ component woofers | R2-200X2, trunk left rack |
| Trunk enclosure | Rockford Fosgate R2D4 10″ dual voice coil sub | R2-250X1, trunk right rack |
| Trunk enclosure face, left/right | Kicker CS 6.5″ coaxials | Kenwood DMX8710s |

Source DSP splits and recombines stereo bands using **12 dB/oct Linkwitz–Riley** filters at 70 Hz and 3.5 kHz. Low-band phase compensation and middle-band polarity yield a flat magnitude sum at unity gain. This is a software alignment choice; the physical crossovers have not been measured. The speaker menu clearly identifies when a trim also affects other drivers. Rear coaxial controls adjust the entire corresponding HDMI channel, including the front components and sub feed; separate rear-only levels remain at the head unit.

The signal graph uses −12 dB pre-EQ headroom and a peak compressor before master volume. Playback is decoded and processed as PCM at the browser audio context's sample rate, so this is not a bit-perfect FLAC passthrough or a calibrated speaker-protection system.

## iPhone 15 and Spotify

The interface includes a connection plan, not a functioning phone receiver yet. The intended path is **iPhone → Pi Bluetooth A2DP receiver → system DSP → HDMI → Kenwood**. PipeWire exposes the A2DP receiver role in its [Bluetooth properties](https://docs.pipewire.org/page_man_pipewire-props_7.html). A receiver and system-level DSP must be configured before phone audio will share these controls; browser Web Audio currently processes local/USB music only.

[Spotify Connect](https://support.spotify.com/mt/article/spotify-connect/) is an alternative requiring compatible Pi receiver software and networking. An ordinary USB-C cable into the Pi is not a verified iPhone audio capture path. [Apple's USB-C guidance](https://support.apple.com/en-gb/105099) describes supported audio connections; wired capture hardware still needs selection and verification.

Bluetooth pairing/reconnection, Spotify receiver integration, ATOTO CI-FLT01 control and ELM327 diagnostics remain unimplemented. Their pages do not fabricate connections or vehicle readings.

## Optional startup templates

The templates assume `~/civic-dashboard` and a configured graphical desktop with automatic login. Update paths if your installation differs.

```sh
mkdir -p ~/.config/systemd/user ~/.config/autostart
cp systemd/civic-dashboard.service ~/.config/systemd/user/
cp systemd/civic-kiosk.desktop ~/.config/autostart/
systemctl --user daemon-reload
systemctl --user enable --now civic-dashboard.service
```

For custom storage roots, add an `Environment=CIVIC_MUSIC_DIRS=...` line to the service, then reload/restart it. The kiosk launcher waits for the local HTTP server before opening Chromium. These templates have not been tested on the physical Pi or head unit.

## Validation

```sh
python -m unittest discover -s tests -v
node tests/dsp.test.cjs
node --check static/js/app.js
node --check static/js/metadata.js
```

Backend tests cover scanning, filtering, byte-range streaming, missing files, symlink escape rejection, library limits, concurrent scans, durable onboard copying, deduplication, filename sanitization, storage exhaustion, and interrupted-copy cleanup. DSP checks verify unity reconstruction, crossover cutoffs, rolloff and stereo matrix behavior at 44.1, 48 and 96 kHz.

The UI has been checked at 1280 × 720. A tagged 48 kHz / 16-bit stereo FLAC fixture was discovered through Flask, streamed, decoded, and visualized in the desktop browser. This verifies the software path using a configured test directory; physical USB auto-mounting, Pi performance, and Kenwood HDMI/audio still need an in-car test.


## Logo assets

The sidebar Honda emblem is extracted from the traditional automobile mark in the [Honda logo archive](https://logos-download.com/brands/honda-automobiles), with the shape unchanged and a light fill for the dark interface. The Raspberry Pi image is the [official supplied symbol](https://www.raspberrypi.com/app/uploads/2022/02/COLOUR-Raspberry-Pi-Symbol-Registered.png). Both are bundled locally and embedded in the standalone sample. Honda marks belong to Honda Motor Co., Ltd. Raspberry Pi is a trademark of Raspberry Pi Ltd.
