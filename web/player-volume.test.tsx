import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'preact';
import { BrowserPlayer } from './src';
import type { Download, MediaAudioTrack, MediaInfo, PlaybackPreferences } from '@filelist/shared';
import { FakeAudioContext, FakeWorker } from './test-fakes';

// — Volume truth and per-browser persistence, verified through the player
// wiring with the same injected fakes as the other suites: a recording
// AudioContext captures the decoder gain commands (what a viewer actually
// hears), the fake Worker stands in for the decode session, and happy-dom's
// localStorage stands in for the browser store. The defect class: the decode
// route mutes the <video> element, and a volumechange mirror turned that into
// a zeroed slider while the decoder played at full gain — the UI diverged
// from the loudness. Loudness state must follow the decoder (or the element
// on the native route) and survive remounts per browser, never the element's
// muted implementation detail.

type SharedModule = Record<string, unknown>;
const harness = vi.hoisted(() => {
 const state: {
  mediaInfo: unknown;
  preferences: unknown;
 } = { mediaInfo: null, preferences: null };
 class FakeAPI {
  mediaInfo() { return Promise.resolve(state.mediaInfo) }
  playbackPreferences() { return Promise.resolve(state.preferences) }
  subtitles() { return Promise.resolve({ items: [], warnings: [] }) }
  updatePlayback() { return Promise.resolve({}) }
  updatePlaybackPreferences(value: unknown) { return Promise.resolve(value) }
  prepareSubtitle() { return Promise.resolve({}) }
  downloads() { return Promise.resolve({ items: [] }) }
  streamURL(path: string) { return new URL(path, 'http://server.test').toString() }
  audioAnchor(_sourceId: unknown, startByte: number, lengthBytes: number, streamIndex: number) {
    // Uniform 500 B/ms content model: the planner converges in one probe for
    // every resume position these tests use.
    return Promise.resolve({ streamIndex, startByte, lengthBytes, firstPtsMs: Math.round(startByte / 500), lastPtsMs: Math.round((startByte + lengthBytes) / 500) });
  }
 }
 return { state, FakeAPI };
});
vi.mock('@filelist/shared', async importOriginal => ({ ...(await importOriginal<SharedModule>()), API: harness.FakeAPI }));

// Records every gain command the decode controller issues — the audible truth.
interface GainRecord { targets: number[] }
class RecordingAudioContext extends FakeAudioContext {
 static gains: GainRecord[] = [];
 override createGain(): GainNode {
  const record: GainRecord = { targets: [] };
  RecordingAudioContext.gains.push(record);
  return { connect() { }, gain: { value: 1, setTargetAtTime: (target: number) => { record.targets.push(target) } } } as unknown as GainNode;
 }
}
const latestGain = (): GainRecord | undefined => RecordingAudioContext.gains[RecordingAudioContext.gains.length - 1];
// Effective loudness: constructor default (1) until the first gain command lands.
const effectiveGain = (gain: GainRecord | undefined) => gain === undefined || gain.targets.length === 0 ? 1 : gain.targets[gain.targets.length - 1];

