// Ticket #33: the decode session's start byte and trim come from MEASURED
// audio spans (ADR-0002), not from average-bitrate arithmetic. The planner
// probes the server's audio-anchor endpoint; the controller trims the window
// front at anchor time so window content lands on the video clock even when
// the video advanced while spans were measured.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AudioDecodeController, DECODE_CHANNELS, DECODE_SAMPLE_RATE, type DecodeOptions, type DecodeStatus } from './audio-decode';
import { FakeAudioContext, FakeWorker } from './test-fakes';
import type { AudioSpan } from '@filelist/shared';

let nextFrame: (() => void) | null = null;
beforeEach(() => {
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { nextFrame = () => callback(0); return 1 as unknown as number });
  vi.stubGlobal('cancelAnimationFrame', () => { nextFrame = null });
});
afterEach(() => {
  vi.unstubAllGlobals();
  nextFrame = null;
  FakeWorker.created.length = 0;
});
function tickFrame() { nextFrame?.() }

// A file whose audio content runs at exactly 500 bytes per millisecond, so
// content PTS at byte b is round(b / 500) — independent of the controller's
// average-bitrate estimate, which the tests skew via durationSec.
const TOTAL_BYTES = 100 << 20;
function uniformSpanFetcher(calls: { startByte: number; lengthBytes: number }[] = []) {
  return async (startByte: number, lengthBytes: number): Promise<AudioSpan> => {
    calls.push({ startByte, lengthBytes });
    return { streamIndex: 1, startByte, lengthBytes, firstPtsMs: Math.round(startByte / 500), lastPtsMs: Math.round((startByte + lengthBytes) / 500), windowLengthMs: Math.round(lengthBytes / 500) };
  };
}

class RecordingAudioContext extends FakeAudioContext {
  readonly buffers: { duration: number; data: Float32Array }[] = [];
  override createBuffer(channels: number, frames: number): AudioBuffer {
    const buffer = super.createBuffer(channels, frames);
    this.buffers.push({ duration: buffer.duration, data: buffer.getChannelData(0) });
    return buffer;
  }
}

interface Harness {
  video: HTMLVideoElement & { currentTime: number; paused: boolean };
  ctx: RecordingAudioContext;
  worker: FakeWorker;
  statuses: DecodeStatus[];
  buffers: { duration: number; data: Float32Array }[];
  spanCalls: { startByte: number; lengthBytes: number }[];
}

async function startHarness(options: { startSec: number; durationSec: number; fetchSpan?: (startByte: number, lengthBytes: number) => Promise<AudioSpan> }): Promise<Harness> {
  const video = { muted: false, currentTime: options.startSec, paused: false, ended: false } as unknown as Harness['video'];
  const ctx = new RecordingAudioContext('running');
  const worker = new FakeWorker();
  const statuses: DecodeStatus[] = [];
  const spanCalls: Harness['spanCalls'] = [];
  const decodeOptions: DecodeOptions = {
    video, url: 'stream://title/file.mkv', startSec: options.startSec, totalBytes: TOTAL_BYTES, durationSec: options.durationSec, audioOrdinal: 0,
    onStatus: status => statuses.push(status),
    spanFetch: options.fetchSpan ?? uniformSpanFetcher(spanCalls),
    createContext: () => ctx as unknown as AudioContext,
    createWorker: () => worker as unknown as Worker,
  };
  await AudioDecodeController.create(decodeOptions);
  return { video, ctx, worker, statuses, buffers: ctx.buffers, spanCalls };
}

function feedPcm(worker: FakeWorker, session: number, seconds: number) {
  const frames = Math.round(seconds * DECODE_SAMPLE_RATE);
  worker.receive({ type: 'pcm', session, data: new Float32Array(frames * DECODE_CHANNELS), frames, beginByte: 0 });
}

describe('measured session anchoring', () => {
  it('starts the session at the measured window byte, not the average-bitrate estimate', async () => {
    // durationSec 250 skews the estimate to ~419 KB/s: the 60 s seek hints a
    // window whose measured content sits at ~50.3 s — inside the probed
    // window, so one probe anchors there and the trim corrects the estimate.
    const { worker, spanCalls } = await startHarness({ startSec: 60, durationSec: 250 });
    const hint = Math.round(60 * (TOTAL_BYTES / 250));
    const firstPtsMs = Math.round(hint / 500);
    const start = worker.sent.find(message => message.type === 'start');
    expect(start).toMatchObject({ type: 'start', startByte: hint });
    expect(spanCalls.length).toBe(1);
    expect(spanCalls[0].startByte).toBe(hint);
    expect(firstPtsMs).toBeLessThan(60_000); // the estimate overshot the true content
  });

  it('trims the window front to the video position when the clock held still', async () => {
    const { video, worker, buffers } = await startHarness({ startSec: 60, durationSec: 250 });
    const hint = Math.round(60 * (TOTAL_BYTES / 250));
    const measuredFirstPtsSec = Math.round(hint / 500) / 1000;
    video.paused = false;
    feedPcm(worker, 1, 30);
    tickFrame();
    expect(buffers.length).toBeGreaterThan(0);
    // Estimate-based trim would be 0 (the estimate thinks 60 s == hint bytes);
    // the measured trim corrects the difference.
    expect(buffers[0].duration).toBeCloseTo(30 - (60 - measuredFirstPtsSec), 1);
  });

  it('trims against the clock at anchor time when the video advanced during planning', async () => {
    // The video advanced 3.2 s while spans were measured: the trim must grow
    // to 15.2 s so window content still lands on the video clock.
    const { video, worker, buffers } = await startHarness({ startSec: 60, durationSec: 250 });
    const hint = Math.round(60 * (TOTAL_BYTES / 250));
    const measuredFirstPtsSec = Math.round(hint / 500) / 1000;
    video.currentTime = 63.2;
    video.paused = false;
    feedPcm(worker, 1, 30);
    tickFrame();
    expect(buffers[0].duration).toBeCloseTo(30 - (63.2 - measuredFirstPtsSec), 1);
  });

  it('replans at the current position when the video outran the probed window', async () => {
    const { video, worker, spanCalls } = await startHarness({ startSec: 60, durationSec: 250 });
    video.currentTime = 100;
    video.paused = false;
    feedPcm(worker, 1, 30);
    tickFrame();
    // The first window's content (~50.3 s..~83.9 s) cannot cover 100 s: the
    // controller must re-probe at the video position instead of scheduling
    // stale content.
    const hintAt100 = Math.round(100 * (TOTAL_BYTES / 250));
    // The replanned session posts its start after the probe resolves; await
    // the real signal instead of a guessed delay.
    await vi.waitFor(() => expect(worker.sent.filter(message => message.type === 'start')).toHaveLength(2));
    const starts = worker.sent.filter(message => message.type === 'start');
    expect(starts[1]).toMatchObject({ startByte: hintAt100 });
    expect(spanCalls.at(-1)?.startByte).toBe(hintAt100);
  });
});
