import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AudioDecodeController, byteOffsetForTime, windowByteBudget } from './audio-decode';
import type { DecodeOptions, DecodeStatus } from './audio-decode';
import { FakeAudioContext, FakeWorker } from './test-fakes';

describe('Time to byte offset mapping', () => {
  it('maps seconds through the average byte rate', () => {
    expect(byteOffsetForTime(10, 1000, 1_000_000)).toBe(10_000);
    expect(byteOffsetForTime(0, 1000, 1_000_000)).toBe(0);
    expect(byteOffsetForTime(10_000, 1000, 1_000_000)).toBe(999_999);
    expect(byteOffsetForTime(-5, 1000, 1_000_000)).toBe(0);
    expect(byteOffsetForTime(10, 0, 1_000_000)).toBe(0);
    expect(byteOffsetForTime(10, 1000, 0)).toBe(0);
  });
});

describe('Decode window byte budget', () => {
  it('spans roughly thirty seconds of stream', () => {
    expect(windowByteBudget(100_000)).toBe(3_000_000);
  });
  it('clamps tiny and huge bitrates into a workable range', () => {
    expect(windowByteBudget(0)).toBe(1024 * 1024);
    expect(windowByteBudget(10)).toBe(1024 * 1024);
    expect(windowByteBudget(10_000_000)).toBe(16 * 1024 * 1024);
  });
});

type ControllerHarness = {
  video: HTMLVideoElement;
  ctx: FakeAudioContext;
  worker: FakeWorker;
  statuses: DecodeStatus[];
  controller: AudioDecodeController;
};

// The controller drives itself off requestAnimationFrame; tests fire the frames.
let nextFrame: (() => void) | null = null;
beforeEach(() => {
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { nextFrame = () => callback(0); return 1 as unknown as number });
  vi.stubGlobal('cancelAnimationFrame', () => { nextFrame = null });
});
afterEach(() => {
  vi.unstubAllGlobals();
  nextFrame = null;
});
function tickFrame() { nextFrame?.() }

async function startController(overrides: Partial<DecodeOptions> = {}, ctxState: AudioContextState = 'running'): Promise<ControllerHarness> {
  const video = { muted: false, currentTime: 0, paused: false, ended: false } as unknown as HTMLVideoElement;
  const ctx = new FakeAudioContext(ctxState);
  const worker = new FakeWorker();
  const statuses: DecodeStatus[] = [];
  const controller = await AudioDecodeController.create({
    video, url: 'stream://title/file.mkv', startSec: 0, totalBytes: 1_000_000, durationSec: 100, audioOrdinal: 0,
    onStatus: status => statuses.push(status),
    createContext: () => ctx as unknown as AudioContext,
    createWorker: () => worker as unknown as Worker,
    ...overrides,
  });
  return { video, ctx, worker, statuses, controller };
}

