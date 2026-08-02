# Development guide

## Local checks

No host dependency installation is required for normal work. Go uses the existing toolchain. Frontend dependencies and Node 24 remain inside the pinned Docker build:

```sh
make check
make frontend
make validate-tizen-wgt
```

`make frontend` runs browser TypeScript/Vite, the Tizen unit tests and compiler, builds both clients, and packages the unsigned Apps2Samsung WGT. Packaging uses Python's standard library only.

## Server builds and Raspberry Pi deployment

```sh
make build
make build-arm64
make deploy-pi
```

`deploy-pi` cross-compiles the ARM64 binary, copies it, the systemd unit, and the logrotate policy to the explicitly supplied `PI_HOST` (for example `user@server.lan`), installs or replaces the service through the deployment script, and restarts it. This changes the server and may invoke `sudo`; use it only when deployment is intended. It does not install packages. The service may use up to 2 GiB, with a 1.5 GiB soft watermark.

## Architecture and contracts

The dependency direction is domain → application ports → adapters, with concrete wiring only in composition. SQLite uses WAL and pure Go. Runtime settings live in an atomically replaced `0600` JSON file; never make runtime behavior depend on `.env`.

Keep [OpenAPI](../api/openapi.yaml), shared TypeScript models, [API documentation](API.md), [architecture](ARCHITECTURE.md), [Known issues](KNOWN_ISSUES.md), and the [Tizen physical-TV log](TIZEN.md) synchronized with behavior. Any confirmed TV result belongs in the log immediately.

The durable environment, provider, cache, TV-focus, and release invariants are in [maintainer and agent notes](MAINTAINER_NOTES.md). Read them before changing or deploying the project. Most importantly: never install tools on a workstation without explicit permission; use the pinned Docker frontend build instead.

## 2026-08-02 Raspberry Pi verification

After deploying the ARM64 server through `make deploy-pi`, the systemd service restarted active with existing settings and SQLite state preserved. Live API checks confirmed:

- append-only coverage reported 2,639 observed releases, 2,543 discoverable seeded releases, and 96 retained zero-seeder releases hidden from discovery;
- a direct `naruto` query reached FileList, upserted its response, and returned 40 canonical media results after default-blacklisted game categories were removed from discovery;
- opening `Star Trek: Strange New Worlds` cached season-pack torrent manifests and produced seasons 1–3 with ten episodes each, season 4 with two available individual episodes, and 160 file-indexed pack sources;
- job search reported a real total of 229 matching metadata jobs and a next cursor instead of truncating the repository scan;
- the settings schema exposed the SubDL direct-file provider and cache controls; provider secrets remained redacted.

Local verification passed Go tests/vet, eight WGT tool tests, both TypeScript/Vite builds, 15 Tizen unit tests, ARM64 compilation, WGT packaging, and offline Apps2Samsung validation. The generated WGT SHA-256 for this checkpoint is `ca993e075854b6c254d5fbe6e245c240970c15aa00403dd951d399e055b4d163`.

### Current latency/subtitle hardening checkpoint

- Cache-backed catalog title IDs, card sources, facets, details, favorites, and household hydration now use targeted SQL instead of loading and regrouping the whole catalog.
- Cold SSE connections are live-only; metadata cards arrive in the event payload. Clients no longer create a detail-request storm, and catalog changes show a stable “updates available” state instead of rearranging the current screen.
- Search contacts FileList only after explicit Submit. It is a persistent asynchronous job, returns cache matches immediately, publishes completion over SSE, and creates append-only upserts plus hourly-deduplicated expansion for every canonical result.
- SubDL provider downloads inspect content signatures instead of trusting extensions and reject ZIP/RAR or binary payloads.
- TV downloadable subtitles are converted to WebVTT and rendered by the application overlay. Timeline D-pad changes are debounced while logical focus stays on the timeline; AVPlay tracks refresh after buffering and when requested.
- A one-slot, timeout-bounded FFmpeg adapter probes completed media and extracts only selected embedded text streams. Prepared assets are associated with source/provider/candidate/format in SQLite and reused. AVPlay native subtitle callbacks render their text in the same overlay, and labels prefer track title plus ISO language from Samsung `extra_info`.
- TMDB community score and vote count are persisted with metadata and exposed to browser/TV rating displays and server-side rating sorts; unrated items remain last.
- The daemon logs to file plus journald, deployment installs log rotation, and the TV event stream uses bounded exponential reconnect with server-side client diagnostics.

