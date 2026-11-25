# CI-FLT01 integration notes

The observed controller advertises as ATW-FWD-9333. Its firmware reports `V2.00 3008-JH230923-038`. A solid red command was visually confirmed by the owner. These findings apply to the tested controller; other firmware has not been verified.

Protocol provenance: the download QR code in [ATOTO's CI-FLT01 manual](https://www.atotodirect.com/pages/manual-417-en) resolves to the [official LumiAuto download entry](https://resources.myatoto.com/appdownload/detail?id=1700354023428288514). The official Android phone APK is version 1.0.0.8, SHA-256 `92cb50508aa317fcb8faf321be78629b04c969fe1f820cb7e444f2a19fc9bfae`. It was inspected for interoperability; the APK and decompiled implementation are not included in this project.

The app writes ASCII to `0000ffe1-0000-1000-8000-00805f9b34fb` under service FFE0 and enables notifications on that characteristic. The device also exposes FFE2, FF11, and FF12, but the integration uses only the verified FFE1 transport.

| Action | ASCII frame |
| --- | --- |
| Query firmware/state | `<0A01>` |
| Power on/off | `<0701>` / `<0700>` |
| Front brightness 0–9 | `<01010N>` |
| Rear brightness 0–9 | `<01020N>` |
| Select solid RGB | `<1E18>` |
| Set shared RGB | `AT+<06RRGGBB>0000FF1100001000800000805F9B34FB` |

The UUID suffix in the color frame is part of its ASCII payload; it is not a request to write to another characteristic. Send the solid-mode frame before RGB, with a short settling interval. Color frames are 45 bytes; the BLE connection must support that write size. The tested controller exposes a maximum write size of 509 bytes.

Notifications are delimited with `<` and `>`. Multiple frames and fragmented notifications must be handled. A `13` frame contains firmware text encoded as hex. A `1F` frame on this firmware contains 15 decoded bytes: effect at byte 2; power mode at byte 3; front RGB at bytes 4–6; rear RGB at bytes 7–9; front/rear brightness at bytes 10/11. Other fields are not interpreted. Invalid length, brightness, or power flags are rejected. Unknown vendor frames are ignored. Reported RGB can take time to settle after a write; a successful BLE write alone is not a confirmed lighting state.

Bass pulse is implemented in the dashboard, using independent left/right 25–90 Hz filters after DSP/master volume. Stereo energy is combined without cancelling opposite-phase bass. Positive changes against recent bass energy trigger separate hits; a sustained note releases rather than holding the lights on. Pulse strength scales peak brightness, with zero brightness during silence. The analysis filters use Web Audio’s dB Q parameter for a Butterworth response. A fast attack and slower decay drive bounded zone levels; the BLE worker keeps only the newest envelope and avoids a command backlog. The HTTP sampler runs at 8 Hz. Controller levels are discrete 0–9, so this is not sample-accurate lighting. No audio is recorded and no microphone is used. Missing browser samples for 1.5 seconds restore the selected steady brightness while the backend/controller connection remains available.

Filter Q follows the [Web Audio specification](https://www.w3.org/TR/webaudio-1.1/#dom-biquadfilternode-q), which defines low/high-pass Q in decibels.
