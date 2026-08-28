// — Worker-level contract tests. The worker module reads `self` at import time
// to bind its message port, so the tests stub `self` in beforeEach and only then
// import the module: a static import would execute the module at file load,
// before the stub exists. This is an intentional module-loading boundary
// exercise. @ffmpeg/core is replaced with a deterministic fake whose decoder
// yields floor(bytes / 8) stereo f32 frames for any input, which makes
// "measured header audio" and "bitrate estimate" produce observably different
// PCM frame counts. fetch is scripted per test to exercise the stall contract
// (503 + Retry-After), permanent 4xx, and transient 5xx.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const HEADER_BYTES = 2 * 1024 * 1024;
const WINDOW_BYTES = 16 * 1024 * 1024;
const FRAMES_PER_BYTE = 1 / 8;
const BPS = 1_347_057;

type PostedMessage = { type: string; session?: number; frames?: number; beginByte?: number; message?: string };
const posted: PostedMessage[] = [];
const scope: { postMessage: (message: PostedMessage, transfer?: Transferable[]) => void; onmessage: ((event: { data: unknown }) => void) | null } = {
  postMessage: message => { posted.push(message) },
  onmessage: null,
};

const harness = vi.hoisted(() => {
  const state: { execs: { inputBytes: number }[]; failHeaderAlone: boolean } = { execs: [], failHeaderAlone: false };
  class FakeFS {
    #files = new Map<string, Uint8Array>();
    writeFile(name: string, data: Uint8Array) { this.#files.set(name, data) }
    readFile(name: string): Uint8Array {
      const file = this.#files.get(name);
      if (!file) throw new Error(`no such file: ${name}`);
      return file;
    }
    unlink(name: string) { this.#files.delete(name) }
  }
  class FakeCore {
    FS = new FakeFS();
    ret = 0;
    setLogger() { }
    reset() { this.ret = 0 }
    exec(...args: string[]) {
      const input = this.FS.readFile(args[args.indexOf('-i') + 1]);
      const output = args[args.length - 1];
      state.execs.push({ inputBytes: input.length });
      if (state.failHeaderAlone && input.length === 2 * 1024 * 1024) { this.ret = 1; return }
      this.ret = 0;
      this.FS.writeFile(output, new Uint8Array(Math.floor(input.length / 8) * 8));
    }
  }
  return { state, createCore: () => new FakeCore() };
});

vi.mock('@ffmpeg/core', () => ({ default: () => Promise.resolve(harness.createCore()) }));

type FakeResponse = { ok: boolean; status: number; headers: { get(name: string): string | null }; body: { getReader(): { read(): Promise<{ done: boolean; value?: Uint8Array }> } } | null };
let responses: ((call: number, start: number, end: number) => FakeResponse) | null = null;
const calls: { start: number; end: number }[] = [];

function body(bytes: Uint8Array): NonNullable<FakeResponse['body']> {
  let served = false;
  return { getReader: () => ({ read: async () => { if (served) return { done: true }; served = true; return { done: false, value: bytes } } }) };
}

function errorResponse(status: number, retryAfter: string | null = null): FakeResponse {
  return { ok: false, status, headers: { get: () => retryAfter }, body: null };
}

function fullResponse(start: number, end: number): FakeResponse {
  const bytes = new Uint8Array(end - start + 1);
  for (let i = 0; i < bytes.length; i++) bytes[i] = (start + i) % 251;
  return { ok: true, status: 206, headers: { get: () => null }, body: body(bytes) };
}

async function drain(ms = 1000) {
  await vi.advanceTimersByTimeAsync(ms);
}

function startSession(overrides: Record<string, unknown> = {}) {
  scope.onmessage!({
    data: {
      type: 'start',
      session: 1,
      url: 'http://server.test/api/v1/streams/x',
      startByte: 4 * 1024 * 1024,
      totalBytes: 36 * 1024 * 1024,
      bytesPerSecond: BPS,
      audioOrdinal: 0,
      ...overrides,
    },
  });
}

beforeEach(async () => {
  posted.length = 0;
  calls.length = 0;
  harness.state.execs = [];
  harness.state.failHeaderAlone = false;
  responses = (_call, start, end) => fullResponse(start, end);
  vi.stubGlobal('self', scope);
  vi.stubGlobal('fetch', (_url: string | URL, init?: RequestInit) => {
    const match = /bytes=(\d+)-(\d+)/.exec(String(new Headers(init?.headers).get('Range')));
    const call = calls.push({ start: Number(match![1]), end: Number(match![2]) }) - 1;
    return Promise.resolve(responses!(call, Number(match![1]), Number(match![2])));
  });
  vi.spyOn(console, 'debug').mockImplementation(() => { });
  vi.useFakeTimers();
  await import('./audio-decode-worker');
});

afterEach(() => {
  scope.onmessage!({ data: { type: 'stop' } });
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('Measured header-audio trim', () => {
  it('drops the measured header audio from prepended windows, not a bitrate estimate', async () => {
    startSession();
    await drain();
    const pcms = posted.filter(message => message.type === 'pcm');
    expect(pcms).toHaveLength(2);
    // Window input = 2 MiB header + 16 MiB content; the fake core yields
    // floor(bytes/8) frames, so the content-only expectation is 16 MiB / 8.
    expect(pcms[0].frames).toBe(Math.floor(WINDOW_BYTES * FRAMES_PER_BYTE));
    expect(pcms[0].beginByte).toBe(4 * 1024 * 1024);
    expect(pcms[1].frames).toBe(Math.floor(WINDOW_BYTES * FRAMES_PER_BYTE));
  });

  it('measures the header region exactly once per session', async () => {
    startSession();
    await drain();
    const standalone = harness.state.execs.filter(entry => entry.inputBytes === HEADER_BYTES);
    expect(standalone).toHaveLength(1);
    // Two windows decode as header+content blobs, nothing else runs.
    expect(harness.state.execs).toHaveLength(3);
  });

  it('keeps the session alive when the header region cannot be decoded alone', async () => {
    harness.state.failHeaderAlone = true;
    startSession();
    await drain();
    const pcms = posted.filter(message => message.type === 'pcm');
    expect(pcms).toHaveLength(2);
    // Nothing measured means nothing dropped: the windows play complete.
    expect(pcms[0].frames).toBe(Math.floor((HEADER_BYTES + WINDOW_BYTES) * FRAMES_PER_BYTE));
    expect(posted.filter(message => message.type === 'error')).toHaveLength(0);
  });
});

describe('Range fetch retry hygiene', () => {
  it('surfaces permanent 4xx answers as an immediate session error', async () => {
    responses = () => errorResponse(404);
    startSession();
    await drain(10_000);
    expect(calls).toHaveLength(1);
    const errors = posted.filter(message => message.type === 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain('stream HTTP 404');
  });

  it('retries transient 5xx answers a bounded number of times, then fails loudly', async () => {
    responses = () => errorResponse(500);
    startSession();
    await drain(60_000);
    expect(calls).toHaveLength(3);
    expect(posted.filter(message => message.type === 'error')).toHaveLength(1);
  });

  it('keeps the 503 piece-wait contract open until pieces arrive', async () => {
    let fifties = 0;
    responses = (_call, start, end) => {
      if (fifties < 2) { fifties++; return errorResponse(503, '2') }
      return fullResponse(start, end);
    };
    startSession();
    await drain(600_000);
    expect(calls.length).toBeGreaterThanOrEqual(3);
    expect(posted.filter(message => message.type === 'eos')).toHaveLength(1);
    expect(posted.filter(message => message.type === 'error')).toHaveLength(0);
  });
});
