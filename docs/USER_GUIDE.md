# User guide

## First run

Start the standalone server and open its address in a browser, normally `http://server.lan:8097` on the private LAN. Open **Settings** and enter the FileList username/passkey, qBittorrent Web UI address and credentials, download root, and optional TMDB/SubDL keys. Generate the free SubDL key from the API section of `https://subdl.com/panel`. Save before using the separate live test buttons. The server stores configuration in the file shown at the top of Settings; `.env` is only a developer test aid.

The service has no client login in release 1. Keep it on trusted private CIDRs and do not port-forward it.

## Browse and choose a source

Home begins with Continue Watching, followed by discovery rows. **My Library** separates Continue Watching, Favorites, Watched, Downloads, and a mixed dashboard. **Tracker** provides a dashboard, Browse, Recently Added, Categories, live tracker-backed search, filters, and sorting. The browser rail stays visible; the TV rail collapses after Right returns to content.

Releases are grouped into a canonical movie or show title. A show opens as seasons, episodes, then source versions. A movie shows its versions directly. Each version exposes resolution/source/codec, byte size in B/KB/MB/GB/TB, and seeders so you can make the final choice.

## Playback and downloads

Starting a source adds or reuses a qBittorrent torrent owned by this application. The Downloads page never adopts unrelated qBittorrent torrents. It identifies each item by display title, full FileList release name and ID, category, selected torrent path/index, source/codec/audio/resolution, selected and total sizes, tracker seeders, qBittorrent state, percentage, transferred size, speed, and connected peers. Removal always opens a protected summary: **Remove torrent only** keeps the downloaded data, while **Delete torrent and files** is permanent.

Playback history survives torrent removal. Browser and TV resume state, watched state, favorites, and recent items are server-backed and shared.

The browser player automatically tries the best Romanian-then-English subtitle and exposes an **Off / Subtitles** selector for manual changes. The TV player converts the chosen subtitle to WebVTT and renders cues in a dedicated overlay, avoiding AVPlay external-file inconsistencies. Romanian and fallback English are requested from SubDL together, and a successful result is reused for one hour for the same media query to conserve the provider's daily allowance. On either client, metadata is requested only for visible cards; completed metadata patches the matching card without reordering the page.

My Library cards use their cached canonical title, artwork, year/resolution when available, watched or resume state, and the exact selected file. Selecting a card starts or resumes that stored source. Categories groups only downloaded, watched, in-progress, recently viewed, or favorited media and keeps each distinct media source playable.

Settings provides a `?` control beside each field. Hover for a short explanation or select it to open copyable instructions. Save provider changes, then use the provider-specific Test buttons for live diagnostics. **Fetch latest data** appends or updates the newest tracker records; **Rebuild cache** refreshes each category's API-visible window and reconstructs projections without deleting an older observation. Search contacts FileList only after **Search** is selected. The screen first shows cache matches, then refreshes after the persistent search job permanently grows the cache and queues version/episode discovery. Typing, filtering, sorting, paging, opening details, and visiting Settings/Events/Jobs remain cache-only. Both maintenance actions create visible Jobs entries and are available under Events.

Progressive Range playback is implemented, but playback before completion is not reliable on the current Raspberry Pi/qBittorrent combination. This accepted bug is tracked in [Known issues](KNOWN_ISSUES.md). The Tizen client tries once, shows live progress after AVPlay rejects an incomplete stream, then automatically retries when completion is reported.

## Samsung TV

Build `clients/tizen/.build/artifacts/FileListTV-0.2.0.wgt` with `make frontend`, then install that local file through Apps2Samsung. On first launch, confirm the prefilled server address and select Connect. See [TIZEN.md](TIZEN.md) for Developer Mode, signing, compatibility, and the physical-TV verification log.

In the pending-TV-test 0.2.0 build, Left/Right while controls are hidden is designed to reveal and focus the timeline and seek ten seconds. Repeated Left/Right remains on the timeline; Restart, ±10, and play/pause also retain focus. Up moves to the timeline, Down returns to the last toolbar control, and media keys work independently. Short Back opens/closes the sidebar from the main shell; hold Back for five seconds to exit. Record the physical result in the Tizen log after installation.

## Troubleshooting

- **qBittorrent torrent not found:** the server reconciles a missing owned torrent and removes the stale managed-download row. Refresh Downloads.
- **Playback fails after download:** this is direct play only; choose another container/codec/audio version.
- **No artwork:** configure TMDB; parsed names and generated placeholders remain usable without it.
- **No results:** enter at least three characters and select **Search**. That explicit action queries FileList and stores every returned release. Zero-seeder releases remain cached but are hidden from discovery.
- **Subtitle provider error:** open Settings → Playback and subtitles, verify `https://api.subdl.com`, save a SubDL API key, and run **Test subdl**. The error includes the provider response without exposing the key. Archive payloads are rejected because this integration intentionally accepts only direct subtitle files.
- **Failed background work:** open Jobs, search by title or job ID, and inspect Details for provider, phase, attempt, wait, and error context. Retry is available for any terminal job. Rate-limited jobs resume when the provider reset is due; other transient failures are retried hourly.
- **TV cannot connect:** verify the TV and Pi are on the same LAN and the TV server address includes `http://` and the port.
