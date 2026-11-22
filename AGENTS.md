# Civic dashboard project instructions

- This project belongs exclusively to the GitHub account `historicbirds`: https://github.com/historicbirds. Do not associate it with another GitHub owner or default account. Verify account and remote ownership before any GitHub write. Do not change global Git configuration.
- Target vehicle: 2011 Honda Civic EX two-door coupe, R18 engine, five-speed manual.
- Target platform: Raspberry Pi 4, Raspberry Pi OS 64-bit, Flask, Chromium kiosk, Kenwood DMX8710s HDMI input, 1280 × 720 at 60 Hz. Navigation uses a mouse/trackpad.
- Preserve the graphite/cobalt palette and large controls. Use “Vehicle diagnostics” and “OBD2,” not “Vehicle health” or “Under the hood.” Avoid slogans and blue periods on titles. Keep the vehicle identity in one place; do not repeat Civic branding around the UI. Use the real Honda and Raspberry Pi assets in the sidebar, never text approximations of their logos.
- Seven physical drivers share two HDMI channels. Source frequency trims do not create independent speaker outputs. Be explicit when controls affect shared source bands.
- Frequency boundaries: 70 Hz bass, approximately 3.5 kHz treble, 12 dB/octave software source-band splitting. Do not claim the physical crossover alignment has been measured.
- iPhone 15 Bluetooth reception, Spotify Connect, lighting, and OBD2 are planned integrations; never present disconnected hardware as connected.
- Onboard music lives at `data/music/` by default or `CIVIC_LIBRARY_DIR`. Treat saved tracks as user data: never commit them, remove them, or overwrite source music. Imports must preserve exact file bytes and handle duplicates and incomplete copies.
- Validate backend changes with `python -m unittest discover -s tests -v`; validate DSP with `node tests/dsp.test.cjs`. Check the interface at 1280 × 720 after layout changes.
