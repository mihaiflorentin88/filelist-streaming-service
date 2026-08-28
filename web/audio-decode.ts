// Client-side audio decode for codecs browsers cannot decode natively (AC3, DTS, ...).
// A Web Worker fetches ranged bytes of the progressive stream and decodes moving
// windows to raw PCM; this module owns the pure routing decision and the Web Audio
// graph that schedules decoded buffers against the video clock. The video element
// stays muted while a controller is alive; the native path never constructs one.
export type WorkerInMessage =
  | { type: 'start'; session: number; url: string; startByte: number; totalBytes: number; bytesPerSecond: number; audioOrdinal: number }
  | { type: 'pause' }
  | { type: 'resume' }
  | { type: 'stop' };
export type WorkerOutMessage =
  | { type: 'pcm'; session: number; data: Float32Array; frames: number; beginByte: number }
  | { type: 'eos'; session: number }
  | { type: 'state'; session: number; status: 'stalling' }
  | { type: 'error'; session: number; message: string };

// Codec decision (pure; the seam a future test exercises directly).
const NATIVE_AUDIO_CODECS: Record<string, true> = { aac: true, mp3: true, opus: true, flac: true, vorbis: true };
export function audioPlaybackRoute(codec: string | undefined | null): 'native' | 'decode' {
  const value = (codec ?? '').trim().toLowerCase();
  return NATIVE_AUDIO_CODECS[value] ? 'native' : 'decode';
}
// Time→byte mapping for sessions without a container index: average file bitrate.
export function byteOffsetForTime(seconds: number, bytesPerSecond: number, totalBytes: number): number {
  if (!(bytesPerSecond > 0) || !(totalBytes > 0)) return 0;
  return Math.min(Math.max(0, Math.round(seconds * bytesPerSecond)), Math.max(0, totalBytes - 1));
}
// Decode ~30s of stream bytes per window, clamped so slow and huge-bitrate files stay workable.
export function windowByteBudget(bytesPerSecond: number): number {
  return Math.min(16 * 1024 * 1024, Math.max(1024 * 1024, Math.round(bytesPerSecond * 30)));
}

// Playback tuning: schedule ~0.5s ahead; resync the decode session when the WebAudio
// timeline drifts more than 250ms from video.currentTime.
export const DECODE_SAMPLE_RATE = 48000;
export const DECODE_CHANNELS = 2;
const SCHEDULE_AHEAD_SECONDS = 0.5;
const DRIFT_LIMIT_SECONDS = 0.25;
const ANCHOR_LEAD_SECONDS = 0.08;
const PENDING_PAUSE_SECONDS = 120;
const PENDING_RESUME_SECONDS = 45;

export type DecodeStatus = { status: 'ready' | 'stalling' | 'error'; message: string };
export type DecodeOptions = { video: HTMLVideoElement; url: string; startSec: number; totalBytes: number; durationSec: number; audioOrdinal: number; onStatus: (status: DecodeStatus) => void };

export class AudioDecodeController {
  private readonly video: HTMLVideoElement;
  private readonly ctx: AudioContext;
  private readonly gain: GainNode;
  private readonly worker: Worker;
  private readonly onStatus: (status: DecodeStatus) => void;
  private readonly url: string;
  private readonly totalBytes: number;
  private readonly bytesPerSecond: number;
  private readonly audioOrdinal: number;
  private sessionStartSec = 0;
  private session = 0;
  private pending: { data: Float32Array; frames: number; beginByte: number }[] = [];
  private pendingSeconds = 0;
  private readonly sources = new Set<AudioBufferSourceNode>();
  private anchored = false;
  private anchorCtxAt = 0;
  private anchorMediaAt = 0;
  private scheduledMediaEnd = 0;
  private trimRemaining = 0;
  private throttled = false;
  private stalledNote = false;
  private volume = 1;
  private muted = false;
  private destroyed = false;
  private frame = 0;

