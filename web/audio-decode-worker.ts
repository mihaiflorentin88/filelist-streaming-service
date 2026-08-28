// Audio decode worker: fetches the progressive stream in byte ranges (the server
// may park a response until torrent pieces arrive, so reads use generous watchdogs
// and retries), buffers a moving window of stream bytes, and decodes each window
// to interleaved stereo f32 PCM via the locally bundled @ffmpeg/core WASM build.
//
// Windowing strategy: sessions that begin past the container-header region prepend
// the first HEADER_BYTES of the file to every window so headered containers
// (matroska in particular) demux correctly; byte-sliced windows decode cleanly for
// matroska, MPEG-TS and elementary streams. MP4 variants whose moov atom is not at
// the file start cannot be windowed and surface as a decode error, like the native
// path failing on them. Core API mirrors the @ffmpeg/ffmpeg internal worker.
import createFFmpegCore from '@ffmpeg/core';
import wasmURL from '@ffmpeg/core/wasm?url';
import type { FFmpegCoreModule } from '@ffmpeg/core';
import { DECODE_CHANNELS, DECODE_SAMPLE_RATE, windowByteBudget } from './audio-decode';
import type { WorkerInMessage, WorkerOutMessage } from './audio-decode';

const FETCH_CHUNK_BYTES = 2 * 1024 * 1024;
const HEADER_BYTES = 2 * 1024 * 1024;
const STALL_TIMEOUT_MS = 120000;
const RETRY_DELAY_MS = 2000;
const RETRY_AFTER_MIN_MS = 2000;
const RETRY_AFTER_MAX_MS = 30000;
const MAX_DECODE_FAILURES = 3;
const WINDOW_FILE = 'window.bin';
const OUTPUT_FILE = 'out.pcm';

let core: FFmpegCoreModule | null = null;
let session = 0;
let sessionAbort: AbortController | null = null;
let paused = false;
let release: (() => void) | null = null;

const scope = self as unknown as { postMessage(message: WorkerOutMessage, transfer?: Transferable[]): void };
function post(message: WorkerOutMessage, transfer: Transferable[] = []) { scope.postMessage(message, transfer) }

