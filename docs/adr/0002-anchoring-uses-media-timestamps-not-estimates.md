# Seek and sync anchoring uses media timestamps, not estimates

---
status: accepted
---

Seek and sync anchoring for client-decoded audio (the Client decode route) must derive from real media timestamps — the PTS of the content actually being decoded and scheduled. Average-bitrate arithmetic is prohibited for any decision about which audio content plays when.

## Context

Two measured failures, both in the web client's decode chain:

- The session header-audio trim used an average-bitrate estimate; the estimate said 1.557 s where reality was 11.264 s, leaking ~9.7 s of file-start audio into every 16 MiB window and compounding without bound. Fixed by byte-exact measurement (commit `837a352`).
- Average-bitrate seek anchoring (`time × bytesPerSecond`) misses true content position by +11 s to −91 s on VBR titles (measured 2026-08-29 against household titles via bitstream PTS probing). The resulting wrong-content audio is structurally invisible to timeline-only drift checks, because both clocks advance together.

## Considered Options

- **Average-bitrate estimates** (status quo before this ADR): cheap, no per-file data, wrong by tens of seconds and silently.
- **Media-timestamp ground truth** (chosen): per-file timestamp facts obtained by probing the container (at import/prepare time, or by byte-exact session-time measurement), so every scheduled sample is placed by what it is, not by where arithmetic guesses it to be.

## Consequences

Timestamp ground truth becomes part of the playback contract and must exist before playback of a Source needs it; probes may be cached per file identity. Estimates remain acceptable for purely cosmetic purposes (progress display), never for content placement. Server encoding throughput remains a separate concern governed by ADR-0001.
