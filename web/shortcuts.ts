// Pure shortcut-command layer for the Browser player. Keys resolve to
// PlayerCommands; the player owns the side effects (video element, DOM, OSD).
// Framework-free so vitest can pin every rule in the table below.

export type PlayerCommand =
  | { kind: 'toggle-playback' }
  | { kind: 'play' }
  | { kind: 'pause' }
  | { kind: 'stop' }
  | { kind: 'seek'; deltaMs: number }
  | { kind: 'seek-fraction'; fraction: number }
  | { kind: 'volume'; delta: number }
  | { kind: 'toggle-mute' }
  | { kind: 'toggle-fullscreen' }
  | { kind: 'open-subtitles' }
  | { kind: 'escape' };

export type ResolvedShortcut = { command: PlayerCommand; repeatable: boolean } | null;


// Binding table: e.key → command. Letters match case-insensitively; digits 0-9
// become fractional seeks. Panel-open suppression and repeat filtering happen
// in resolveShortcut, not here.
const REPEATABLE_KINDS: Record<string, true> = { seek: true, volume: true };
const BINDINGS: Record<string, PlayerCommand> = {
  ' ': { kind: 'toggle-playback' },
  ArrowLeft: { kind: 'seek', deltaMs: -5000 },
  ArrowRight: { kind: 'seek', deltaMs: 5000 },
  j: { kind: 'seek', deltaMs: -10000 },
  l: { kind: 'seek', deltaMs: 10000 },
  ArrowUp: { kind: 'volume', delta: 0.02 },
  ArrowDown: { kind: 'volume', delta: -0.02 },
  m: { kind: 'toggle-mute' },
  f: { kind: 'toggle-fullscreen' },
  s: { kind: 'open-subtitles' },
  MediaPlayPause: { kind: 'toggle-playback' },
  MediaPlay: { kind: 'play' },
  MediaPause: { kind: 'pause' },
  MediaStop: { kind: 'stop' },
  Escape: { kind: 'escape' },
};

function lookup(key: string): PlayerCommand | null {
  const letter = key.length === 1 && key !== ' ' ? key.toLowerCase() : key;
  return BINDINGS[letter] ?? (key.length === 1 && key >= '0' && key <= '9' ? { kind: 'seek-fraction', fraction: Number(key) / 10 } : null);
}

export function resolveShortcut(key: string, isRepeat: boolean, panelOpen: boolean): ResolvedShortcut {
  if (panelOpen && key !== 'Escape') return null;
  const command = lookup(key);
  if (!command) return null;
  const repeatable = REPEATABLE_KINDS[command.kind] === true;
  if (isRepeat && !repeatable) return null;
  return { command, repeatable };
}

export type EscapeStep = 'exit-fullscreen' | 'close-panel' | 'hide-chrome' | 'leave';

// Escape unwinds UI state innermost-outward: fullscreen first, then the panel,
// then the chrome; a bare player is left on the second press.
export function resolveEscape(ctx: { fullscreen: boolean; panelOpen: boolean; controlsVisible: boolean }): EscapeStep {
  if (ctx.fullscreen) return 'exit-fullscreen';
  if (ctx.panelOpen) return 'close-panel';
  if (ctx.controlsVisible) return 'hide-chrome';
  return 'leave';
}

// Same clamp semantics as the player's clampSeek: pin to [0, durationMs - 1000]
// so a seek never lands on the very end; durationMs <= 0 means "no duration".
function clampTarget(target: number, durationMs: number): number {
  if (!Number.isFinite(durationMs) || durationMs <= 0) return 0;
  return Math.min(Math.max(0, target), Math.max(0, durationMs - 1000));
}

export function seekTarget(positionMs: number, durationMs: number, deltaMs: number): number {
  return clampTarget(positionMs + deltaMs, durationMs);
}

export function fractionTarget(fraction: number, durationMs: number): number {
  return clampTarget(fraction * durationMs, durationMs);
}

// Sliding to zero mutes; any step away from zero unmutes, so ↑/↓ while muted
// unmutes first and then applies the delta to the stored volume.
export function applyVolumeStep(current: number, muted: boolean, delta: number): { volume: number; muted: boolean } {
  const volume = Math.min(1, Math.max(0, current + delta));
  return { volume, muted: volume === 0 };
}

// Coalesces scrub nudges (timeupdate-driven seek-bar drags) into one seek
// commit after the last nudge settles, so the player isn't hammered with
// seeks during a drag. Same numeric-timer convention as ControlsVisibility.
export class ScrubCoalescer {
  #commit: (targetMs: number) => void;
  #delayMs: number;
  #timer: number = 0;
  #target: number | null = null;

  constructor(commit: (targetMs: number) => void, delayMs = 250) {
    this.#commit = commit;
    this.#delayMs = delayMs;
  }

  get target(): number | null {
    return this.#target;
  }

  nudge(targetMs: number): void {
    this.#clearTimer();
    this.#target = targetMs;
    this.#timer = setTimeout(() => {
      this.#timer = 0;
      this.flush();
    }, this.#delayMs) as unknown as number;
  }

  flush(): void {
    this.#clearTimer();
    if (this.#target === null) return;
    const target = this.#target;
    this.#target = null;
    this.#commit(target);
  }

  cancel(): void {
    this.#clearTimer();
    this.#target = null;
  }

  #clearTimer(): void {
    if (this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = 0;
    }
  }
}
