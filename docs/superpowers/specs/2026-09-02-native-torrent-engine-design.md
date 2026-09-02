# Native torrent engine design

Date: 2026-09-02
Status: approved design, awaiting implementation plan

## Problem

The service depends on a qBittorrent sidecar container for every download operation: add, file selection, piece status, pause/resume, eviction. The sidecar is an operational dependency (a Qt application with its own config format, WebUI, and qBit-5 state-string quirks like `stoppedDL`/`stoppedUP` meaning paused). The goal is an embedded torrent client in the Go server so the qBittorrent integration becomes optional, with as few dependencies as possible, and a contract/adapter/DTO layer that supports both a native client and qBittorrent.

## Decisions made with the operator

1. **One active engine per deployment.** Settings choose `native` or `qbittorrent` at startup. Downloads persist their engine route (`qb:<infohash>` / `native:<infohash>`) forever; downloads belonging to the inactive engine surface as unavailable — the behavior that already exists when an engine torrent goes missing. No data migration.
2. **Seed until evicted.** The native client seeds completed torrents until eviction deletes them, matching today's qBittorrent sidecar behavior and private-tracker etiquette.
3. **Native becomes the compose default.** The single-container stack ships without qBittorrent; a compose profile restores the sidecar. External-qBittorrent mode for the bare-metal Pi is preserved.
4. **Library: anacrolix/torrent, version pinned.** See research below for why rain and hand-rolling lost.
5. **Six-platform support.** The server builds and runs on windows, linux, and darwin, each on amd64 and arm64 (`CGO_ENABLED=0` throughout — the build target already sets it, and every dependency must keep it that way).

## Research summary (2026-09-02)

- **anacrolix/torrent v1.61.0** (2025-12-17). MPL-2.0, pure Go (`CGO_ENABLED=0` builds for linux/arm64 and amd64), per-file `Download()`, per-piece `Priority()`. Production users include TorrServer, Gopeed, bitmagnet, Erigon. Costs: heavy dependency tree (~51 direct / ~75 indirect, including Pion WebRTC and OpenTelemetry) and a documented history of breaking changes and retracted versions, which pins are the mitigation for.
- **cenkalti/rain v2.3.0 — disqualified.** Source-verified (session_add.go, torrent.go): `AddTorrentOptions` exposes only `ID/Stopped/StopAfterDownload/StopAfterMetadata/Sequential`; there is no per-file selection API and the allocator preallocates every file. Season-pack exclusion — `PrepareFiles` zeroing unwanted files so only the selected episode and subtitles download — is impossible. Rain's lack of a reader abstraction is irrelevant here: this app streams from disk, not from an in-process reader.
- **Hand-rolled BEP-3 client — rejected.** Feasible for a private-tracker, `.torrent`-only client (~2-4k lines), but re-implements choke algorithms, MSE encryption expectations, endgame, and multi-tracker failover — protocol-edge stall bugs, the failure class this project has repeatedly paid for elsewhere.
- **Dependency framing.** "As few dependencies as possible" is served at the operational layer: the native engine removes the qBittorrent container entirely. A Go module dependency compiles into the single binary and has no runtime footprint. Shaving go.mod entries at the cost of protocol correctness is the bad trade.

## Architecture

New adapter `internal/adapters/nativetorrent` wrapping `*torrent.Client` (anacrolix/torrent v1.61.0, exact version pinned in go.mod). Same constructor shape as the qbit adapter: `New(settings accessor func)`.

### Engine route registry

`engineHash`'s hardcoded `qb:` prefix (internal/application/service.go) becomes a route lookup: `route(engineID) -> (engine, hash)` against a registry populated from config. The registry holds one active engine for new adds; per-torrent calls resolve by route prefix. A prefix with no registered engine resolves to the existing "unavailable" path. Composition builds only the configured engine; the application layer never learns which one runs.

### Engine-owned state

