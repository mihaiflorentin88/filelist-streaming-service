# Known issues

## Tizen 0.2.2 navigation, progressive playback, and performance need physical-TV verification

The 0.1.3 Smart Remote input path is confirmed on the target S90C. Version 0.2.0 replaced nearest-geometry navigation with explicit regions, rows, columns, and stable focus keys. Version 0.2.1 additionally aligns TV categories and household sections with the browser's cache-backed APIs. Vertical movement stays in the closest column, Left from the first content column opens the sidebar, Right returns to the exact content control, and player dialogs restore their launcher. The rail moves with a short compositor transform, card focus no longer scales heavy artwork, and each catalog page is limited to 12 cards with targeted metadata patching. Inputs open Samsung IME only after OK enters edit mode. SSE reconnect uses bounded exponential backoff and can report failures to the daemon log. The Docker test/build passes, but smoothness, reconnection, data parity, and revised behavior still need confirmation on the physical TV.

## Progressive playback still needs physical-client verification

The Raspberry Pi server now maps HTTP byte ranges to qBittorrent pieces, reasserts sequential and first/last scheduling, and reads incomplete content from qBittorrent's effective temporary path. A throttled live test returned valid startup and tail HTTP 206 responses at 3.39% completion, and the Pi's existing `ffprobe` parsed that same progressive URL as Matroska with the expected duration. The server-side phase-3 defect is resolved.

Browser video and Tizen AVPlay now retry incomplete streams as requested pieces become readable instead of waiting for 100% completion. The web player decodes non-native audio client-side (verified playing an EAC3 title from the raw progressive stream); actual audibility on household screens and physical S90C AVPlay/remote behavior below 100% still need observation; server `ffprobe` is not a substitute for that client/device test.

## Direct-play compatibility

The server never transcodes anything (see `docs/adr/0001`). The web app decodes audio the browser cannot handle natively (AC3/EAC3/DTS) client-side with an audio-only WASM decoder and plays everything else natively; video is never re-encoded anywhere. Tizen remains direct-play through AVPlay, so unsupported TV video or audio formats require choosing another source.

## Catalog metadata coverage

Canonical release parsing, IMDb-backed TMDB title metadata, persisted TMDB community rating/vote data, and on-demand season-pack file expansion are implemented. Episode-level TMDB artwork/descriptions, cast/runtime/genres, compatibility probing, and scoped cache-management controls remain incomplete. Releases without IMDb IDs use parsed fallback titles and generated client placeholders. FileList does not expose historical pagination, so the append-only cache becomes progressively more complete through latest sync, rebuild windows, searches, and title expansion rather than claiming an immediate full-tracker import.

## Background jobs still need dispatcher hardening

Metadata, tracker-search, and catalog jobs are persisted and visible as queued, running, retry-waiting, completed, or failed. Structured attempt logs, terminal-job retry, rate-limit-aware waits, hourly transient retry, explicit reconnect event-journal replay, SSE updates, manual latest/rebuild actions, hourly/weekly schedules, and restart recovery are implemented. The global worker ceiling defaults to 10 and FileList remains serialized. Cancellation, general crash-safe leases, richer resource-class priorities, artwork/subtitle/retention jobs, and measured Pi pressure controls remain future hardening.

## Catalog and administration depth

The browser exposes dependency diagnostics, copyable provider help, manual catalog events, searchable/paginated jobs with structured details, library category grouping, and WebVTT subtitle selection. The TV exposes safe settings, bounded 12-card catalog pages, library categories, searchable/paginated jobs with structured details, filters/sorts, and event triggers. SubDL direct-file support replaces the unusable Subs.ro RAR and subscription-locked OpenSubtitles integrations; physical browser/TV subtitle timing still needs confirmation with a configured SubDL key. Browser Downloads still does not expose pause/resume/retry even though the API and TV download screen support those actions. Ratings, on-demand extended metadata, and complete search/filter/sort coverage across every household collection remain future work.

Automatic browser subtitle selection, persistent prepared-asset reuse, embedded subtitle extraction, and application-rendered Tizen WebVTT cues are implemented with provider error visibility and descriptive candidate labels. Tizen now searches only local contained/server-probed tracks automatically and uses the server-extracted WebVTT path already confirmed in the browser; AVPlay native TEXT selection remains an explicit fallback because its labels/rendering vary by firmware. The previously empty SubDL result was traced to its signed unpack-file URL shape and fixed with a real-response fixture; combined language search, identifier/path validation, credential-query stripping, and archive signature validation are covered locally. Physical TV cue rendering still requires end-to-end confirmation from the new WGT, and automatic playback does not spend provider quota.

## TMDB external-ID classification

The deployed job history exposed 28 clean external-ID lookup misses. Several representative IMDb IDs map to a valid TV record while release-name parsing classified the cached title as a movie, or the reverse. The adapter now treats the parsed kind as a result preference and falls back to the valid movie/TV bucket. Failure errors include requested kind and movie/TV/episode result counts, and job logs include the IMDb ID and kind. IMDb IDs that resolve only to people, individual episodes, or records absent from TMDB can still fail legitimately; episode-to-parent-series enrichment remains future work.
