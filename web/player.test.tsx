import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'preact';
import { BrowserPlayer } from './src';
import type { Download, MediaAudioTrack, MediaInfo, PlaybackPreferences } from '@filelist/shared';
import type { WorkerInMessage, WorkerOutMessage } from './audio-decode';
import { FakeAudioContext, FakeWorker } from './test-fakes';

// — Decode-fallback contract, verified through the player wiring with the same
// injected fakes as the controller suite: a fake AudioContext and a fake Worker
// stand in for the browser internals, so the tests assert what a viewer sees —
// the visible error, the track switch in the audio panel, an audible element,
// and a decode session restarted on the replacement track.

type SharedModule = Record<string, unknown>;
const harness = vi.hoisted(() => {
  const state: {
    mediaInfo: unknown;
    preferences: unknown;
    updatePlaybackPreferences: ((value: unknown) => Promise<unknown>) | null;
  } = { mediaInfo: null, preferences: null, updatePlaybackPreferences: null };
  class FakeAPI {
    mediaInfo() { return Promise.resolve(state.mediaInfo) }
    playbackPreferences() { return Promise.resolve(state.preferences) }
    subtitles() { return Promise.resolve({ items: [], warnings: [] }) }
    updatePlayback() { return Promise.resolve({}) }
    updatePlaybackPreferences(value: unknown) { return state.updatePlaybackPreferences!(value) }
    prepareSubtitle() { return Promise.resolve({}) }
    downloads() { return Promise.resolve({ items: [] }) }
    streamURL(path: string) { return new URL(path, 'http://server.test').toString() }
  }
  return { state, FakeAPI };
});
vi.mock('@filelist/shared', async importOriginal => ({ ...(await importOriginal<SharedModule>()), API: harness.FakeAPI }));


// requestAnimationFrame drives both preact's deferred effects and the decode
// controller's tick loop; the stub keeps every pending callback keyed by id so
// concurrent registrations cannot drop each other, and tickFrame fires them all.
const pendingFrames = new Map<number, FrameRequestCallback>();
let nextFrameId = 1;
beforeEach(() => {
  pendingFrames.clear();
  nextFrameId = 1;
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { const id = nextFrameId++; pendingFrames.set(id, callback); return id as unknown as number });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => { pendingFrames.delete(id) });
  vi.stubGlobal('AudioContext', FakeAudioContext);
  vi.stubGlobal('Worker', FakeWorker);
  vi.spyOn(console, 'debug').mockImplementation(() => { });
});
afterEach(() => {
  render(null, host);
  document.body.innerHTML = '';
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  FakeWorker.created = [];
  pendingFrames.clear();
});
function tickFrame() { const callbacks = [...pendingFrames.values()]; pendingFrames.clear(); for (const callback of callbacks) callback(0) }
async function settle(cycles = 5) {
  for (let i = 0; i < cycles; i++) {
    tickFrame();
    const first = Promise.withResolvers<void>();
    setTimeout(first.resolve, 0);
    await first.promise;
    const second = Promise.withResolvers<void>();
    setTimeout(second.resolve, 0);
    await second.promise;
    for (let j = 0; j < 30; j++) await Promise.resolve();
  }
}
function click(element: Element) { element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })) }

const audioTrack = (streamIndex: number, codec: string, extra: Partial<MediaAudioTrack> = {}): MediaAudioTrack => ({ streamIndex, codec, ...extra });
const download = {
  id: 'dl1', streamUrl: '/stream/dl1', sizeBytes: 1_000_000, displayTitle: 'Movie', filePath: 'Movie.mkv', playbackMode: 'progressive',
} as unknown as Download;
const saved = (audioTrackIndex: number): PlaybackPreferences => ({ audioLanguage: 'en', audioTrackIndex, subtitleLanguage: 'ro', subtitleMode: 'auto' });
const mediaInfoWith = (audioTracks: MediaAudioTrack[]): MediaInfo => ({ durationMs: 60_000, audioTracks });
let host: HTMLDivElement;
async function startPlayer(audioTracks: MediaAudioTrack[], audioTrackIndex = 0) {
  host = document.createElement('div');
  document.body.appendChild(host);
  harness.state.mediaInfo = mediaInfoWith(audioTracks);
  harness.state.preferences = saved(audioTrackIndex);
  harness.state.updatePlaybackPreferences = vi.fn(async (value: unknown) => value);
  render(<BrowserPlayer active={{ download, resumeMs: 0, preferences: saved(audioTrackIndex) }} onClose={() => { }} onStateChanged={() => { }} onAdvance={async () => { }} />, host);
  await settle();
}

