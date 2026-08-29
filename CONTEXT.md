# FileList Streaming

Turns a private-tracker (FileList) catalog into a browsable, streamable home library for a single household on the home LAN, served by a low-power always-on box.

## Language

### Tracker & catalog

**Release**:
One torrent entry on the FileList tracker; the durable source record the catalog mirrors.
_Avoid_: torrent (when talking about catalog data)

**Parsed release**:
The structured interpretation of a Release name: title, Kind, season/episode, quality attributes.

**Quality attributes**:
The technical characteristics parsed from a Release name: resolution, codec, and release class (REMUX, WEB-DL, WEBRIP, ...).
_Avoid_: source

**Kind**:
The media class of a Release: `movie` or `series`. Never inferred from the tracker category alone.

**Category**:
A FileList tracker category ID; a hint that can mislead Kind.
_Avoid_: genre, section

**Canonical title**:
One movie/show identity that groups many Releases (IMDb ID preferred, title+year fallback). The unit the library browses.

**Catalog**:
The append-only local mirror of tracker Releases; rows are never removed.
_Avoid_: library

### Playback

**Managed download**:
A download this server created and tracks. Only Managed downloads are visible or deletable.

**Engine route**:
A persistent pointer to where a torrent lives in the download engine, stable across restarts.

**Prepare**:
Resolve or create the Managed download behind a Source and return its stream URL; the step before any playback.

**Source**:
A playable file entry of a Release — a file inside the torrent, or a virtual per-episode entry.
_Avoid_: "source" for quality attributes (resolution/codec) — say quality attributes

**Progressive playback**:
Playing a torrent before it completes by serving the pieces already on disk.
_Avoid_: streaming (unqualified)

**Direct play**:
Serving original bytes so the client device decodes everything; on both screens for natively playable content.

**Compatibility stream**:
The server-built playback route for browser-hostile audio in a Source: video bytes copied untouched, audio transcoded to AAC. Introduced by ADR-0003, superseding the removed client-side decode.
_Avoid_: browser stream (code name), client decode

### Subtitles

**Subtitle candidate**:
A selectable subtitle offering listed for a download, from any Subtitle source.

**Subtitle source**:
Where a Subtitle candidate came from: `contained` (sidecar file shipped with the torrent), `embedded` (stream inside the media container), `subdl` (fetched from the SubDL provider).
_Avoid_: local/remote as the primary taxonomy

**Subtitle asset**:
Persisted subtitle bytes prepared for one download, identified by an id scoped to that download.

Menus display `contained` — and provider candidates already downloaded — as **Local**, `embedded` as **Built-in**, and providers by their own name.

### Household & jobs

**Household**:
The single server-side profile: favorites, resume positions, watched state. Survives torrent deletion.

**Job**:
A persisted unit of background work with a dedupe key, states, and retries.

### Retention

**Allocation**:
The configured cap on total bytes of the service's stored torrent content, incomplete downloads included.

**Eviction**:
Automatic deletion of a torrent and its files — every Managed download sharing that Engine route — to bring stored content back within the Allocation. Catalog rows and Household state survive.
