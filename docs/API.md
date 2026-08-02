# HTTP API

The normative contract is [OpenAPI](../api/openapi.yaml); the future event contract is [AsyncAPI](../api/asyncapi.yaml). All stable routes are under `/api/v1`, all JSON fields use lower camel case, and every list page uses `{items,nextCursor,total}`.

## Vertical-slice routes

- `GET /system/info`: version, setup state, and capabilities.
- `GET|PUT /settings`: redacted current settings and atomic file-backed updates; `GET /settings/schema` supplies field help and credential-acquisition guidance without exposing secrets.
- `POST /dependencies/{filelist|qbittorrent|storage|tmdb|subtitles|subdl}/test`: independent diagnostics. `subdl` validates the configured API key against the account endpoint; errors include the provider's sanitized response but never credentials.
- `POST /diagnostics/client`: bounded, trusted-LAN client warning/error reports for TV failures; messages are written to the server log without accepting credentials or arbitrary log levels.
- `GET /catalog/categories`, `/catalog/latest`, `/catalog/search?query=` retain the release-level compatibility contract.
- `POST /catalog/search`: queues the explicit live FileList search only after the user submits a query. It responds `202` immediately with current cache matches and the persistent search job. FileList results are later upserted into the append-only cache, title-expansion jobs are queued, and `catalog.search.completed` tells both clients to refresh from SQLite.
- `GET /catalog/titles`: cache-only canonical movie/show cards with cursor pagination. Supported parameters are `search`, `category`, `kind`, `resolution`, `hdr`, `source`, `codec`, `minSeeders`, `freeleech`, `internal`, `moderated`, `sort`, and `pageSize`.
- `GET /catalog/titles/{id}`: cache-only title details, movie versions, or a show → season → episode → source hierarchy. `POST /catalog/titles/{id}/refresh` queues an explicit tracker job and suppresses another successful refresh for one hour.
- `GET /catalog/facets`: available filter values derived from the cached tracker catalog.
- `GET /catalog/status`: observed/seeded/hidden release counts and the FileList latest-window/history-pagination limitations used by Settings and Events.
- `POST /catalog/sync`: queue either an incremental `latest` sync or a full `rebuild`; the scheduler runs those modes hourly and weekly respectively.
- `POST /metadata/ensure`: queue metadata only for the supplied visible canonical title IDs (maximum 24).
- `GET /artwork/{titleId}/{poster|backdrop}`: bounded, locally cached artwork proxy. Provider paths and credentials are never exposed.
- `POST /releases/{id}/prepare`: add/reuse a torrent, select the largest playable file by default, persist ownership, and return a stream URL.
- `GET /downloads`: reconcile and return server-owned downloads.
- `GET /jobs?search=&state=&kind=&retryable=&updatedHours=&cursor=&pageSize=`: searchable, filterable, cursor-paginated persistent metadata/catalog job history; `GET /jobs/{id}` includes recent structured logs, `GET /jobs/{id}/logs` pages older entries, and `POST /jobs/{id}/retry` requeues a supported terminal job.
- `GET /events`: cold connections receive live events only. A reconnect that supplies `Last-Event-ID` or `after=` receives at most 200 missed journal events before live delivery. Metadata events include the updated card payload so clients do not issue a detail request for every event.
- `POST /downloads/{id}/{pause|resume|retry|remove}`; `deleteFiles=true` is valid only for remove.
- `GET /downloads/{id}/subtitles?language=ro&scope=all`: rank matching candidates without exposing provider secrets. `scope=local` uses only torrent-contained and server-probed embedded streams, `scope=remote` uses configured online providers, and the default `all` combines both. Completed media is probed for embedded track language, title, codec, and dispositions; probe warnings do not discard other results. Successful SubDL searches are cached in process for one hour per media/language query. Tizen automatic selection uses `local`, so it cannot consume provider quota.
- `POST /downloads/{id}/subtitles/prepare`: fetch a selected candidate or extract one embedded text stream, then validate and convert supported text to UTF-8 SAMI or WebVTT. SQLite associations reuse an existing prepared source/provider/candidate/format asset.
- `GET /subtitles/{asset}.{smi|vtt}`: serve the prepared subtitle with the matching MIME type.
- `GET /state`: household favorites, continue-watching, recent, and watched collections.
- `GET /library/{dashboard|continue-watching|favorites|watched|recent}`: canonical household pages available to clients; current clients still hydrate their dashboard from the compatibility `/state` aggregate.
- `PUT|DELETE /library/favorites/{titleId}`: idempotent canonical-title favorites (all versions stay grouped).
- `PUT|DELETE /favorites/{releaseId}`: idempotent release-level favorites.
- `GET|PUT /playback/{sourceId}` and `PUT /playback/{sourceId}/watched`: exact resume and watched state.
- `GET|HEAD /streams/{id}`: full or single-range streaming from requested downloaded pieces. Download responses expose `mimeType`; clients reject containers their video element cannot decode instead of presenting a permanently stalled player.

Errors use `{type,title,status,detail}`. Invalid or multiple byte ranges return 416 and `Content-Range: bytes */<length>`.

Embedded subtitle runtime paths are persisted as absolute `ffprobePath` and `ffmpegPath` settings. The adapter probes and extracts subtitle streams only; it never transcodes video or audio. Prepared subtitle associations are stored in SQLite so the same source/provider/candidate/target format is reused.

Successful torrent removal also removes its managed-download row. Playback history intentionally survives, so a title can remain in Recent or Watched and be prepared again later.

Subtitle settings are persisted in `data/settings.json`. Browser Settings exposes the official SubDL API URL, API key, language preferences, and cache controls with copyable help. Provider secrets remain browser-only; blank secrets retain stored values. Downloads are limited to 12 MiB and must be direct readable subtitle text. ZIP and RAR signatures, binary `.sub` data, unsafe paths, and unsupported formats are rejected; the content is sniffed rather than trusting its extension.

Catalog title IDs are opaque and deterministic. IMDb ID plus media kind is preferred; otherwise the server uses normalized Unicode title, year, and media kind. Release parsing extracts display title, movie/show classification, season/episode, resolution, source, codec, audio, HDR/Dolby Vision, edition, and release group. Tracker category is only a hint because episodic categories can contain movies.

Canonical searches of at least three characters queue tracker work only after explicit submission, return cached matches immediately, permanently upsert eventual results into the observed cache, and then group them. Search queues a persistent, hourly-throttled title-expansion event for every movie or episodic title; season-pack manifests are fetched by that job and playable files become episode sources with an exact `fileIndex`. Ordinary lists, filters, pagination, title details, settings, jobs, and library pages never contact FileList. FileList calls are serialized and capped below the documented 150 requests/hour account limit; explicit 429 responses honor their reset time.

Jobs run under a configurable global ceiling of 10 by default, while FileList has a one-request provider ceiling. Explicit provider rate limits receive bounded inline retries and then move the persistent job to `retry_wait`. Other transient failures receive `failed`, `retryable=true`, and a one-hour next-attempt time. The scheduler retries rate-limited work when due and transient failures hourly. Each attempt records queue, provider, progress, completion, rate-limit, and failure phases in retained structured logs.

`GET /library/categories` returns categories across household-interest media. Add `?category=...` to retrieve full playable household items, including release, selected file index, playback/favorite state, and cached canonical metadata. Empty legacy source IDs fall back to catalog/release identity so unrelated favorites cannot overwrite one another. Cached releases are append-only: sync, search, and rebuild update or add rows but never remove older observations. Zero-seeder releases remain stored and are hidden from ordinary discovery.