  private constructor(video: HTMLVideoElement, ctx: AudioContext, worker: Worker, options: DecodeOptions) {
    this.video = video;
    this.ctx = ctx;
    this.worker = worker;
    this.onStatus = options.onStatus;
    this.url = options.url;
    this.totalBytes = options.totalBytes;
    this.audioOrdinal = options.audioOrdinal;
    this.bytesPerSecond = options.durationSec > 0 && options.totalBytes > 0 ? options.totalBytes / options.durationSec : 0;
    this.gain = ctx.createGain();
    this.gain.connect(ctx.destination);
    this.gain.gain.value = this.volume;
  }

  static async create(options: DecodeOptions): Promise<AudioDecodeController> {
    const ctx = new AudioContext({ latencyHint: 'playback' });
    ctx.onstatechange = () => console.debug(`[audio-decode] audio context state: ${ctx.state}`);
    console.debug(`[audio-decode] controller created (audio context ${ctx.state}, video ${options.video.muted ? 'muted' : 'audible'})`);
    const worker = new Worker(new URL('./audio-decode-worker.ts', import.meta.url), { type: 'module' });
    const controller = new AudioDecodeController(options.video, ctx, worker, options);
    worker.onmessage = event => controller.receive(event.data as WorkerOutMessage);
    controller.startSession(options.startSec);
    controller.tickLoop();
    return controller;
  }

  /** Restart decoding at a video position; ignores echoes of the current anchor (resume, resync). */
  seek(seconds: number) {
    if (this.destroyed) return;
    if (this.anchored && Math.abs(seconds - this.anchorMediaAt) < DRIFT_LIMIT_SECONDS) return;
    this.startSession(seconds);
  }