The final local artifact for this checkpoint passed 16 Tizen tests, both TypeScript/Vite builds, packaging, and offline Apps2Samsung validation. Its SHA-256 is `04b711c119294b6695693b140159b7787becd1724eb7f9f3b6c98474e40ebdaf`.

The final ARM64 build was deployed to the private-LAN server and restarted active with zero service restarts. The embedded-subtitle checkpoint installed and verified FFmpeg/ffprobe 4.4.2 on the server, exposed both tool paths in the schema, and verified retryability/timeframe Jobs filtering without spending FileList or subtitle-provider quota. Cache-only timings were: Settings 1.5 ms, schema 1.5 ms, facets 123 ms, 24-title page 78 ms, Jobs 4.8 ms, household state 11 ms, and catalog status 4.2 ms. A cold two-second SSE connection received zero replay bytes. The process initially used about 25 MiB RSS; systemd reported `MemoryHigh=1536M` and `MemoryMax=2G`. File JSON logging and the installed logrotate policy were both verified.

An explicit `naruto` search completed in 0.39 seconds after warmup, returned 15 canonical visible titles, and the same cached query completed in 80 ms. Real `[Shinobi] ... Sezonul NN` releases now group as one **Naruto Shippuden** title with 21 seasons and 26 cached sources. Its expansion job found 42 tracker releases, and a second refresh request returned the one-hour throttle result in 61 ms without another FileList call. The former OpenSubtitles JWT and Subs.ro RAR integrations were subsequently replaced by SubDL's direct-file API.

## 2026-08-02 reliability pass

- Background jobs use a configurable global pool (10 by default) and a one-request FileList sublimit.
- Title refresh active execution defaults to 30 minutes; queue and provider-wait time are outside that allowance.
- Explicit HTTP 429 responses are retried briefly, then persisted as `retry_wait` with the provider reset time. Other transient failures are automatically retried hourly.
- Job attempts persist structured phase/context logs, exposed by detail and paginated log endpoints.
- Retrying metadata work now forces a provider attempt instead of immediately accepting an existing cached row.
- Browser and TV settings expose the new controls; both clients refresh a submitted search after its completion event.

Verification completed on the private-LAN Raspberry Pi deployment:

- The ARM64 daemon restarted cleanly with no systemd restarts or warning-level journal entries. It reported about 16 MiB resident memory after startup under the 1.5 GiB soft and 2 GiB hard systemd limits.
- The startup migration retained 3,545 observed releases (3,403 currently discoverable), enabled 10 workers, applied the 30-minute refresh timeout, and preserved existing secrets while adding an unconfigured SubDL key slot.
- Retrying the formerly timed-out `catalog-title-refresh:6WKKs2nwavNH6sqZ5bkf` job completed in about four seconds, found 13 **Star Wars Episode VI Return of the Jedi** releases, and persisted queue/search/completion logs.
- Retrying completed metadata job `metadata:v76k9PnVFy31zBcbnA0O` queued a forced TMDB request and completed with a new attempt and structured logs; it no longer reports “metadata job could not be queued.”
- Submitted **Star Trek Strange New Worlds** search returned two current cache matches in under a second, completed asynchronously with 26 FileList releases, and persisted its tracker-search job/logs.
- Go tests/vet, eight Python package tests, 16 Tizen navigation/player tests, browser/Tizen TypeScript builds, and Apps2Samsung WGT validation passed. The generated `FileListTV-0.2.0.wgt` SHA-256 is `275b3de0ddd63a9520690f3b3866f559623404198095212b1cd551c233bc11bc`.

SubDL could not be exercised against the live provider during this pass because no SubDL key was present in `.env` or stored settings. The official v2 documentation was checked for the Bearer-authenticated search, unpacked direct-file URLs, `format=file` fallback, account test, and rate-limit headers; browser Settings now provides the missing key field and test action.

## 2026-08-02 SubDL and library presentation checkpoint

One quota-conscious live SubDL search was sufficient to reproduce the empty-result defect. The v2 response places the usable parent and file identifiers in each `unpack_files[].url`; the parent subtitle row does not necessarily contain `n_id`, and the returned URL may contain a signed credential query. The adapter now derives both identifiers from the official `dl.subdl.com/subtitle/{parent}/{file}` path, validates their agreement with any explicit fields, discards the query before producing the opaque client candidate ID, and rejects foreign hosts or path traversal. Provider error bodies redact the configured key.

