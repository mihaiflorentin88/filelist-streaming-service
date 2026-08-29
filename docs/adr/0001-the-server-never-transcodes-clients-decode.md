# The server never transcodes; clients decode

---
status: revised — the audio-transcode prohibition was reversed by 0003; the video-copy invariant stands
---

The Pi 4 box serves original bytes only: progressive piece-serving plus Range. The fMP4/AAC audio-transcode route is removed — an unconditional re-encode through an ffmpeg pipe that the Pi cannot keep ahead of, it made audio drift behind video in every browser session. The TV Direct plays via AVPlay; the web app decodes non-native audio client-side (audio-only WASM decoder) and plays everything else natively.

## Considered Options

- **Server-side audio transcode (removed)**: the Pi 4 CPU cannot sustain the encode; audio falls behind video.
- **Server remux with audio stream-copied**: cheaper, but still a per-session ffmpeg pipe, and it cannot make AC3/DTS browser-decodable — covers only part of the library.

## Consequences

Desktop Chromium (Brave) is the supported web target. A/V sync between the video clock and the WebAudio output is the web player's responsibility. Codec gaps surface on the client, not the server.
