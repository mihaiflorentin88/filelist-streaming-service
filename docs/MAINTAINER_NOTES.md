# Maintainer and agent notes

This file records constraints and invariants that must survive context resets and future implementation passes.

## Environment safety

- Do not install software or system packages on a developer workstation without the user's explicit permission. In particular, do not install Node.js locally. Use the pinned frontend Docker image for browser/Tizen tests and builds.
- Compiling the applications is allowed. Runtime and device mutations are separate approval boundaries.
- Raspberry Pi integration testing and deployment must use an explicitly supplied `PI_HOST`; never commit a private username, hostname, IP address, SSH key, provider credential, Tizen certificate, database, log, media file, or generated binary.
- `deploy/bootstrap-server.sh` is for a newly cloned Linux server only. Never run it on a workstation. Routine `make deploy-pi` installs no packages.
- `.env` is a local diagnostic aid only. The daemon must remain browser-configured and persist settings atomically in `data/settings.json` with restrictive permissions.

## Data and provider invariants

- The observed tracker cache is append-only: upsert newer values, but never invalidate or remove older cached releases during refresh or rebuild.
- Normal browsing, library pages, categories, sorting, filters, and pagination read the local cache. FileList is contacted only by an explicit search or a scheduled/manual event job.
- A title-expansion request is suppressed when the title was refreshed less than one hour ago. FileList requests remain serialized even when the global background worker limit is higher.
- Metadata is queued only for visible/searched media and patches clients through SSE. A parsed movie/series kind is a preference during TMDB lookup, not authority; the Find API may return the valid record in the other bucket.
- SubDL has a limited daily quota. Automatic playback searches only torrent-contained and server-probed embedded subtitles. Online provider search requires the explicit **Find online subtitles** action. Prepared subtitle assets are persisted and reused.
- Never claim progressive playback is fixed until a browser and the physical TV have played a valid HTTP 206 response while qBittorrent reports less than 100% completion.

## TV interaction invariants

- Every navigable collection control has stable `data-focus-region`, `data-focus-row`, `data-focus-col`, and `data-focus-key` attributes.
- Read-only TV inputs enter Samsung IME edit mode only after OK. Short Back manages the current UI/sidebar; holding Back for five seconds exits the main application.
- The player preserves logical focus across repeated seek/button actions. Completed media uses server-prepared WebVTT for contained and embedded text streams; Samsung native TEXT tracks are only a labeled fallback.
- Job log entries are buttons: OK expands/collapses the chosen entry, while D-pad navigation keeps every row reachable and scrolls it into view.

## Release and repository rules

- `VERSION` is the release source of truth. It must equal the Tizen package and manifest versions; release tags use `v<VERSION>`.
- Generated web bundles, WGTs, binaries, SBOMs, certificates, runtime data, logs, editor state, and local design scratch files stay ignored.
- Run `make check`, the Docker frontend build, WGT validation, and the secret audit before publishing. GitHub CI repeats unit/compiler/package checks; Security runs Gitleaks, govulncheck, Trivy, CodeQL, actionlint, Zizmor, and dependency review.
- A master push builds the complete release matrix without publishing. Only an exact version tag publishes Linux amd64/arm64/armv7, Windows amd64, macOS amd64/arm64, the unsigned Apps2Samsung WGT, checksums, CycloneDX/SPDX SBOMs, and provenance attestations.

## Next verification/implementation checkpoints

1. Install the new `0.2.0` WGT and confirm contained/embedded server WebVTT subtitles render on the physical TV. Confirm native AVPlay tracks remain selectable only as fallback.
2. On the TV Jobs detail page, D-pad to several log entries, press OK repeatedly to expand/collapse them, inspect long context, load older logs, and return without losing focus.
3. Deploy the matcher fix, retry representative TMDB failures, and confirm valid cross-kind results complete while genuine people/episode/unlisted IDs retain informative result-count errors.
4. Verify the initial GitHub workflows and release artifacts. Treat scanner findings as work to resolve, not checks to silently disable.
5. Continue the remaining items in `KNOWN_ISSUES.md` and the implementation plan, preserving confirmed UX and data invariants above.