Romanian and English preferences are now sent in one SubDL search rather than two client requests. Successful search results are reused in memory for one hour for the same media/language query, reducing daily quota use. Unit fixtures cover the real signed-URL shape, query stripping, foreign-host rejection, traversal rejection, and language normalization. No subtitle download or second live provider search was performed during this checkpoint.

Managed download DTOs and both clients now show the FileList release name/ID/category, selected torrent file and index, selected/total sizes, parsed source/codec/audio/resolution, tracker seeders, qBittorrent state/progress/speed, and connected peers. Removing a torrent opens an explicit confirmation that distinguishes retaining files from permanently deleting them.

My Library category grouping no longer collapses distinct favorite rows whose legacy source ID is empty. Browser category cards and TV category cards now retain the release and file index needed for playback and show cached artwork/metadata. Dashboard, Continue Watching, Favorites, Recently Viewed, and Watched use stable library cards with bounded progress, a clear resume/play primary action, and dedicated landscape rails so card minimum widths cannot overlap the rail columns.

Local validation passed Go tests/vet, eight WGT packaging tests, both TypeScript/Vite builds, 16 Tizen tests, ARM64 compilation, WGT packaging, and offline Apps2Samsung validation. The WGT SHA-256 is `998fa46ccff42d991ad41249b99542bb35b626a284b069780fbf047cfe7840d1`.

The ARM64 build was deployed to the private-LAN server and restarted active under the existing 1.5 GiB/2 GiB memory limits. Cache-only verification found three managed downloads with the enriched identity fields. The real Anime category returned two distinct playable rows with release IDs, selected file indexes, resume positions, canonical titles, and cached poster routes; Movies 4K returned the watched favorite with its 2022 metadata. The server reports the SubDL key as configured, but no post-deployment provider call was made in order to preserve the user's quota.

## UI implementation rules

The browser and TV share the product hierarchy and design tokens, but not identical density. Browser surfaces may expose advanced server settings. TV settings remain limited to connection and playback/subtitle basics; provider secrets and storage stay browser-only.

Remote focus is structural. Every TV control in a content collection has stable `data-focus-key`, `data-focus-region`, `data-focus-row`, and `data-focus-col` values. Do not return to nearest-rectangle navigation for rails. Player controls preserve a logical last focus even while the overlay is hidden.

## 2026-08-02 release-hardening and TV subtitle checkpoint

- Tizen automatic subtitle discovery now uses the local-only API scope and therefore never consumes SubDL quota. Completed media uses torrent-contained or FFprobe-discovered candidates prepared as server WebVTT; native AVPlay TEXT tracks remain an explicit firmware-dependent fallback.
- The TV Jobs detail list replaced unreachable nested `<details>` controls with D-pad-addressable log buttons. OK expands/collapses job/log IDs, attempt data, and structured context while preserving row focus and scroll behavior.
- A live read-only Pi Jobs query found 28 TMDB no-match failures. The adapter had treated parsed movie/series kind as authoritative and discarded valid records in the other TMDB Find bucket. Kind is now a preference with movie/TV fallback, tests cover both directions, and detailed result counts/IMDb ID/kind are persisted in logs. Individual-episode/person-only matches still require future enrichment.
- Private host/user defaults and generated/runtime/signing material were removed from the publishable tree. `.env.example` contains placeholders; `.env`, settings, databases, media, logs, certificates, binaries, bundles, WGTs, SBOMs, and design scratch stay ignored. A Gitleaks scan of the exact commit candidates found no leaks.
- `VERSION` now controls server linker metadata, Make targets, Tizen artifact names, and release tag validation. The full Docker client build passed 16 TV tests and both Vite builds; Go race tests, vet, nine Python tests, six release cross-builds, actionlint, and a pedantic Zizmor scan passed. The unsigned WGT SHA-256 is `a4d3d6c72d6242020279a0036f1a8d7bde7d575bebd446cd44adede285764adc`.
- GitHub CI/security/release workflows use immutable action commits. Tagged releases produce six server archives plus the WGT, SHA-256 manifest, CycloneDX/SPDX SBOMs, and provenance attestations. The server Docker image now builds and embeds browser assets itself and uses digest-pinned build/runtime bases.

## Release checklist

1. Run `make check`, `make frontend`, and `make validate-tizen-wgt`.
2. Run `git diff --check` and inspect changes for credentials, databases, logs, media, or certificate material.
3. Test the browser against the Raspberry Pi server.
4. Install the new WGT with Apps2Samsung and execute the physical-TV checklist.
5. Keep progressive playback marked unresolved until an actual client plays an HTTP 206 while qBittorrent progress is below 100%.
