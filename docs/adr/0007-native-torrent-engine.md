# The native torrent engine is the default; qBittorrent is an optional engine

---
status: accepted
---

The server embeds a BitTorrent engine (anacrolix/torrent v1.61.0, pinned, MPL-2.0,
pure Go) implementing the same TorrentEngine port the qBittorrent adapter
implements. Settings select one active engine per deployment (`downloadEngine`:
`native` default, `qbittorrent` restores the sidecar stack); a download is
forever tied to its creating engine through its Engine route (`native:<hash>` /
`qb:<hash>`), and downloads belonging to the inactive engine surface as
unavailable. The native engine writes pieces in place under
`<DownloadRoot>/<infohash>/`, seeds until eviction, keeps its session (metainfo,
file selection, piece-completion bolt db) under `data/torrent-session`, and
elevates exactly the byte window a seek or probe needs (`PrepareRange`), which
qBittorrent cannot do and no-ops. Seek and probe windows are elevated as
explicit piece-priority ranges set through the public per-piece setter
(`Piece.SetPriority`), with the per-file baseline reasserting behind
piece-level overrides (priorities Raise); reader-based steering is inert in
the pinned version because reader readahead zeroes while not reading.

## Evidence

- cenkalti/rain was disqualified on its own source: no per-file selection, and
  every file preallocates — season-pack exclusion is impossible.
- Hand-rolling a BEP-3 client was rejected: protocol-edge stall risk for a
  dependency saving that is compile-time only.
- The dependency argument is operational: the native default removes the
  qBittorrent container entirely; go.mod weight is not runtime weight.

## Considered options

- **Both engines live simultaneously** — rejected: retention and allocation
  accounting across two engines buys nothing for a single household.
- **rain (cenkalti)** — rejected: no file selection.
- **cgo libtorrent bindings** — rejected: stale, and cgo breaks the
  six-platform matrix (windows/linux/darwin x amd64/arm64).

## Consequences

- The compose default is single-container; `--profile qbittorrent` restores the
  sidecar stack; external qBittorrent keeps serving bare-metal Pi deployments
  (ADR-0005 governs those).
- Anacrolix upgrades require checking its retract history; the pinned version
  is the stability boundary.
- Per-tracker seeder counts are unavailable from anacrolix v1.61.0's public
  API; native-mode downloads report tracker stats as zero.
- Retention skips foreign-engine routes: the active engine cannot delete another engine's data; the operator re-switches engines to evict (documented consequence of one-active-engine).
- Native error surfacing in v1.61.0 is limited to disk-write failures
  (`SetOnWriteChunkError` → canonical error state); tracker and peer failures
  surface only as stalled progress (the WaitRange timeout at playback) — the
  pinned library exposes no per-torrent lastError.