function delay(ms: number) {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

async function loadCore() {
  if (core) return;
  const instance = await createFFmpegCore({ locateFile: path => path.endsWith('.wasm') ? wasmURL : path });
  instance.setLogger(event => { if (event.type !== 'info') console.debug('[audio-decode]', event.type, event.message) });
  core = instance;
}

self.onmessage = (event: MessageEvent) => {
  const message = event.data as WorkerInMessage;
  if (message.type === 'start') { void beginSession(message); return }
  if (message.type === 'pause') { paused = true; return }
  if (message.type === 'resume') { paused = false; release?.(); return }
  session++;
  paused = false;
  release?.();
  sessionAbort?.abort();
};

async function beginSession(start: Extract<WorkerInMessage, { type: 'start' }>) {
  session++;
  paused = false;
  release?.();
  sessionAbort?.abort();
  const abort = new AbortController();
  sessionAbort = abort;
  const sessionID = session;
  try {
    await loadCore();
    await runSession(start, sessionID, abort);
  } catch (error) {
    if (abort.signal.aborted || session !== sessionID) return;
    post({ type: 'error', session: sessionID, message: error instanceof Error ? error.message : String(error) });
  }
}

async function runSession(start: Extract<WorkerInMessage, { type: 'start' }>, sessionID: number, abort: AbortController) {
  const windowBytes = windowByteBudget(start.bytesPerSecond);
  // Sessions that would begin inside the container-header region start from byte 0
  // instead; the controller trims the decoded front down to the requested position.
  const begin = start.startByte > 0 && start.startByte < HEADER_BYTES ? 0 : start.startByte;
  let headerBytes: Uint8Array | null = null;
  if (begin > 0) {
    try { headerBytes = await fetchRange(start.url, 0, Math.min(HEADER_BYTES, start.totalBytes) - 1, sessionID, abort) } catch { headerBytes = null }
    if (session !== sessionID) return;
  }
  let fetchPos = begin;
  let decodePos = begin;
  let queued: Uint8Array[] = [];
  let queuedBytes = 0;
  let failures = 0;
  while (session === sessionID && fetchPos < start.totalBytes) {
    if (paused) {
      const gate = Promise.withResolvers<void>();
      release = () => { release = null; gate.resolve() };
      await gate.promise;
    }
    if (session !== sessionID) return;
    const end = Math.min(fetchPos + FETCH_CHUNK_BYTES, start.totalBytes) - 1;
    const chunk = await fetchRange(start.url, fetchPos, end, sessionID, abort);
    if (session !== sessionID) return;
    queued.push(chunk);
    queuedBytes += chunk.length;
    fetchPos += chunk.length;
    if (queuedBytes < windowBytes && fetchPos < start.totalBytes) continue;
    const decoded = decodeWindow(concatBytes(queued, queuedBytes), decodePos, headerBytes, sessionID, start.audioOrdinal);
    queued = [];
    queuedBytes = 0;
    decodePos = fetchPos;
    if (decoded) { failures = 0; continue }
    failures++;
    if (failures >= MAX_DECODE_FAILURES) {
      post({ type: 'error', session: sessionID, message: 'The audio stream in this file could not be decoded.' });
      return;
    }
  }
  if (session === sessionID) post({ type: 'eos', session: sessionID });
}

// One range fetch with the full stall contract: 503 + Retry-After while pieces are
// missing, a watchdog that abandons silent reads, and retries that keep whatever a
// stalled body already delivered (the server can end a response early mid-range).
async function fetchRange(url: string, start: number, end: number, sessionID: number, abort: AbortController): Promise<Uint8Array> {
  for (; ;) {
    if (session !== sessionID) throw new Error('decode session replaced');
    const attempt = new AbortController();
    const relay = () => attempt.abort();
    abort.signal.addEventListener('abort', relay);
    let stalled = false;
    let watchdog = setTimeout(() => { stalled = true; attempt.abort() }, STALL_TIMEOUT_MS);
    try {
      const response = await fetch(url, { headers: { Range: `bytes=${start}-${end}` }, signal: attempt.signal });
      if (response.status === 503) {
        const retryAfter = Number(response.headers.get('Retry-After')) * 1000;
        const wait = Math.min(RETRY_AFTER_MAX_MS, Math.max(RETRY_AFTER_MIN_MS, Number.isFinite(retryAfter) ? retryAfter : RETRY_AFTER_MIN_MS));
        post({ type: 'state', session: sessionID, status: 'stalling' });
        await delay(wait);
        continue;
      }
      if (!response.ok) throw new Error(`stream HTTP ${response.status}`);
      if (!response.body) throw new Error('stream body unavailable');
      const reader = response.body.getReader();
      const parts: Uint8Array[] = [];
      let received = 0;
      for (; ;) {
        let chunk: ReadableStreamReadResult<Uint8Array>;
        try {
          chunk = await reader.read();
        } catch {
          if (!stalled) throw new Error('stream read failed');
          break;
        }
        if (chunk.done) break;
        parts.push(chunk.value);
        received += chunk.value.byteLength;
        clearTimeout(watchdog);
        watchdog = setTimeout(() => { stalled = true; attempt.abort() }, STALL_TIMEOUT_MS);
      }
      if (received === 0) {
        if (session !== sessionID) throw new Error('decode session replaced');
        post({ type: 'state', session: sessionID, status: 'stalling' });
        await delay(RETRY_DELAY_MS);
        continue;
      }
      return concatBytes(parts, received);
    } catch {
      clearTimeout(watchdog);
      if (abort.signal.aborted || session !== sessionID) throw new Error('decode session replaced');
      post({ type: 'state', session: sessionID, status: 'stalling' });
      await delay(RETRY_DELAY_MS);
    } finally {
      abort.signal.removeEventListener('abort', relay);
      clearTimeout(watchdog);
    }
  }
}

// Decode one window to interleaved f32 stereo at the fixed output rate and transfer
// the PCM buffer to the main thread. beginByte is the stream position the window's
// content starts at, so the controller can trim header-region sessions to position.
function decodeWindow(slice: Uint8Array, decodePos: number, headerBytes: Uint8Array | null, sessionID: number, audioOrdinal: number): boolean {
  const instance = core;
  if (!instance) return false;
  const input = headerBytes && decodePos >= headerBytes.length ? concatBytes([headerBytes, slice], headerBytes.length + slice.length) : slice;
  try {
    instance.FS.writeFile(WINDOW_FILE, input);
    instance.exec('-hide_banner', '-loglevel', 'error', '-nostdin', '-i', WINDOW_FILE, '-vn', '-sn', '-dn', '-map', `0:a:${audioOrdinal}`, '-f', 'f32le', '-acodec', 'pcm_f32le', '-ac', String(DECODE_CHANNELS), '-ar', String(DECODE_SAMPLE_RATE), OUTPUT_FILE);
    const code = instance.ret;
    instance.reset();
    if (code !== 0) return false;
    const raw = instance.FS.readFile(OUTPUT_FILE);
    const frames = Math.floor(raw.length / (DECODE_CHANNELS * 4));
    if (frames <= 0) return false;
    const pcm = new Float32Array(raw.buffer, 0, frames * DECODE_CHANNELS);
    post({ type: 'pcm', session: sessionID, data: pcm, frames, beginByte: decodePos }, [pcm.buffer]);
    return true;
  } catch {
    return false;
  } finally {
    try { instance.FS.unlink(OUTPUT_FILE) } catch { }
    try { instance.FS.unlink(WINDOW_FILE) } catch { }
  }
}

function concatBytes(parts: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) { out.set(part, offset); offset += part.length }
  return out;
}
