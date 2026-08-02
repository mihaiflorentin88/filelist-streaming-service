# Configuration

Configuration is managed in the browser and persisted to `data/settings.json`. The server can start unconfigured so the first-run settings page is always available.

## Required dependencies

- FileList URL, username, and passkey. Never enter the account password.
- qBittorrent Web UI URL, username, password, and the server-visible download root.

Each dependency has a separate diagnostic API route. Browser Settings exposes FileList, qBittorrent, storage, TMDB, and SubDL tests. SubDL uses `https://api.subdl.com`; the public website address is rejected with a corrective error. Every provider field has a hover help icon; selecting it opens copyable credential guidance. Save credentials before testing them. The TV exposes safe playback/subtitle and background-worker settings plus server connection management, while secrets and storage configuration remain browser-only.

SubDL needs an API key generated from the API section of `https://subdl.com/panel`. It provides individual subtitle files, avoiding the RAR response produced by Subs.ro and the paid Consumer API key required by OpenSubtitles. Preferred and fallback languages are combined into one provider search, and successful results are reused for one hour for the same media query to conserve the daily allowance. Signed query parameters returned in unpack-file URLs are stripped from client-visible candidate IDs; authentication is applied only by the server adapter. The repository `.env` remains a developer test aid and is intentionally not imported into runtime settings.

Settings also contains **Fetch latest data** and **Rebuild cache**. Both are append-only. Fetch Latest upserts the newest tracker window; Rebuild refreshes every enabled category's supported latest window and rebuilds local projections over everything ever observed. The FileList API cannot page through all historical releases, so live searches are also an intentional cache-growth path. The same actions are available on Events; latest runs hourly and rebuild weekly.

## Streaming defaults

| Setting | Default |
| --- | ---: |
| Initial buffer | 128 MiB |
| Read-ahead | 256 MiB |
| Piece wait timeout | 600 seconds |
| Managed download ceiling (reserved; not yet enforced) | 15 GiB |
| Free-space reserve (reserved; not yet enforced) | 8 GiB |
| Catalog maximum age | 24 hours |
| Watched threshold | 90% |
| Metadata language | `ro-RO` |
| Metadata fallback language | `en-US` |
| Artwork cache | `data/artwork` |
| Artwork cache ceiling | 512 MiB |
| Concurrent background jobs | 10 |
| FileList concurrent requests | 1 |
| Title refresh active timeout | 30 minutes |

Buffer values are limited to 2 GiB. Retention and free-space enforcement are not implemented yet; the values above are persisted defaults reserved for that phase.

The global job limit and title-refresh timeout are browser-configurable and require a service restart. Queue and rate-limit waiting do not consume the title-refresh execution timeout. FileList stays serialized even when metadata jobs use the other worker slots.

## Metadata

The optional TMDB API key is entered in browser settings and stored only in `data/settings.json`. Blank secret submissions preserve the existing key. Without a key, parsed titles, hierarchy, filters, and source selection remain functional; posters, backdrops, localized titles, and synopses use their fallback states. Clients never call TMDB directly.

## Network boundary

The initial listener is `:8097`; requests are accepted only from loopback and RFC1918 private network ranges. Narrow the trusted CIDRs to the actual LAN when practical. Keep the service behind the home firewall and never port-forward it. Changing the listener requires restart.

## Logs

Structured logs are written to stdout/journald and `data/logs/server.log`. Raspberry Pi deployment installs `/etc/logrotate.d/filelist-streaming`: rotate daily or at 10 MiB, retain 14 archives, compress, and use `copytruncate` so the daemon does not need to reopen the file.
