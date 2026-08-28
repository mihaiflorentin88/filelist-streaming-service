# Subtitle playback architecture

This document records the working subtitle pipeline and the preservation constraints used while adding saved preferences and automatic fallback. Keep these boundaries intact when changing either client.

## Discovery

`GET /api/v1/downloads/{id}/subtitles` is the only discovery entry point. Its `scope` is `local`, `remote`, or `all`.

- Local discovery asks qBittorrent for subtitle files belonging to the selected episode, then optionally probes a completed local media file for embedded subtitle tracks.
- Remote discovery queries each configured provider independently. A provider failure is returned as a warning and does not hide candidates from other providers.
- The service ranks included subtitles above embedded tracks and online results. Exact requested-language matches receive an additional score. When the requested language matches the configured primary language, the configured fallback language is also admitted.
- Subtitle discovery never blocks ordinary library or download listing. Embedded probing is attempted only when the selected media file exists locally.

## Preparation and cache

`POST /api/v1/downloads/{id}/subtitles/prepare` prepares one candidate as SAMI or WebVTT.

- Included torrent subtitles are read through the same progressive range strategy as media; this retains the qBittorrent streaming behavior.
- Embedded subtitles are extracted by the configured media probe only after the media file is locally available.
- Online candidates are downloaded by their provider adapter.
- ZIP payloads are safely unpacked, the best matching subtitle file is selected, and supported formats are converted to UTF-8 WebVTT or SAMI.
- The converted result is content-addressed and written below `subtitleCachePath`. Its database row is keyed by source, provider, candidate, and target format. A later identical request reuses that file and only refreshes its last-used timestamp.
- Cache pruning respects `subtitleCacheMaxBytes`. Subtitle asset URLs expose only validated asset identifiers; provider credentials and filesystem paths are never returned.

## Preferences and automatic fallback

Playback preferences are stored per managed source in SQLite. They record audio language/index plus subtitle language, mode (`auto`, `selected`, or `off`), provider, and candidate ID. A new source inherits the configured defaults: English audio and Romanian subtitles with English fallback.

When either player opens it first tries a remembered exact choice, then local Romanian and English candidates. If no usable local subtitle exists, it performs a remote English search, prepares the first usable result, and persists the candidate. Preparation is cache-backed, so later playback reuses the converted subtitle rather than downloading it again. Choosing **Off** or another track overrides automatic behavior for that source. Auto-next carries the language/mode intent but clears an episode-specific candidate ID.

## Web playback

The browser tries ranked candidates in order, prepares the first usable one as WebVTT, and attaches it as a generated `<track>`. A user can disable subtitles or choose another ranked candidate. The server probes the original file's audio tracks, and the browser plays the single progressive stream directly: codecs the browser handles natively play from the video element, while AC3/EAC3/DTS-class audio is decoded client-side by the WASM decoder — the server never transcodes (see `docs/adr/0001`). Seeks and audio changes reuse the same stream, so prepared cue times stay aligned with the original file's timeline. Playback position uses the original duration and is saved every ten seconds, on pause, and at completion.

## Tizen playback

AVPlay native text tracks remain available as a fallback. The Tizen client also requests local candidates, prepares the selected item as WebVTT, parses cues in the app, and renders the current cue itself. This path is deliberate: it avoids device-specific instability in AVPlay external subtitle loading. If no local or native Romanian/English track is usable, the client automatically requests and caches an English online result. Subtitle delay is applied in the cue lookup, while native-track delay uses AVPlay.

## Preservation constraints

- Do not replace Tizen's parsed-WebVTT overlay with an unverified AVPlay external-subtitle path.
- Keep local discovery independent from online provider availability and rate limits.
- Reuse prepared subtitle assets instead of downloading the same candidate again.
- Preserve per-provider warnings and continue trying other ranked candidates.
- Never expose provider keys, qBittorrent credentials, or subtitle cache filesystem paths to either client.
