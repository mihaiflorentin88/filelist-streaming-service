# Eviction is user-configured; protections are toggles, not guarantees

---
status: accepted
---

The release-1 plan hard-coded "never evict incomplete or actively streamed media"; the 2026-08-29 grill session reversed that. The server automatically deletes Managed-download torrents — through the download engine, files included, season-pack siblings dying with the torrent — to bring stored content back within the Allocation (the configured byte cap on the service's qBittorrent category), or when live free space on the download volume drops below the reserve, whichever trips first. Eviction order is a user-composed rule list (default: oldest completed first), and the only safeguards are user toggles — incomplete, actively-streamed (leased), favorites, never-watched — defaulting on only for incomplete and actively-streamed. A new download that cannot fit after evicting everything unprotected is rejected with a visible error rather than overflowing the cap.

## Considered options

- **Soft cap (download anyway, absorb the overflow)** — rejected: silently defeats the allocation and can fill the disk.
- **Hard protection floor for incomplete + leased** (the plan doc's position) — rejected in favor of user control; the defaults preserve the safe behavior.

## Consequences

- A mis-toggled protection can evict the torrent currently being watched or downloaded. Eviction runs only through Managed downloads, so torrents foreign to this service are never counted or touched.
- Catalog rows and Household state (favorites, resume positions, watched state) survive eviction by construction.
