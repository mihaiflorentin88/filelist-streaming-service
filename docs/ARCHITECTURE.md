# Architecture

## Dependency direction

`internal/domain` contains data types. `internal/application` contains use cases and declares ports. Inbound HTTP and outbound FileList, qBittorrent, and SQLite adapters implement those ports. `internal/composition` is the only package that chooses concrete adapters.

The server starts the essential HTTP surface before any future background synchronization. SQLite is configured for WAL, a five-second busy timeout, foreign keys, and a four-connection ceiling suitable for the Raspberry Pi.

## Canonical catalog and metadata

Tracker releases remain the durable source records. Every upsert also writes a parsed `catalog_releases` projection containing the canonical title ID and display/technical fields. Existing databases are backfilled on startup, so the migration does not require a destructive rebuild or a fresh FileList request.

The grouped API derives movies and series from that projection and exposes a show → season → episode → source hierarchy. IMDb identity is preferred for grouping; normalized Unicode title/year/kind is the offline fallback. The parser deliberately does not infer media kind from category alone.

TMDB enrichment is optional. Cached metadata is returned immediately. Clients explicitly ensure metadata for at most 24 visible titles, and an SSE completion event carries the updated card so the screen can patch in place; pagination no longer queues the entire catalog. Title-detail requests are cache-only and never block on TMDB. Romanian (`ro-RO`) is preferred, English (`en-US`) fills missing fields, and the original title is retained. Provider image paths stay server-side; clients receive same-origin artwork URLs whose responses are size-limited and atomically cached below `data/artwork`.

The application layer declares a tracker-neutral `Tracker` port and capability description. FileList is the first adapter. Only explicit submitted searches and background event jobs call the tracker. Submitted searches are persistent asynchronous jobs: the HTTP request returns cached matches immediately, the worker permanently merges every eventual result into SQLite, queues expansion for each canonical title, and publishes an SSE completion event. Successful title expansion is suppressed for one hour. All ordinary navigation, filters, pagination, title details, settings, jobs, and library reads use SQLite only. FileList requests are serialized, throttled, and bounded to 140 per rolling hour. Hourly latest sync and weekly/manual rebuild only upsert: old observations are never deleted. Rebuild refreshes each enabled category's API-visible latest window and reconstructs projections over all retained rows; it cannot retrieve never-observed historical releases because the supported FileList API has no history pagination. Zero-seeder rows remain durable but are excluded from discovery.

Title-expansion jobs download each unseen season-pack `.torrent`, parse bounded bencoded metainfo without adding it to qBittorrent, validate paths, and store the playable file manifest in SQLite. Detail navigation only reads those cached manifests. Episode parsing creates virtual sources carrying `fileIndex`, path, and file size so preparation selects the requested episode rather than the whole pack.

## Runtime configuration

The browser reads and updates `/api/v1/settings`. The server atomically replaces `data/settings.json` through a same-directory temporary file and enforces mode `0600`. Empty secret fields preserve an existing value. Responses never return stored secret values; they return `...Configured` booleans instead.

Listener, database-path, maximum-concurrent-job, and title-refresh-timeout changes are saved but require restart. Dependency clients read current settings for every authentication cycle, so FileList, qBittorrent, TMDB, and SubDL settings take effect without restart.

`.env` is deliberately outside the runtime configuration system. It exists only for developer-controlled diagnostics.

## Torrent ownership

Adding a source creates a durable `downloads` row containing a stable source ID, FileList release ID, `qb:<info-hash>` engine route, selected qB file index/path, global file offset, absolute contained path, size, piece size, state, progress, lease, errors, and timestamps.

The UI lists and manages these rows rather than enumerating all qBittorrent content. This prevents the application from adopting or deleting unrelated torrents. On restart, status is reconciled from qB using the persisted engine route.

## Progressive playback

Playback does not wait for completion:

