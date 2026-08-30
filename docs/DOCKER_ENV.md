# Docker environment reference (.env.docker)

`.env.docker` is the single private configuration file for the Docker Compose deployment. Compose reads it to build and run two containers: the streaming server and a qBittorrent sidecar. Copy it from `.env.docker.example`, keep it private, and never commit it. This page documents every variable the Compose file consumes, with its meaning, default, and accepted format. The **Default** column shows the value shipped in `.env.docker.example`.

Run `make docker-validate` (or `python3 tools/docker_env_validate.py .env.docker`) to check the file at any time; every validation run ends by printing the link to this page.

## Quick start

1. Copy the example and restrict it:

   ```bash
   cp .env.docker.example .env.docker
   chmod 0600 .env.docker
   ```

2. Replace the three required absolute paths from the table below, or answer the prompts of `make docker-configure`.
3. Validate the file:

   ```bash
   make docker-validate
   ```

   Fix every `error:` line; `warning:` lines are informational and the command still passes.
4. Build and start the stack:

   ```bash
   make docker-up
   ```

`make docker-up` runs the same validation, creates the host directories, builds both images, waits for healthy containers, and prints the localhost and LAN addresses.

## Required paths

All three are absolute host paths and are required: Compose refuses to start while any of them is empty, and the validator rejects the example placeholders. Put the download root on the large disk.

| Variable | Meaning | Default | Format |
| --- | --- | --- | --- |
| `APP_DATA_DIR` | Host directory mounted at `/var/lib/filelist-streaming/data`; holds `settings.json`, the SQLite catalog, logs, and the artwork and subtitle caches | placeholder | absolute host path |
| `QBITTORRENT_CONFIG_DIR` | Host directory mounted at `/config` in the sidecar; holds the qBittorrent configuration plus the timestamped backups written before each policy merge | placeholder | absolute host path |
| `DOWNLOADS_DIR` | Download root on the large disk; mounted read-write at `/downloads` in the sidecar and read-only into the server. Incomplete pieces are stored in its `.incomplete` child | placeholder | absolute host path |

On Windows hosts use forward-slash paths such as `C:/filelist-streaming/data` or `/mnt/d/filelist-downloads` under WSL 2; see [Installation](INSTALLATION.md).

## Ports and bindings

The web app answers on the server bind address and host port; LAN clients open `http://<server-ip>:8097`. Torrent traffic publishes both TCP and UDP. Host ports are what LAN clients use; container ports are what the sidecar listens on inside the Compose network — the server reaches the Web UI over the internal network using the container port — so change a container port only when you have a reason to.

| Variable | Meaning | Default | Format |
| --- | --- | --- | --- |
| `SERVER_BIND_IP` | Host address the web app binds to | `0.0.0.0` | IPv4 or IPv6 literal |
| `SERVER_HOST_PORT` | Host port for the web app | `8097` | integer 1–65535 |
| `QBITTORRENT_WEBUI_BIND_IP` | Host address for the sidecar Web UI; `127.0.0.1` keeps it on this machine only | `0.0.0.0` | IPv4 or IPv6 literal |
| `QBITTORRENT_WEBUI_HOST_PORT` | Host port for the sidecar Web UI | `8080` | integer 1–65535 |
| `QBITTORRENT_WEBUI_CONTAINER_PORT` | Web UI port inside the sidecar | `8080` | integer 1–65535 |
| `QBITTORRENT_BIND_IP` | Host address for torrent traffic | `0.0.0.0` | IPv4 or IPv6 literal |
| `QBITTORRENT_HOST_PORT` | Host port for torrent TCP/UDP | `6881` | integer 1–65535 |
| `QBITTORRENT_CONTAINER_PORT` | Torrent port inside the sidecar | `6881` | integer 1–65535 |
| `SERVER_INSTANCE_NAME` | Name reported to Tizen server discovery; pick a short household-friendly name | `Living room media server` | non-empty string |
| `TRUSTED_CIDRS` | Client source ranges the server accepts; narrow this to the actual LAN | `127.0.0.0/8,::1/128,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16` | comma-separated CIDRs (IPv4 or IPv6); a bare IPv4 address counts as `/32` |

