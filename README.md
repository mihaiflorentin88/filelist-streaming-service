# FileList Streaming Service

Standalone Go server and Samsung Tizen client for browsing FileList and directly playing compatible media managed by qBittorrent. The server never transcodes audio or video. Playback before download completion is implemented at the HTTP-piece level but remains a documented client playback issue.

## Current milestone

The vertical slice provides browser-managed file-backed settings, FileList latest/search, durable ownership of qBittorrent downloads, download-management APIs and removal controls, household favorites/history/resume state, piece-aware HTTP Range streaming, and a file-cached subtitle service for torrent-contained and SubDL direct-file sources. The Tizen client and release hardening remain under active development; see [architecture](docs/ARCHITECTURE.md), [known issues](docs/KNOWN_ISSUES.md), and [development](docs/DEVELOPMENT.md).

## Local quick start

```bash
go test ./...
go run ./cmd/server
```

Open `http://127.0.0.1:8097`, enter FileList and qBittorrent settings, and save them. Runtime settings are stored in `data/settings.json` with mode `0600`. Browser Settings includes dependency-specific Test buttons and copyable field help. The repository `.env` is for developer diagnostics only and is never read by the application.

The default trusted networks are loopback and RFC1918 private address ranges. Narrow them in Settings when practical. Do not expose this no-login service to the internet.

## Frontend and TV package

`make frontend` builds and tests the browser and Tizen clients in Docker, then creates and validates the unsigned Apps2Samsung artifact at `clients/tizen/.build/artifacts/FileListTV-0.2.0.wgt`. Apps2Samsung signs it for the selected TV during installation. See [the Tizen build and installation guide](docs/TIZEN.md), including the living physical-TV verification log.

## Raspberry Pi deployment

`make deploy-pi PI_HOST=user@server.lan` cross-compiles the ARM64 server, copies it to the selected host, installs or updates the systemd service and logrotate policy, and restarts it. Existing browser-managed settings and the append-only catalog/download database are preserved; a failed service start restores the previous binary. The target operation uses `sudo` and therefore requires explicit approval.

## Server dependencies and fresh-machine setup

| Dependency | Required for | Installation/runtime notes |
| --- | --- | --- |
| Linux with systemd | Daemon isolation and restart | Raspberry Pi OS/Debian/Ubuntu, Fedora/RHEL/Rocky/Alma, Arch, and openSUSE package families are supported. |
| qBittorrent-nox | Torrent ownership, priority, progress, files | Fresh setup binds the Web UI to `127.0.0.1:8080` and uses `/srv/filelist-downloads`. |
| FFmpeg and ffprobe | Embedded subtitle probing/extraction | Subtitle-only use; the server never transcodes video or audio. Paths are browser-configurable. |
| SQLite | Catalog, jobs, playback, ratings, subtitle associations | Embedded through the pure-Go driver; no system SQLite package is required. |
| Exact Go version in `go.mod` | Fresh-clone server build | Installed as a private verified toolchain; system Go is not replaced. |
| CA certificates, curl, tar | Verified toolchain download | Used only for setup/build and HTTPS trust. |
| logrotate | Server log retention | Rotates daily or at 10 MiB and keeps 14 compressed generations. |
| Node.js | Not required at runtime | Frontend builds use the pinned Docker image; assets are embedded in the Go binary. |

For a fresh cloned server only, preview the operation before approving it:

```bash
sudo sh deploy/bootstrap-server.sh --confirm-server-install --dry-run
sudo sh deploy/bootstrap-server.sh --confirm-server-install
```

The idempotent script supports `apt`, `dnf`, `pacman`, and `zypper`. It never changes firewall rules or writes tracker/provider secrets. It creates dedicated service users, configures qBittorrent and the application services, verifies the official Go archive SHA-256, builds locally, and prints the qBittorrent temporary-password journal command. Routine `make deploy-pi` stays package-install-free. Do not run this bootstrap on a workstation or an already configured production Pi.

## Safety boundaries

- No host package installation is part of a normal build.
- Project dependencies are downloaded by Go or pinned build containers.
- Pi service/user/group installation and Tizen device changes require explicit approval.
- A real FileList torrent is never selected automatically for tests.
- Only server-owned torrents persisted in SQLite are exposed in the management UI.

## CI, security, and releases

Every push to `master` runs Go tests/race/vet, browser and TV compiler/tests, WGT validation, and packaging tests. A separate security workflow runs Gitleaks, govulncheck, Trivy, CodeQL, actionlint, Zizmor, and pull-request dependency review; Dependabot checks Go, npm, Actions, and Docker dependencies weekly.

`VERSION` is the single release version. A matching `v<VERSION>` tag builds and publishes Linux amd64/arm64/armv7, Windows amd64, macOS amd64/arm64, and an unsigned Apps2Samsung WGT. Releases also contain SHA-256 checksums, CycloneDX/SPDX SBOMs, and build-provenance attestations. See [maintainer notes](docs/MAINTAINER_NOTES.md) and [security policy](SECURITY.md).
