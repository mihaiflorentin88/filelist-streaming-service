# Progressive Torrent/HTTP Streaming & Seek Prior Art

This document investigates how established open-source projects implement progressive torrent/HTTP streaming with seeking, and documents pitfalls when reading incomplete files from disk in qBittorrent.

---

## 1. anacrolix/torrent (Go)

### Mechanism
- **Core Interface**: Implements `File.NewReader()` / `Torrent.NewReader()` returning a [`torrent.Reader`](https://github.com/anacrolix/torrent/blob/master/reader.go), which satisfies standard Go [`io.ReadSeeker`](https://github.com/anacrolix/torrent/blob/master/reader.go#L44-L54) and `io.ReaderAt`.
- **HTTP Integration**: Works natively with Go's standard library [`http.ServeContent`](https://pkg.go.dev/net/http#ServeContent) by passing the `io.ReadSeeker`. When standard HTTP Range requests (`Range: bytes=start-end`) arrive, `http.ServeContent` invokes `Seek(offset, io.SeekStart)` and reads the requested slice.
- **Priority & Readahead**: 
  - [`SetReadahead(bytes)`](https://github.com/anacrolix/torrent/blob/master/reader.go#L70-L80) sets how many bytes ahead of the current read offset are prioritized with high urgency in the torrent swarm.
  - [`SetResponsive()`](https://github.com/anacrolix/torrent/blob/master/reader.go#L85-L95) enables low-latency streaming by exposing received chunk blocks immediately without waiting for full piece hash verification.

### Seek Strategy
- When a player seeks, `Seek()` updates the reader offset. The reader computes the target piece index, dynamically reprioritizes upcoming pieces within the readahead window, and cancels/lowers priority for abandoned ranges.

### Adoption for This Repo
> Wrap range reads in an adaptive readahead window that prioritizes pieces relative to the requested byte offset rather than relying strictly on sequential ordering.

---

## 2. Stremio Streaming Engine (JS)

### Mechanism
- **Architecture**: Stremio exposes a local HTTP bridge via [`enginefs`](https://github.com/Stremio/enginefs) built atop [`torrent-stream`](https://github.com/mafintosh/torrent-stream/blob/master/index.js).
- **HTTP Range Handling**: Intercepts player `Range: bytes=start-end` headers and invokes `file.createReadStream({ start, end })`.
- **Buffering & Remux**: Serves direct streams when container and codecs are supported by the client; passes through an internal ffmpeg transcoding/remuxing pipeline when container/codec compatibility fails.

### Seek Strategy
- On receiving a byte range seek, `torrent-stream` calculates the target piece range `[startPiece, endPiece]`, assigns **critical priority** to the initial piece chunk, and establishes a forward download window (sliding window buffer) while deselecting distant unrequested pieces.

### Adoption for This Repo
> Use explicit byte-to-piece index mapping on Range requests so seeks immediately elevate the target piece to urgent priority and evict stale readahead requests.

---

## 3. WebTorrent & Peerflix (JS)

### Mechanism
- **WebTorrent HTTP Server**: [`client.createServer()`](https://github.com/webtorrent/webtorrent/blob/master/docs/api.md#server--torrentcreateserveropts) / [`server.js`](https://github.com/webtorrent/webtorrent/blob/master/lib/server.js) creates a Node.js HTTP server supporting `206 Partial Content`.
- **Peerflix**: [`peerflix/app.js`](https://github.com/mafintosh/peerflix/blob/master/app.js) parses `req.headers.range`, sets `Content-Range` and `Content-Length`, and pipes [`file.createReadStream({ start, end })`](https://github.com/mafintosh/torrent-stream/blob/master/index.js#L260-L290) to the HTTP response stream.

### Seek Strategy
- **Sequential + Critical Priority**: By default, WebTorrent maintains sequential piece selection for streaming. When an HTTP range request arrives for offset `N`, pieces covering `N` are marked with maximum priority (`critical: true`), bumping pending background sequential pieces in the download queue.

### Adoption for This Repo
> Provide a streaming HTTP endpoint that maps incoming `Range` headers to dynamic piece priorities, falling back to sequential download when no active seek range is pending.

---

## 4. qBittorrent: Reading Incomplete Files Directly from Disk

When an external process (e.g., Go media server) reads incomplete torrent files on disk while qBittorrent downloads them:

### Known Pitfalls & Mechanics
1. **`.!qB` Extension Renaming**:
   - qBittorrent configuration option `Append .!qB extension to incomplete files` appends `.!qB` until 100% completion ([qBittorrent Options](https://github.com/qbittorrent/qBittorrent/wiki/WebUI-API-(qBittorrent-4.1))).
   - When a download completes, qBittorrent renames the file. On Windows, active open file handles will fail or prevent rename (`ERROR_SHARING_VIOLATION`); on Linux, the process continues reading from an unlinked inode unless re-opened.
2. **Sparse Files vs. Preallocation**:
   - Without preallocation, files are sparse. Non-downloaded regions return zero bytes (`0x00`) immediately instead of blocking. Media players reading uncompleted byte ranges encounter EOF or corrupt headers.
   - With preallocation (`preallocate_files`), the file size is reserved, but non-downloaded blocks still contain unwritten zero blocks or unverified data.
3. **File Locking on Windows**:
   - qBittorrent / libtorrent opens files with write access. Readers must open files with `FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE` to prevent sharing collisions.
4. **Lack of Dynamic Seek Triggering in WebAPI**:
   - qBittorrent's WebAPI only offers [`toggleSequentialDownload`](https://github.com/qbittorrent/qBittorrent/wiki/WebUI-API-(qBittorrent-4.1)#toggle-sequential-download) and [`toggleFirstLastPiecePrio`](https://github.com/qbittorrent/qBittorrent/wiki/WebUI-API-(qBittorrent-4.1)#toggle-first-and-last-piece-priority).
   - The underlying libtorrent engine supports [`set_piece_deadline()`](https://libtorrent.org/reference-Torrent_Handle.html#set_piece_deadline()), but qBittorrent WebUI does not expose arbitrary piece deadline/priority setting over HTTP. As a result, reading incomplete files directly from disk cannot tell qBittorrent to seek its download focus to a new offset.

### Adoption for This Repo
> Account for the `.!qB` extension check, verify that target piece ranges are downloaded before reading from disk, and enforce shared read permissions to prevent OS file locking issues.

---

## 5. Comparative Summary

| Project / Ecosystem | Range/Seek Mechanism | Piece Priority Strategy | Direct Disk Reading | Primary Source Links |
| :--- | :--- | :--- | :--- | :--- |
| **anacrolix/torrent** (Go) | `io.ReadSeeker` + `http.ServeContent` | Readahead window (`SetReadahead`) + fast chunks (`SetResponsive`) | Internal storage abstraction | [reader.go](https://github.com/anacrolix/torrent/blob/master/reader.go) |
| **Stremio Engine** (JS) | `enginefs` + `createReadStream` | Critical piece priority on seek + sliding buffer | Internal engine cache | [torrent-stream](https://github.com/mafintosh/torrent-stream), [enginefs](https://github.com/Stremio/enginefs) |
| **WebTorrent / Peerflix** (JS) | `client.createServer()` / `Range` handler | Sequential base + urgent priority on requested range | In-flight torrent storage | [webtorrent server.js](https://github.com/webtorrent/webtorrent/blob/master/lib/server.js), [peerflix app.js](https://github.com/mafintosh/peerflix/blob/master/app.js) |
| **qBittorrent + libtorrent** (C++/API) | WebAPI sequential toggle (`seq_dl`) | `set_piece_deadline` (internal C++ only; not exposed in WebUI) | Direct disk file (`.!qB` suffix, sparse holes) | [libtorrent docs](https://libtorrent.org/reference-Torrent_Handle.html#set_piece_deadline()), [qB WebUI API](https://github.com/qbittorrent/qBittorrent/wiki/WebUI-API-(qBittorrent-4.1)) |