- **Media files:** anacrolix file storage rooted at `DownloadRoot`, per-torrent directory `<DownloadRoot>/<infohash-hex>/<torrent-relative path>`. Chosen so the existing path-resolution logic works unchanged.
- **Engine session:** metainfo bytes, selected-file sets, and the piece-completion bolt database under `data/torrent-session/` (configurable), next to the app's sqlite. On boot the adapter re-adds every persisted torrent and re-applies its file selections. The session is adapter-internal; composition never sees it.
- **Networking:** FileList `.torrent` files carry the private flag, so anacrolix auto-disables DHT and PEX; announces go to the tracker URL with the embedded passkey. Outbound-only connectivity works on the household LAN. An optional fixed peer port setting improves seeding reachability.
- **Cross-platform:** the six-target matrix (windows/linux/darwin x amd64/arm64) forbids cgo and platform-conditional behavior in the adapter. The free-space probe behind ADR-0004's Reserve check is Linux-only today (`diskfree_other.go` skips with a warning); it gains darwin (`syscall.Statfs`) and windows (`golang.org/x/sys/windows` `GetDiskFreeSpaceEx`) implementations so Reserve works on every target. All storage and session paths go through `filepath` (existing codebase habit).

## Contract (internal/application/ports.go)

- **Existing ten `TorrentEngine` methods keep their shapes.** `Add` returns the info-hash hex. `Files` builds `domain.TorrentFile` values with cumulative byte offsets from metainfo (stable metainfo order). `Pieces` maps piece states to `domain.PieceMap`. `Status` fills the existing `DownloadStatus` DTO with `SavePath=DownloadRoot`, `ContentPath=<DownloadRoot>/<hash>`, `TempPathEnabled=false`.
- **Canonical download states.** qBittorrent's raw state strings currently leak through the application layer (`Contains "paused"` in catalog aggregation, `HasPrefix "paused"` in resume-on-playback). Both adapters emit canonical constants from the adapter boundary: `downloading`, `seeding`, `pausedDL`, `pausedUP`, `queued`, `error`. Matching helpers in `domain` accept both canonical and legacy qBittorrent strings, including qBit-5 `stoppedDL`/`stoppedUP`, so sqlite-persisted rows keep working with zero migration. qBittorrent raw strings stop at its adapter.
- **One new method: `PrepareRange(ctx, hash, fileIndex, start, count)`** elevates exactly the pieces covering a seek window. `start` and `count` are byte offsets within the torrent (global, computed from the download's file offset plus the requested media range), so implementations map them onto piece indexes directly. The native adapter implements it with piece priorities; the qbit adapter is a documented no-op (qBittorrent has no range-priority API; its sequential scheduler covers it). Called from `waitReadablePath` before `WaitRange`.
- **`TestQB` renames to `TestEngine`.** HTTP routes do not change (client compatibility).

## Data flow (native engine)

- **Add:** `.torrent` bytes parse synchronously — info-hash and file list are available immediately, no `GotInfo` wait; the service's poll-until-files loop is naturally compatible. Default piece priority is zero: nothing downloads until `PrepareFiles`.
- **PrepareFiles(indices, subtitleIndices):** wanted files get a baseline download priority (whole file queued, unwanted files never requested); per-torrent explicit piece-priority windows — public-API `DownloadPieces`/`CancelPieces` ranges — elevate the exact byte window above the baseline: head window at prepare, seek/probe windows on every `PrepareRange`. This delivers the same sequential-within-file and early head/tail scheduling semantics that qBittorrent's sequential + first/last-piece flags provide, which the buffering knobs (`StreamStartBytes`, `InitialBufferBytes`, `ReadAheadBytes`) were tuned against. (v1.61.0 exposes no public per-piece priority setter and reader-based steering is inert — readahead zeroes while not reading — so windows are range-based.)
- **Playback: unchanged.** `Pieces()` poll, `WaitRange`, then serve file ranges from disk. The compatibility stream, subtitles, and mediaprobe keep reading files; nothing downstream touches the engine.
- **Seeding:** completed torrents seed until eviction.
- **Eviction:** `Remove(hash, deleteFiles=true)` drops the torrent from the client and deletes `<DownloadRoot>/<hash>`.
- **Pause/Resume:** maps to suspending/resuming data transfer (`DisallowDataDownload/Upload` and their allow counterparts — v1.61.0 has no per-torrent start/stop); the existing resume-on-playback logic applies.

## Error handling

- **Add failures** (bad bencode, over-size): surfaced the same way the qbit adapter surfaces HTTP rejects; the service maps them through existing error paths.
- **Duplicate adds** (retry path, post-restart re-prepare): idempotent — adding an info-hash the client already holds returns the existing torrent's hash, never a second entry.
- **Swarm stalls:** `WaitRange`'s existing timeout (`PieceWaitTimeoutSeconds`) is unchanged; `PrepareRange` keeps deep seeks from eating it. No new timeout policy in this change.
- **Disk and engine errors:** the adapter surfaces lastError through `Status` as canonical `error` state plus the `Download.Error` message — the same channel qBittorrent errors use today.
- **Client construction failure** (port bind, session database lock): startup failure in composition — fatal like sqlite-open failure, never swallowed.
- **Foreign routes:** engine prefix not in the registry resolves to the existing unavailable behavior. No special-casing.

## Testing

- **Adapter unit tests:** metainfo to `Files` offsets and playable flags; `PrepareFiles`/`PrepareRange` priority math asserted through the library's piece-priority API; state-mapping table including qBit-5 stopped strings; session persistence round-trip.
- **Offline integration test:** in-process swarm — a second anacrolix client seeds a temp file over a private torrent, peers wired via the library's add-peers API. Assert only selected files land on disk, `Pieces` reflects completion, the resolved path is readable mid-download, and `Remove(deleteFiles=true)` cleans up. No network, no tracker.
- **Application layer:** registry routing (right engine per prefix); state helpers accept legacy and canonical vocabularies. Existing `stream_test.go` and `retention_test.go` contract fakes double as the qbit-parity harness.
- **Cross-compile matrix:** every target builds: `GOOS` in (windows, linux, darwin) x `GOARCH` in (amd64, arm64) with `CGO_ENABLED=0 go build ./...`. Unit tests run on the host; the matrix guards compile-time regressions only.
- **Real-world smoke:** `make docker-up` plus `verify.sh`, add a real FileList release, progressive playback in browser and on the Tizen set, then the Pi deploy ritual. The changed surface is playback, so playback is the proof.

## Migration and deploy

- **Config:** `downloadEngine: native` default; `qbittorrent` restores today's behavior. New settings: `torrentPeerPort` (optional fixed peer port), `torrentSessionDir` (default `data/torrent-session`).
- **Existing downloads:** rows keep `qb:` routes and surface unavailable under the default until the operator finishes them under `downloadEngine: qbittorrent` or re-prepares under native. Deliberate consequence of one-active-engine; documented, not silently migrated.
- **Compose:** single-container default; the qBittorrent sidecar moves to a compose profile, so `docker compose --profile qbittorrent` restores today's stack. External-qBittorrent mode for bare-metal Pi untouched.
- **Build targets:** the Makefile gains a multi-target build producing `bin/filelist-streaming-<os>-<arch>` for all six platforms; the docker image stays a linux amd64+arm64 multi-arch build.
- **Docs:** new ADR `docs/adr/0007-native-torrent-engine.md` (native default, one active engine, seed-until-evicted, library choice with the rain disqualification evidence). ADR-0005 gains a scope note: it governs qBittorrent deployments. CONTEXT.md gains terms only where they earn their place (`Download engine` likely, since `Engine route` already exists).

## Out of scope
- Transcoding of any kind: ADR-0001 and ADR-0003 govern as-is. Video is always copied; the compatibility stream exists for browser-hostile audio and does not care which engine wrote the bytes. The ffmpeg-pipe and fMP4 ideas from the initial research are excluded by existing ADRs.
- Magnet URI ingestion: the app adds `.torrent` files fetched from FileList; magnet support comes free with the library but no API surface is added for it.
- Ratio-based seeding rules: revisit only if tracker standing demands it.

## Consequences

- The docker default stack becomes single-container; qBittorrent is an explicit choice.
- The application layer gains a real engine contract: route registry, canonical states, engine-neutral naming. Future engines slot in by implementing one interface.
- go.mod grows by anacrolix/torrent's tree (~75 transitive modules, compile-time only).
- Upgrading anacrolix/torrent requires checking its retract list; the pinned version is the stability boundary.