// requestAnimationFrame drives preact's deferred effects and the decode
// controller's tick loop; keyed like the other suites so concurrent
// registrations cannot drop each other, and tickFrame fires them all.
const pendingFrames = new Map<number, FrameRequestCallback>();
let nextFrameId = 1;
// happy-dom's localStorage getter does not survive vitest's global population,
// so the browser store is stubbed like the other internals; a fresh Map per
// test stands in for a fresh browser profile (first use has empty storage).
let persisted = new Map<string, string>();
const persistedStorage = { getItem: (key: string) => persisted.has(key) ? persisted.get(key)! : null, setItem: (key: string, value: string) => { persisted.set(key, value) } };
beforeEach(() => {
 pendingFrames.clear();
 nextFrameId = 1;
 RecordingAudioContext.gains = [];
 persisted = new Map();
 vi.stubGlobal('localStorage', persistedStorage);
 vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { const id = nextFrameId++; pendingFrames.set(id, callback); return id as unknown as number });
 vi.stubGlobal('cancelAnimationFrame', (id: number) => { pendingFrames.delete(id) });
 vi.stubGlobal('AudioContext', RecordingAudioContext);
 vi.stubGlobal('Worker', FakeWorker);
 vi.spyOn(console, 'debug').mockImplementation(() => { });
});
afterEach(() => {
 if (host) render(null, host);
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

const audioTrack = (streamIndex: number, codec: string): MediaAudioTrack => ({ streamIndex, codec });
const downloadWith = (id: string) => ({ id, streamUrl: `/stream/${id}`, sizeBytes: 1_000_000, displayTitle: 'Movie', filePath: 'Movie.mkv', playbackMode: 'progressive' }) as unknown as Download;
const mediaInfoWith = (audioTracks: MediaAudioTrack[]): MediaInfo => ({ durationMs: 60_000, audioTracks });
const preferences: PlaybackPreferences = { audioLanguage: 'en', audioTrackIndex: 0, subtitleLanguage: 'ro', subtitleMode: 'auto' };

let host: HTMLDivElement;
function mountPlayer(id: string, audioTracks: MediaAudioTrack[]) {
 host = document.createElement('div');
 document.body.appendChild(host);
 harness.state.mediaInfo = mediaInfoWith(audioTracks);
 harness.state.preferences = preferences;
 render(<BrowserPlayer active={{ download: downloadWith(id), resumeMs: 0, preferences }} onClose={() => { }} onStateChanged={() => { }} onAdvance={async () => { }} />, host);
}
async function startPlayer(id: string, audioTracks: MediaAudioTrack[]) { mountPlayer(id, audioTracks); await settle() }
// Same browser, different video: the persisted settings must carry over.
async function reopenPlayer(id: string, audioTracks: MediaAudioTrack[]) { render(null, host); await startPlayer(id, audioTracks) }

const volumeSlider = () => host.querySelector('input[aria-label="Volume"]') as HTMLInputElement;
const setSlider = (value: string) => { volumeSlider().value = value; volumeSlider().dispatchEvent(new Event('input', { bubbles: true })) };
const muteButton = () => [...host.querySelectorAll('.player-control-row button')].find(button => button.textContent === 'Mute' || button.textContent === 'Unmute')!;
const clickMute = () => click(muteButton());

describe('Volume truth and per-browser persistence', () => {
 it('defaults to full volume and unmuted on first use', async () => {
  await startPlayer('dl1', [audioTrack(0, 'ac3')]);
  expect(volumeSlider().value).toBe('1');
  expect(muteButton().textContent).toBe('Mute');
  expect(effectiveGain(latestGain())).toBe(1);
 });

 it('applies slider changes to the decoder gain on the decode route', async () => {
  await startPlayer('dl1', [audioTrack(0, 'ac3')]);
  setSlider('0.4');
  await settle();
  expect(volumeSlider().value).toBe('0.4');
  expect(effectiveGain(latestGain())).toBe(0.4);
 });

 it('carries volume set before the decoder exists into the decoder gain', async () => {
  mountPlayer('dl1', [audioTrack(0, 'ac3')]); // media details still loading, no decode session yet
  setSlider('0.4');
  await settle();
  expect(effectiveGain(latestGain())).toBe(0.4);
 });

 it('keeps the slider on the decoder gain when the muted element reports volumechange', async () => {
  await startPlayer('dl1', [audioTrack(0, 'ac3')]);
  setSlider('0.4');
  await settle();
  const video = host.querySelector('video') as HTMLVideoElement;
  expect(video.muted).toBe(true); // the decode session owns the element…
  video.dispatchEvent(new Event('volumechange')); // …and the browser reports that as volumechange
  await settle();
  expect(volumeSlider().value).toBe('0.4');
  expect(effectiveGain(latestGain())).toBe(0.4);
 });

 it('mutes actual decode output and shows the muted state', async () => {
  await startPlayer('dl1', [audioTrack(0, 'ac3')]);
  clickMute();
  await settle();
  expect(muteButton().textContent).toBe('Unmute');
  expect(volumeSlider().value).toBe('0');
  expect(effectiveGain(latestGain())).toBe(0);
 });

 it('persists volume into a fresh decode session for a different download', async () => {
  await startPlayer('dl1', [audioTrack(0, 'ac3')]);
  setSlider('0.4');
  await settle();
  await reopenPlayer('dl2', [audioTrack(0, 'ac3')]);
  expect(volumeSlider().value).toBe('0.4');
  expect(effectiveGain(latestGain())).toBe(0.4);
 });

 it('persists mute into a fresh decode session for a different download', async () => {
  await startPlayer('dl1', [audioTrack(0, 'ac3')]);
  clickMute();
  await settle();
  await reopenPlayer('dl2', [audioTrack(0, 'ac3')]);
  expect(muteButton().textContent).toBe('Unmute');
  expect(volumeSlider().value).toBe('0');
  expect(effectiveGain(latestGain())).toBe(0);
 });

 it('keeps native-route behavior: slider and mute drive the element', async () => {
  await startPlayer('dl1', [audioTrack(0, 'aac')]);
  setSlider('0.25');
  await settle();
  const video = host.querySelector('video') as HTMLVideoElement;
  expect(video.volume).toBe(0.25);
  expect(volumeSlider().value).toBe('0.25');
  clickMute();
  await settle();
  expect(video.muted).toBe(true);
  expect(volumeSlider().value).toBe('0');
  clickMute();
  await settle();
  expect(video.muted).toBe(false);
  expect(volumeSlider().value).toBe('0.25');
 });

 it('applies persisted volume to the native element for a different download', async () => {
  await startPlayer('dl1', [audioTrack(0, 'aac')]);
  setSlider('0.4');
  await settle();
  await reopenPlayer('dl2', [audioTrack(0, 'aac')]);
  expect((host.querySelector('video') as HTMLVideoElement).volume).toBe(0.4);
  expect(volumeSlider().value).toBe('0.4');
 });
});
