# Known issues

## Tizen 0.2.0 navigation, reconnection, and performance need physical-TV verification

The 0.1.3 Smart Remote input path is confirmed on the target S90C. Version 0.2.0 replaces nearest-geometry navigation with explicit regions, rows, columns, and stable focus keys. Vertical movement stays in the closest column, Left from the first content column opens the sidebar, Right returns to the exact content control, and player dialogs restore their launcher. The rail moves with a short compositor transform, card focus no longer scales heavy artwork, and each catalog page is limited to 12 cards with targeted metadata patching. Inputs open Samsung IME only after OK enters edit mode. SSE reconnect now uses bounded exponential backoff and can report failures to the daemon log. The Docker test/build passes, but smoothness, reconnection, and revised behavior still need confirmation on the physical TV.

## Playback before torrent completion

The server maps HTTP byte ranges to qBittorrent pieces and does not intentionally wait for the whole torrent. On the current Raspberry Pi, however, browser and Tizen playback are only verified reliably after qBittorrent reports the selected file complete. Playback before completion remains an open phase-3 defect.

The recovery introduced in Tizen 0.1.5 and retained in 0.2.0 attempts progressive playback first. If AVPlay reports a connection/preparation failure while the managed download is incomplete, the player closes the failed AVPlay session, displays live qBittorrent progress, and retries exactly once when completion is reported. This is recovery, not a claim that streaming while downloading is fixed. A future fix must demonstrate a valid HTTP 206 and actual client playback while progress is below 100%.

## Direct-play compatibility

The server does not transcode. A source whose container, video, audio, profile, or subtitle format is unsupported by the browser or TV may still fail after download; compatibility probing and source ranking remain later work.

## Catalog metadata coverage

Canonical release parsing, IMDb-backed TMDB title metadata, persisted TMDB community rating/vote data, and on-demand season-pack file expansion are implemented. Episode-level TMDB artwork/descriptions, cast/runtime/genres, compatibility probing, and scoped cache-management controls remain incomplete. Releases without IMDb IDs use parsed fallback titles and generated client placeholders. FileList does not expose historical pagination, so the append-only cache becomes progressively more complete through latest sync, rebuild windows, searches, and title expansion rather than claiming an immediate full-tracker import.

## Background jobs still need dispatcher hardening

Metadata, tracker-search, and catalog jobs are persisted and visible as queued, running, retry-waiting, completed, or failed. Structured attempt logs, terminal-job retry, rate-limit-aware waits, hourly transient retry, explicit reconnect event-journal replay, SSE updates, manual latest/rebuild actions, hourly/weekly schedules, and restart recovery are implemented. The global worker ceiling defaults to 10 and FileList remains serialized. Cancellation, general crash-safe leases, richer resource-class priorities, artwork/subtitle/retention jobs, and measured Pi pressure controls remain future hardening.

## Catalog and administration depth

The browser exposes dependency diagnostics, copyable provider help, manual catalog events, searchable/paginated jobs with structured details, library category grouping, and WebVTT subtitle selection. The TV exposes safe settings, bounded 12-card catalog pages, library categories, searchable/paginated jobs with structured details, filters/sorts, and event triggers. SubDL direct-file support replaces the unusable Subs.ro RAR and subscription-locked OpenSubtitles integrations; physical browser/TV subtitle timing still needs confirmation with a configured SubDL key. Browser Downloads still does not expose pause/resume/retry even though the API and TV download screen support those actions. Ratings, on-demand extended metadata, and complete search/filter/sort coverage across every household collection remain future work.

Automatic browser subtitle selection, persistent prepared-asset reuse, embedded subtitle extraction, and application-rendered Tizen WebVTT cues are implemented with provider error visibility and descriptive candidate labels. Tizen now searches only local contained/server-probed tracks automatically and uses the server-extracted WebVTT path already confirmed in the browser; AVPlay native TEXT selection remains an explicit fallback because its labels/rendering vary by firmware. The previously empty SubDL result was traced to its signed unpack-file URL shape and fixed with a real-response fixture; combined language search, identifier/path validation, credential-query stripping, and archive signature validation are covered locally. Physical TV cue rendering still requires end-to-end confirmation from the new WGT, and automatic playback does not spend provider quota.

## TMDB external-ID classification

The deployed job history exposed 28 clean external-ID lookup misses. Several representative IMDb IDs map to a valid TV record while release-name parsing classified the cached title as a movie, or the reverse. The adapter now treats the parsed kind as a result preference and falls back to the valid movie/TV bucket. Failure errors include requested kind and movie/TV/episode result counts, and job logs include the IMDb ID and kind. IMDb IDs that resolve only to people, individual episodes, or records absent from TMDB can still fail legitimately; episode-to-parent-series enrichment remains future work.
