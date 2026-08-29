// Shared test fakes for the audio decode boundary: a fake AudioContext and a
// fake Worker stand in for the browser internals so tests assert what a viewer
// experiences — a visible message on the onStatus channel the player renders,
// a sane (unmuted) video element, and a terminated decode session. Production
// code never passes the factories.
import { DECODE_SAMPLE_RATE } from './audio-decode';
import type { WorkerInMessage, WorkerOutMessage } from './audio-decode';
import type { AudioSpan, SpanFetcher } from '@filelist/shared';

// Uniform measured spans for controller tests: audio content runs at exactly
// 500 bytes per millisecond, so the PTS at byte b is round(b / 500).
export function fakeSpanFetcher(calls: { startByte: number; lengthBytes: number }[] = []): SpanFetcher {
  return async (startByte: number, lengthBytes: number): Promise<AudioSpan> => {
    calls.push({ startByte, lengthBytes });
    return { streamIndex: 1, startByte, lengthBytes, firstPtsMs: Math.round(startByte / 500), lastPtsMs: Math.round((startByte + lengthBytes) / 500) };
  };
}

export class FakeAudioContext {
  state: AudioContextState;
  currentTime = 0;
  closed = false;
  onstatechange: (() => void) | null = null;
  readonly destination = {};
  constructor(state: AudioContextState = 'running') { this.state = state }
  resume() { this.state = 'running'; return Promise.resolve() }
  suspend() { this.state = 'suspended'; return Promise.resolve() }
  close() { this.closed = true; return Promise.resolve() }
  createGain(): GainNode { return { connect() { }, gain: { value: 1, setTargetAtTime() { } } } as unknown as GainNode }
  createBuffer(channels: number, frames: number): AudioBuffer {
    const data = new Float32Array(frames * channels);
    return { duration: frames / DECODE_SAMPLE_RATE, getChannelData: (channel: number) => data.slice(channel * frames, (channel + 1) * frames) } as unknown as AudioBuffer;
  }
  createBufferSource(): AudioBufferSourceNode {
    return { buffer: null, onended: null, connect() { }, start() { }, stop() { } } as unknown as AudioBufferSourceNode;
  }
}

export class FakeWorker {
  static created: FakeWorker[] = [];
  onmessage: ((event: { data: WorkerOutMessage }) => void) | null = null;
  onerror: ((event: { message: string }) => void) | null = null;
  terminated = false;
  readonly sent: WorkerInMessage[] = [];
  constructor() { FakeWorker.created.push(this) }
  postMessage(message: WorkerInMessage) { this.sent.push(message) }
  terminate() { this.terminated = true }
  receive(message: WorkerOutMessage) { this.onmessage?.({ data: message }) }
  failToLoad(message = 'network unreachable') { this.onerror?.({ message }) }
}