describe('Native-track auto-fallback on decode failure', () => {
  it('switches to the natively playable track and clears the error when the selected track fails to decode', async () => {
    await startPlayer([audioTrack(0, 'ac3', { language: 'en' }), audioTrack(1, 'aac', { language: 'de', default: true })]);
    expect(FakeWorker.created).toHaveLength(1);
    FakeWorker.created[0].receive({ type: 'error', session: 1, message: 'window decode failed' });
    await settle();
    // The player switched tracks (viewer-observable in the audio panel), no
    // decode session was started again (the replacement plays natively), and
    // the video element is audible again.
    expect(FakeWorker.created).toHaveLength(1);
    click([...host.querySelectorAll('.player-control-row button')].find(button => button.textContent?.startsWith('Audio'))!);
    await settle();
    const panel = host.querySelector('.audio-panel')!;
    expect(panel.querySelectorAll('button')[1].className).toContain('selected');
    expect((host.querySelector('video') as HTMLVideoElement).muted).toBe(false);
    expect(host.querySelector('.player-status')).toBeNull();
    expect(harness.state.updatePlaybackPreferences).not.toHaveBeenCalled();
    expect(console.debug).toHaveBeenCalledWith(expect.stringContaining('falling back'));
  });

  it('restarts decoding on the fallback track when the replacement still needs the client decoder', async () => {
    await startPlayer([audioTrack(0, 'ac3', { language: 'en', default: true }), audioTrack(1, 'aac', { language: 'de' })]);
    expect(FakeWorker.created).toHaveLength(1);
    FakeWorker.created[0].receive({ type: 'error', session: 1, message: 'window decode failed' });
    await settle();
    // Non-default replacement track in a multi-track file: a second decode
    // session starts, mapped to the replacement's stream position.
    expect(FakeWorker.created).toHaveLength(2);
    const start = FakeWorker.created[1].sent.find(message => message.type === 'start');
    expect(start).toMatchObject({ type: 'start', audioOrdinal: 1 });
    expect(console.debug).toHaveBeenCalledWith(expect.stringContaining('falling back'));
    expect(harness.state.updatePlaybackPreferences).not.toHaveBeenCalled();
  });

  it('keeps the visible decode error when the title has nothing playable left', async () => {
    await startPlayer([audioTrack(0, 'ac3', { language: 'en', default: true })]);
    expect(FakeWorker.created).toHaveLength(1);
    FakeWorker.created[0].receive({ type: 'error', session: 1, message: 'window decode failed' });
    await settle();
    expect(FakeWorker.created).toHaveLength(1);
    expect(host.querySelector('.player-status')?.textContent).toContain('Audio decode failed');
    expect(console.debug).not.toHaveBeenCalledWith(expect.stringContaining('falling back'));
    expect(harness.state.updatePlaybackPreferences).not.toHaveBeenCalled();
  });

  it('survives a second failure by excluding every already-failed track', async () => {
    await startPlayer([audioTrack(0, 'ac3', { language: 'en', default: true }), audioTrack(1, 'aac', { language: 'de' }), audioTrack(2, 'mp3', { language: 'fr' })]);
    FakeWorker.created[0].receive({ type: 'error', session: 1, message: 'window decode failed' });
    await settle();
    expect(FakeWorker.created).toHaveLength(2);
    FakeWorker.created[1].receive({ type: 'error', session: 1, message: 'window decode failed' });
    await settle();
    // Both earlier tracks are excluded: the third decode session targets track 2
    // (mp3, the only candidate left), never looping back onto a failed track.
    expect(FakeWorker.created).toHaveLength(3);
    expect(FakeWorker.created[2].sent.find(message => message.type === 'start')).toMatchObject({ type: 'start', audioOrdinal: 2 });
    click([...host.querySelectorAll('.player-control-row button')].find(button => button.textContent?.startsWith('Audio'))!);
    await settle();
    const panel = host.querySelector('.audio-panel')!;
    expect(panel.querySelectorAll('button')[2].className).toContain('selected');
    expect(host.querySelector('.player-status')).toBeNull();
    expect(harness.state.updatePlaybackPreferences).not.toHaveBeenCalled();
  });
});