Everything here assumes a trusted private LAN. Never port-forward any of these ports to the public internet.

## qBittorrent sidecar

The sidecar runs the official qBittorrent image behind a small wrapper. On every start it backs up the existing configuration and merges a credential-free policy: a trusted-network (`0.0.0.0/0`) Web UI authentication bypass plus a benign `admin` username. No username, password, or credential-rotation variable exists or is read — the sidecar is credential-free by design ([ADR-0005](adr/0005-qbittorrent-sidecar-without-auth.md)) — and the validator treats such leftovers as stale (see the migration table below). Because the bypass is unconditional, the Web UI is safe only on the household LAN; never port-forward it, and rely on `make docker-check`, which fails if the Web UI ever demands credentials again.

To use an existing external qBittorrent instead, keep the sidecar untouched and enter its URL, username, and password in browser Settings after startup.

| Variable | Meaning | Default | Format |
| --- | --- | --- | --- |
| `QBITTORRENT_IMAGE` | Base image used to build the sidecar | `qbittorrentofficial/qbittorrent-nox:5.2.3-1` | non-empty image reference |
| `QBT_LEGAL_NOTICE` | Confirms the qBittorrent legal notice on sidecar start | `confirm` | must be exactly `confirm`; anything else is an error |

## Image version, ownership, and locale

| Variable | Meaning | Default | Format |
| --- | --- | --- | --- |
| `FILELIST_STREAMING_VERSION` | Version stamped into the built server image; normally the checked-out release | `0.3.0` | non-empty string |
| `PUID` | UID the containers run as; use your own so the containers own the mounted paths (`id -u`) | `1000` | positive integer |
| `PGID` | GID the containers run as (`id -g`) | `1000` | positive integer |
| `PAGID` | Additional supplemental group IDs for the containers | empty | empty or comma-separated positive integers |
| `UMASK` | File creation mode mask inside the containers | `002` | 1–4 octal digits |
| `TZ` | Time zone for both containers | `Europe/Bucharest` | IANA time zone name |

## FileList credentials