1. Download the `.torrent` metadata and calculate its canonical SHA-1 info hash.
2. Add it to qB with sequential download and first/last-piece priority enabled.
3. Select priority `7` for the requested video and contained subtitle files; set unrelated files to priority `0`.
4. Re-read `seq_dl` and `f_l_piece_prio`, toggling either only when currently disabled.
5. Convert a requested HTTP file byte range into global torrent piece indexes using the file offset and qB piece size.
6. Read `piece_size` from `torrents/properties` (qBittorrent 4.3.x does not include it in `torrents/info`) and poll `pieceStates` until only the requested pieces report state `2`, independent of overall progress.
7. Before committing HTTP headers, verify the configured daemon account can open the growing file and read the final byte in the requested startup range. This turns mount/path/permission failures into a visible 503 diagnostic rather than a broken 206 response.
8. Read the corresponding range from the growing file and return HTTP 206 with correct Range headers and an explicit media content type.

The server waits for a maximum 128 MiB startup window or the smaller client-requested range, then uses bounded 256 MiB read-ahead windows. Multiple ranges return 416 in release 1. Disconnect cancellation is normal and releases the persisted stream lease.

The qB endpoints and field semantics follow the official [qBittorrent WebUI API](https://github.com/qbittorrent/qBittorrent/wiki/WebUI-API-%28qBittorrent-4.1%29): torrent contents/file priorities, piece states, sequential download, and first/last-piece priority.

qBittorrent 4.3.x add responses are accepted on any 2xx status unless the response explicitly contains `Fails.`; some builds return an empty success body rather than `Ok.`. A `Fails.` response is treated as a duplicate only when a follow-up lookup confirms the exact calculated info hash already exists; that torrent is then reused and recorded as managed.

## Household state

Release 1 uses one server-side `household` profile while retaining `profile_id` for later profiles. Favorites use canonical title IDs so every release version of a movie or show stays grouped; startup migration maps older release-keyed favorites to their canonical title. Playback records retain release/file identity, exact millisecond position, duration, watched state, and update time. They intentionally outlive download rows so removing a torrent does not erase viewing history. Browser video and Tizen AVPlay update the same records approximately every ten seconds and on lifecycle boundaries; the server, not the client, applies the configured watched threshold.

## Persistent jobs and events

SQLite owns durable catalog, title-expansion, tracker-search, and metadata job state with deduplication keys and `queued`, `running`, `retry_wait`, `completed`, or `failed` state. The global execution ceiling defaults to 10; a separate one-slot FileList gate preserves tracker ordering and rate safety. A title refresh receives 30 minutes of active execution by default after acquiring its slots, so queue/rate waiting is excluded. Explicit HTTP 429 responses receive short bounded retries and persist the provider reset time when the wait is longer. Other transient failures are marked retryable and retried automatically every hour. Terminal jobs can also be retried manually, including completed metadata work, which deliberately bypasses the cached-success short circuit.

Each job attempt appends structured phase logs to `job_logs`; the newest 500 entries per job and 30 days globally are retained. Details and paginated older logs are available in both clients without exposing credentials. State transitions and metadata/catalog/search completion are appended to `event_journal` and broadcast live. Cold SSE connections do not replay history; reconnect clients may request at most 200 missed events with `Last-Event-ID` or `after=`. Cancellation and general crash-safe leases remain future hardening.

## Logging and resource envelope

The server writes structured JSON to both stdout/journald and `data/logs/server.log`. The Pi deployment installs a daily/10 MiB logrotate rule retaining 14 compressed rotations. Trusted TV clients may report bounded warning/error diagnostics through the HTTP API. The systemd unit uses a 1.5 GiB soft memory watermark and a 2 GiB hard ceiling; these are guardrails, not an application heap target.

## Security model

Release 1 has no client login. Remote addresses must fall within the configured trusted CIDRs; forwarded-address headers are ignored. FileList passkeys, Basic headers, torrent download URLs, qB credentials, settings contents, and absolute media paths are never returned to clients or written to normal logs.

All torrent paths combine qBittorrent's reported `save_path` with its file path, are resolved beneath the configured download root, and are rejected if the result escapes it. The production service runs as `filelist-streaming` with supplementary membership in the `qbittorrent` group so it can traverse and read the download tree; creating that account and group membership is approval-gated.