describe('Terminal decode failures surface a visible player error', () => {
  it('rejects creation and leaves the element audible when the audio context cannot be created', async () => {
    const video = { muted: false, currentTime: 0, paused: false, ended: false } as unknown as HTMLVideoElement;
    const promise = AudioDecodeController.create({
      video, url: 'stream://title/file.mkv', startSec: 0, totalBytes: 1_000_000, durationSec: 100, audioOrdinal: 0,
      onStatus: () => { },
      createContext: () => { throw new Error('no audio device') },
      createWorker: () => new FakeWorker() as unknown as Worker,
    });
    await expect(promise).rejects.toThrow('no audio device');
    expect(video.muted).toBe(false);
    expect(nextFrame).toBeNull();
  });

  it('rejects creation and closes the audio context when the decoder worker cannot be constructed', async () => {
    const ctx = new FakeAudioContext();
    const video = { muted: false, currentTime: 0, paused: false, ended: false } as unknown as HTMLVideoElement;
    const promise = AudioDecodeController.create({
      video, url: 'stream://title/file.mkv', startSec: 0, totalBytes: 1_000_000, durationSec: 100, audioOrdinal: 0,
      onStatus: () => { },
      createContext: () => ctx as unknown as AudioContext,
      createWorker: () => { throw new Error('worker blocked by policy') },
    });
    await expect(promise).rejects.toThrow('worker blocked by policy');
    expect(ctx.closed).toBe(true);
    expect(video.muted).toBe(false);
    expect(nextFrame).toBeNull();
  });

  it('mutes the video element while the decode session owns audio', async () => {
    const { video } = await startController();
    expect(video.muted).toBe(true);
  });

  it('surfaces a terminal error and releases the element when the decoder worker fails to load', async () => {
    const { video, ctx, worker, statuses } = await startController();
    worker.failToLoad();
    expect(statuses.at(-1)).toMatchObject({ status: 'error', message: expect.stringContaining('Audio decode failed') });
    expect(video.muted).toBe(false);
    expect(worker.terminated).toBe(true);
    expect(ctx.closed).toBe(true);
  });

  it('surfaces a terminal error and terminates the session after three consecutive window decode failures', async () => {
    const { video, ctx, worker, statuses } = await startController();
    worker.receive({ type: 'error', session: 1, message: 'The audio stream in this file could not be decoded.' });
    expect(statuses.at(-1)).toMatchObject({ status: 'error', message: expect.stringContaining('Audio decode failed') });
    expect(statuses.at(-1)?.message).toContain('The audio stream in this file could not be decoded.');
    expect(video.muted).toBe(false);
    expect(worker.terminated).toBe(true);
    expect(ctx.closed).toBe(true);
  });

  it('explains a suspended audio context instead of playing silently', async () => {
    const { video, ctx, worker, statuses } = await startController({}, 'suspended');
    video.paused = false;
    video.currentTime = 0.25;
    tickFrame();
    expect(statuses.at(-1)).toMatchObject({ status: 'stalling', message: expect.stringContaining('suspended') });
    expect(video.muted).toBe(true);
    expect(worker.terminated).toBe(false);
    expect(ctx.closed).toBe(false);
  });

  it('fails loudly when the suspended audio context never reaches running', async () => {
    const { video, ctx, worker, statuses } = await startController({}, 'suspended');
    video.paused = false;
    for (let t = 0.25; t <= 6; t += 0.25) {
      video.currentTime = t;
      tickFrame();
    }
    expect(statuses.some(status => status.status === 'stalling')).toBe(true);
    expect(statuses.at(-1)).toMatchObject({ status: 'error', message: expect.stringContaining('Audio decode failed') });
    expect(video.muted).toBe(false);
    expect(worker.terminated).toBe(true);
    expect(ctx.closed).toBe(true);
  });

  it('does not fail the session for a suspended context while the video is paused', async () => {
    const { video, worker, statuses } = await startController({}, 'suspended');
    video.paused = true;
    for (let t = 0.25; t <= 6; t += 0.25) {
      video.currentTime = t;
      tickFrame();
    }
    // Paused time must not bank toward the grace period either.
    video.paused = false;
    for (let t = 6.25; t <= 10; t += 0.25) {
      video.currentTime = t;
      tickFrame();
    }
    expect(statuses.some(status => status.status === 'error')).toBe(false);
    expect(worker.terminated).toBe(false);
  });

  it('rejects creation and unmutes the element when the session cannot start after muting', async () => {
    const video = { muted: false, currentTime: 0, paused: false, ended: false } as unknown as HTMLVideoElement;
    const ctx = new FakeAudioContext();
    const worker = new FakeWorker();
    worker.postMessage = () => { throw new Error('worker gone') };
    const promise = AudioDecodeController.create({
      video, url: 'stream://title/file.mkv', startSec: 0, totalBytes: 1_000_000, durationSec: 100, audioOrdinal: 0,
      onStatus: () => { },
      createContext: () => ctx as unknown as AudioContext,
      createWorker: () => worker as unknown as Worker,
    });
    await expect(promise).rejects.toThrow('worker gone');
    expect(video.muted).toBe(false);
    expect(worker.terminated).toBe(true);
    expect(ctx.closed).toBe(true);
    expect(nextFrame).toBeNull();
  });

  it('clears the suspension note once the context reaches running', async () => {
    const { video, ctx, statuses } = await startController({}, 'suspended');
    video.paused = false;
    video.currentTime = 0.25;
    tickFrame();
    expect(statuses.at(-1)).toMatchObject({ status: 'stalling' });
    void ctx.resume();
    video.currentTime = 0.5;
    tickFrame();
    expect(statuses.at(-1)).toMatchObject({ status: 'ready', message: '' });
    expect(video.muted).toBe(true);
  });
});