The server starts without FileList credentials, but catalog refreshes, tracker search, and downloads stay limited until they are set; the validator reports this as an informational warning. Sign in at [filelist.io](https://filelist.io), open your profile/account page, and copy the username and the personal passkey. The passkey is **not** your FileList account password; treat it like a password and never commit it.

| Variable | Meaning | Default | Format |
| --- | --- | --- | --- |
| `FILELIST_URL` | Tracker base URL | `https://filelist.io` | `http://` or `https://` |
| `FILELIST_USERNAME` | FileList account username | empty | username from the profile page |
| `FILELIST_PASSKEY` | FileList personal passkey | empty | passkey from the profile page, not the account password |

## TMDB metadata

Optional. Without a key the server still starts; posters, backdrops, localized titles, and synopses stay in their fallback state. Create a [TMDB account](https://www.themoviedb.org/signup) and request API access at [themoviedb.org/settings/api](https://www.themoviedb.org/settings/api). Either the v3 API key or the v4 read access token works; the server detects the form automatically.

| Variable | Meaning | Default | Format |
| --- | --- | --- | --- |
| `TMDB_API_KEY` | TMDB credential for artwork and metadata enrichment | empty | v3 API key or v4 read access token |

## SubDL subtitles

Optional. Without a key the server still starts; online subtitle download is unavailable, while embedded and local subtitles keep working. Create or sign in to a [SubDL account](https://subdl.com) and generate a key in the [API panel](https://subdl.com/panel/api).

| Variable | Meaning | Default | Format |
| --- | --- | --- | --- |
| `SUBDL_URL` | SubDL API base URL | `https://api.subdl.com` | `http://` or `https://`; normally unchanged |
| `SUBDL_API_KEY` | SubDL API key for subtitle download | empty | key from the API panel |

## Playback and storage

Byte values are plain byte counts: 128 MiB is `134217728`. Allocation and reserve are configured in binary gigabytes (GiB) and accept fractional values such as `2.5`. An hourly retention job evicts managed torrents one at a time until the allocation holds and the reserve is met; eviction ordering and protection toggles are described in [Configuration](CONFIGURATION.md).

| Variable | Meaning | Default | Format |
| --- | --- | --- | --- |
| `INITIAL_BUFFER_BYTES` | Bytes read before playback starts | `134217728` | positive integer |
| `READ_AHEAD_BYTES` | Read-ahead window kept ahead of the playback position | `268435456` | positive integer |
| `PIECE_WAIT_TIMEOUT_SECONDS` | How long a range request waits for needed pieces before failing | `600` | positive integer |
| `ALLOCATION_GB` | Ceiling for total managed-download storage | `15` | positive number, fractional GiB allowed |
| `RESERVE_GB` | Free space the download disk must keep | `8` | positive number, fractional GiB allowed |
| `WATCHED_THRESHOLD_PERCENT` | Watched fraction above which a title counts as watched and restarts from the beginning | `90` | integer 0–100 |

## Catalog, cache, and background work

| Variable | Meaning | Default | Format |
| --- | --- | --- | --- |
| `CATALOG_MAX_AGE_HOURS` | Age at which the cached catalog counts as stale and is refreshed | `24` | positive integer |
| `ARTWORK_CACHE_MAX_BYTES` | Ceiling for the cached posters and backdrops | `536870912` | positive integer |
| `SUBTITLE_CACHE_MAX_BYTES` | Ceiling for the downloaded-subtitle cache | `268435456` | positive integer |
| `MAX_CONCURRENT_JOBS` | Background worker slots shared by metadata and subtitle jobs | `10` | positive integer |
| `TITLE_REFRESH_TIMEOUT_MINUTES` | Active execution budget per title refresh | `30` | positive integer |

## Languages

| Variable | Meaning | Default | Format |
| --- | --- | --- | --- |
| `METADATA_LANGUAGE` | Preferred TMDB metadata language | `ro-RO` | non-empty string |
| `METADATA_FALLBACK_LANGUAGE` | TMDB fallback language | `en-US` | non-empty string |
| `PREFERRED_AUDIO_LANGUAGE` | Preferred audio track language | `en` | non-empty string |
| `PREFERRED_SUBTITLE_LANGUAGE` | Preferred subtitle language | `ro` | non-empty string |
| `FALLBACK_SUBTITLE_LANGUAGE` | Subtitle fallback when the preferred language is unavailable | `en` | non-empty string |

## Stale-key migration

Older releases wrote keys that Compose no longer reads. They change nothing at runtime but hide real mistakes, so the validator warns about them and points to this section.

| Removed key | Replacement |
| --- | --- |
| `MAXIMUM_DOWNLOAD_BYTES` | `ALLOCATION_GB` — binary GiB, fractional values allowed |
| `RESERVE_FREE_BYTES` | `RESERVE_GB` — binary GiB, fractional values allowed |
| `QBITTORRENT_USERNAME` | Removed: the sidecar is credential-free (ADR-0005); an external engine takes its username in browser Settings |
| `QBITTORRENT_PASSWORD` | Removed: the sidecar has no password; an external engine takes its password in browser Settings |
| `QBITTORRENT_FORCE_CREDENTIAL_ROTATION` | Removed: there are no sidecar credentials to rotate |

## Troubleshooting

- `make docker-validate` prints one `error:` or `warning:` line per finding and exits 2 when errors exist. Fix each error and run it again; warnings alone still pass.
- Missing file: copy `.env.docker.example` to `.env.docker` or run `make docker-configure`.
- Compose silently ignores variables it does not consume, so a typo or a removed key changes nothing at runtime; the validator flags those and refers to the migration table above.
- A legal-notice error means the sidecar would refuse to boot: set the notice confirmation back to `confirm`.
- After the stack is up, `make docker-check` verifies containers, credential-free Web UI access, and shared storage; `make docker-logs` tails both services.
