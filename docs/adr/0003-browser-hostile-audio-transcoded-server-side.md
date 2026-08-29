# Browser-hostile audio is transcoded server-side, video is always copied

---
status: accepted
revises: 0001-the-server-never-transcodes-clients-decode.md
---

## Context

Browsers cannot decode E-AC-3 (DD+), the audio codec of most of this library's
releases. ADR-0001 bet on client-side decoding (ffmpeg.wasm in a Web Worker,
WebAudio scheduling against the video clock). Versions 0.2.8–0.2.12 hardened
that path — measured anchor probing, planner convergence fixes, piped probe
truth, lease contention removal — and playback still broke at the edges:
multi-second seeks, decode starvation deep into files, suspension edge cases,
and a hand-rolled sync controller that must never drift, stall, or lose its
anchor. The viewer-facing verdict after five hardening releases: broken.

The v0.2.7 compat route (`GET /api/v1/streams/{id}/browser`) — video copied,
selected audio track transcoded to AAC stereo in a fragmented MP4 — had been
removed on the claim that the Pi cannot sustain the encode.

## Evidence

Measured on the Pi 4 (2026-08-29), Fightland S01E03 (E-AC-3 5.1), input
seek to 30:00, 120 s of content transcoded (video copied, audio to AAC
stereo): 8.73 s wall clock — **13.7× realtime**, 97% of one core, 56 MB RSS.

The premise of ADR-0001 is wrong for audio-only transcode. The removed route
already sought input-side (`-ss` before `-i`), so its reported failures —
"audio falls behind video in every browser session" — are not explained by
missing seeking; the actual cause was never isolated. What is established
today: with the same argument structure, the Pi sustains the encode with
more than an order of magnitude of headroom.

The bet is therefore revisited on measured capacity, not on a claimed old
root cause: the encode is cheap enough that any residual historical failure
(concurrent sessions, storage contention, or client-side issues) can be
diagnosed per-case if it reappears.

## Decision

1. The web player plays the compatibility stream for any title whose selected
   audio track the browser cannot decode (or a non-default track in a
   multi-track file). Everything else direct-plays the progressive stream.
2. The element owns audio: volume, mute, and sync are the browser's job. No
   client-side decode, no WebAudio scheduling, no anchor planner in the
   player. Seeking a compatibility stream re-issues the request at the new
   position (`startMs`); subtitle cues are shifted client-side to match.
3. Seeks snap back to the last video keyframe (ffprobe packet scan, 3s
   budget, raw-target fallback). Stream-copied video can only start on a
   keyframe while the re-encoded audio starts exactly at the target, so an
   unsnapped seek leaves audio leading picture by up to one GOP — measured
   0.2-1.7s at representative positions in this library before the snap.
4. The Pi safety invariant stands, narrowed: **video is always copied; only
   the selected audio stream is transcoded** (`-c:v copy -c:a aac -ac 2`).
5. Tizen is unaffected: AVPlay direct-plays original bytes.

## Consequences

- A/V sync, seeking, and volume become native browser behavior — the entire
  class of custom-sync defects (drift, starvation, anchor convergence,
  autoplay suspension) is eliminated by construction.
- The Pi spends ~7% of one core per playing web client (audio AAC encode);
  concurrent viewers scale linearly and remain trivial vs. the network.
- The compatibility stream is a live transcode: it is not range-addressable,
  so byte-range seeking is a re-request, and each seek restarts the ffmpeg
  process (~1 s).
- The server-side audio-anchor probing infrastructure (`/downloads/{id}/
  audio-anchor`, mediaprobe anchor) is retained: it is tested, harmless, and
  the honest measurement layer behind ADR-0002; the client planner that
  consumed it is removed with the wasm decode stack.