  suspend() { if (!this.destroyed) void this.ctx.suspend() }
  resume() { if (!this.destroyed) void this.ctx.resume() }
  setVolume(value: number) { this.volume = value; this.applyGain() }
  setMuted(value: boolean) { this.muted = value; this.applyGain() }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    console.debug('[audio-decode] controller destroyed');
    cancelAnimationFrame(this.frame);
    this.worker.terminate();
    this.stopSources();
    void this.ctx.close();
  }

  private startSession(seconds: number) {
    console.debug(`[audio-decode] session ${this.session + 1} from ${seconds.toFixed(2)}s`);
    this.session++;
    this.sessionStartSec = seconds;
    this.anchored = false;
    this.pending = [];
    this.pendingSeconds = 0;
    this.trimRemaining = 0;
    this.stopSources();
    this.throttle(false);
    this.worker.postMessage({ type: 'start', session: this.session, url: this.url, startByte: byteOffsetForTime(seconds, this.bytesPerSecond, this.totalBytes), totalBytes: this.totalBytes, bytesPerSecond: this.bytesPerSecond, audioOrdinal: this.audioOrdinal } satisfies WorkerInMessage);
  }

  private receive(message: WorkerOutMessage) {
    if (this.destroyed || message.session !== this.session) return;
    if (message.type === 'pcm') {
      this.pending.push({ data: message.data, frames: message.frames, beginByte: message.beginByte });
      this.pendingSeconds += message.frames / DECODE_SAMPLE_RATE;
      if (this.pendingSeconds >= PENDING_PAUSE_SECONDS && !this.throttled) this.throttle(true);
      if (this.stalledNote) {
        this.stalledNote = false;
        this.onStatus({ status: 'ready', message: '' });
      }
    } else if (message.type === 'eos') {
      // Whole stream decoded and queued; the tick loop drains what remains.
    } else if (message.type === 'state') {
      this.stalledNote = true;
      this.onStatus({ status: 'stalling', message: 'Audio decoder is waiting for more downloaded data…' });
    } else if (message.type === 'error') {
      this.stalledNote = false;
      this.onStatus({ status: 'error', message: `Audio decode failed: ${message.message}` });
    }
  }

  private throttle(on: boolean) {
    if (this.throttled === on) return;
    this.throttled = on;
    this.worker.postMessage({ type: on ? 'pause' : 'resume' } satisfies WorkerInMessage);
  }

  // Sync contract, evaluated per animation frame while the video plays:
  //   audio position = anchorMediaAt + (audioCtx.now - anchorCtxAt)
  // If that timeline leaves the video.currentTime neighborhood by more than
  // DRIFT_LIMIT_SECONDS, the whole decode session restarts at the video position
  // (byte offset re-estimated, scheduled buffers flushed). Otherwise buffers are
  // scheduled ~SCHEDULE_AHEAD_SECONDS ahead of video.currentTime.
  private tickLoop = () => {
    if (this.destroyed) return;
    this.frame = requestAnimationFrame(this.tickLoop);
    if (this.ctx.state !== 'running' || this.video.paused || this.video.ended) return;
    const audible = this.sources.size > 0 || this.pending.length > 0;
    const drift = this.anchored && audible ? this.anchorMediaAt + (this.ctx.currentTime - this.anchorCtxAt) - this.video.currentTime : 0;
    if (Math.abs(drift) > DRIFT_LIMIT_SECONDS) {
      this.startSession(this.video.currentTime);
      return;
    }
    while (this.pending.length > 0 && this.scheduledMediaEnd - this.video.currentTime < SCHEDULE_AHEAD_SECONDS) this.scheduleNext();
  };

  private scheduleNext() {
    const item = this.pending.shift()!;
    const frames = Math.min(item.frames, Math.floor(item.data.length / DECODE_CHANNELS));
    if (frames <= 0) return;
    // Audio fully drained past the video position (starvation, late seek): re-anchor
    // at the video clock instead of stacking buffers onto stale times.
    if (this.sources.size === 0 && this.anchored && this.scheduledMediaEnd < this.video.currentTime) {
      this.anchored = false;
      this.trimRemaining = 0;
    }
    if (!this.anchored) {
      this.anchored = true;
      this.anchorMediaAt = this.video.currentTime;
      this.anchorCtxAt = this.ctx.currentTime + ANCHOR_LEAD_SECONDS;
      this.scheduledMediaEnd = this.anchorMediaAt;
      // Sessions clamped into the container-header region decode from byte 0; the
      // first window's beginByte is the actual content position, so trim the front
      // down to the requested position.
      this.trimRemaining = Math.max(0, this.sessionStartSec - (this.totalBytes > 0 && this.bytesPerSecond > 0 ? item.beginByte / this.bytesPerSecond : 0));
    }
    const dropFrames = this.trimRemaining > 0 ? Math.min(frames, Math.round(this.trimRemaining * DECODE_SAMPLE_RATE)) : 0;
    this.trimRemaining -= dropFrames / DECODE_SAMPLE_RATE;
    const kept = frames - dropFrames;
    if (kept <= 0) return;
    const skip = dropFrames * DECODE_CHANNELS;
    const buffer = this.ctx.createBuffer(DECODE_CHANNELS, kept, DECODE_SAMPLE_RATE);
    for (let channel = 0; channel < DECODE_CHANNELS; channel++) {
      const target = buffer.getChannelData(channel);
      for (let i = 0; i < kept; i++) target[i] = item.data[skip + i * DECODE_CHANNELS + channel];
    }
    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(this.gain);
    source.onended = () => { this.sources.delete(source) };
    source.start(Math.max(this.anchorCtxAt + (this.scheduledMediaEnd - this.anchorMediaAt), this.ctx.currentTime + 0.005));
    this.sources.add(source);
    this.scheduledMediaEnd += buffer.duration;
    this.pendingSeconds -= buffer.duration;
    if (this.throttled && this.pendingSeconds <= PENDING_RESUME_SECONDS) this.throttle(false);
  }

  private applyGain() { this.gain.gain.setTargetAtTime(this.muted ? 0 : this.volume, this.ctx.currentTime, 0.02) }

  private stopSources() { for (const source of this.sources) { source.onended = null; try { source.stop() } catch { } } this.sources.clear() }
}
