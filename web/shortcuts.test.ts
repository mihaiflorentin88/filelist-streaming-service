import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyVolumeStep,
  fractionTarget,
  resolveEscape,
  resolveShortcut,
  ScrubCoalescer,
  seekTarget,
  type PlayerCommand,
} from './shortcuts';

function resolve(key: string, isRepeat = false, panelOpen = false): PlayerCommand | null {
  const resolved = resolveShortcut(key, isRepeat, panelOpen);
  return resolved ? resolved.command : null;
}

describe('resolveShortcut bindings', () => {
  const rows: Array<[string, PlayerCommand]> = [
    [' ', { kind: 'toggle-playback' }],
    ['ArrowLeft', { kind: 'seek', deltaMs: -5000 }],
    ['ArrowRight', { kind: 'seek', deltaMs: 5000 }],
    ['j', { kind: 'seek', deltaMs: -10000 }],
    ['l', { kind: 'seek', deltaMs: 10000 }],
    ['ArrowUp', { kind: 'volume', delta: 0.02 }],
    ['ArrowDown', { kind: 'volume', delta: -0.02 }],
    ['m', { kind: 'toggle-mute' }],
    ['f', { kind: 'toggle-fullscreen' }],
    ['s', { kind: 'open-subtitles' }],
    ['0', { kind: 'seek-fraction', fraction: 0 }],
    ['5', { kind: 'seek-fraction', fraction: 0.5 }],
    ['9', { kind: 'seek-fraction', fraction: 0.9 }],
    ['MediaPlayPause', { kind: 'toggle-playback' }],
    ['MediaPlay', { kind: 'play' }],
    ['MediaPause', { kind: 'pause' }],
    ['MediaStop', { kind: 'stop' }],
    ['Escape', { kind: 'escape' }],
  ];

  it.each(rows)('%s → %j', (key, command) => {
    expect(resolve(key)).toEqual(command);
  });

  it.each([['j', 'J'], ['l', 'L'], ['m', 'M'], ['f', 'F'], ['s', 'S']] as Array<[string, string]>)(
    'case-insensitive: %s ≡ %s',
    (lower, upper) => {
      expect(resolve(upper)).toEqual(resolve(lower));
    },
  );

  it('marks seek and volume repeatable, everything else single-fire', () => {
    expect(resolveShortcut('ArrowLeft', true, false)).toEqual({ command: { kind: 'seek', deltaMs: -5000 }, repeatable: true });
    expect(resolveShortcut('l', true, false)?.repeatable).toBe(true);
    expect(resolveShortcut('ArrowUp', true, false)?.repeatable).toBe(true);
    expect(resolveShortcut(' ', true, false)).toBeNull();
    expect(resolveShortcut('m', true, false)).toBeNull();
    expect(resolveShortcut('f', true, false)).toBeNull();
    expect(resolveShortcut('s', true, false)).toBeNull();
    expect(resolveShortcut('5', true, false)).toBeNull();
    expect(resolveShortcut('MediaStop', true, false)).toBeNull();
    expect(resolveShortcut('Escape', true, false)).toBeNull();
  });

  it('suppresses every key while the panel is open except Escape', () => {
    for (const key of rows.map(([key]) => key)) {
      if (key === 'Escape') {
        expect(resolve(key, false, true)).toEqual({ kind: 'escape' });
      } else {
        expect(resolve(key, false, true)).toBeNull();
      }
    }
    expect(resolve('ArrowLeft', true, true)).toBeNull();
  });

  it('returns null for unknown keys', () => {
    expect(resolve('x')).toBeNull();
    expect(resolve('Enter')).toBeNull();
    expect(resolve('')).toBeNull();
  });
});

describe('resolveEscape', () => {
  it.each([
    [{ fullscreen: true, panelOpen: true, controlsVisible: true }, 'exit-fullscreen'],
    [{ fullscreen: true, panelOpen: false, controlsVisible: false }, 'exit-fullscreen'],
    [{ fullscreen: false, panelOpen: true, controlsVisible: true }, 'close-panel'],
    [{ fullscreen: false, panelOpen: true, controlsVisible: false }, 'close-panel'],
    [{ fullscreen: false, panelOpen: false, controlsVisible: true }, 'hide-chrome'],
    [{ fullscreen: false, panelOpen: false, controlsVisible: false }, 'leave'],
  ] as const)('%j → %s', (ctx, step) => {
    expect(resolveEscape(ctx)).toBe(step);
  });
});

describe('seekTarget', () => {
  it('adds the delta', () => {
    expect(seekTarget(60_000, 120_000, 1500)).toBe(61_500);
    expect(seekTarget(60_000, 120_000, -5000)).toBe(55_000);
  });
  it('clamps negative results to 0', () => {
    expect(seekTarget(2_000, 120_000, -5000)).toBe(0);
  });
  it('clamps to durationMs - 1000 at the end', () => {
    expect(seekTarget(120_000, 120_000, 5000)).toBe(119_000);
  });
  it('accepts a target exactly at durationMs - 1000', () => {
    expect(seekTarget(119_000, 120_000, 0)).toBe(119_000);
  });
  it('returns 0 when duration is 0 or negative', () => {
    expect(seekTarget(5_000, 0, 5000)).toBe(0);
    expect(seekTarget(5_000, -1, 5000)).toBe(0);
  });
});

describe('fractionTarget', () => {
  it('maps fraction × duration', () => {
    expect(fractionTarget(0.5, 120_000)).toBe(60_000);
  });
  it('clamps to durationMs - 1000', () => {
    expect(fractionTarget(1, 120_000)).toBe(119_000);
  });
  it('clamps to 0 at the start', () => {
    expect(fractionTarget(0, 120_000)).toBe(0);
  });
  it('returns 0 when duration is 0 or negative', () => {
    expect(fractionTarget(0.5, 0)).toBe(0);
    expect(fractionTarget(0.5, -5)).toBe(0);
  });
});

describe('applyVolumeStep', () => {
  it('steps up and leaves muted false', () => {
    expect(applyVolumeStep(0.5, 0.02)).toEqual({ volume: 0.52, muted: false });
  });
  it('steps down and leaves muted false', () => {
    expect(applyVolumeStep(0.52, -0.02)).toEqual({ volume: 0.5, muted: false });
  });
  it('clamps at 1', () => {
    expect(applyVolumeStep(0.99, 0.02)).toEqual({ volume: 1, muted: false });
  });
  it('clamps at 0 and mutes when sliding to zero', () => {
    expect(applyVolumeStep(0.01, -0.02)).toEqual({ volume: 0, muted: true });
  });
  it('steps away from zero unmute', () => {
    expect(applyVolumeStep(0.3, 0.02)).toEqual({ volume: 0.32, muted: false });
  });
  it('stays muted when a downward step keeps the volume at zero', () => {
    expect(applyVolumeStep(0, -0.02)).toEqual({ volume: 0, muted: true });
  });
});

describe('ScrubCoalescer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function coalescer(commits: number[], delayMs = 250) {
    return new ScrubCoalescer((target) => commits.push(target), delayMs);
  }

  it('does not commit before the delay elapses', () => {
    const commits: number[] = [];
    const scrub = coalescer(commits);
    scrub.nudge(10_000);
    vi.advanceTimersByTime(249);
    expect(commits).toEqual([]);
  });
  it('commits once, delayMs after the last nudge', () => {
    const commits: number[] = [];
    const scrub = coalescer(commits);
    scrub.nudge(10_000);
    vi.advanceTimersByTime(250);
    expect(commits).toEqual([10_000]);
    vi.advanceTimersByTime(1000);
    expect(commits).toEqual([10_000]);
  });
  it('reschedules on re-nudge and commits only the latest target', () => {
    const commits: number[] = [];
    const scrub = coalescer(commits);
    scrub.nudge(10_000);
    vi.advanceTimersByTime(200);
    scrub.nudge(20_000);
    vi.advanceTimersByTime(200);
    expect(commits).toEqual([]);
    vi.advanceTimersByTime(50);
    expect(commits).toEqual([20_000]);
  });
  it('clears target after the timer commits', () => {
    const commits: number[] = [];
    const scrub = coalescer(commits);
    expect(scrub.target).toBeNull();
    scrub.nudge(10_000);
    expect(scrub.target).toBe(10_000);
    vi.advanceTimersByTime(250);
    expect(scrub.target).toBeNull();
  });
  it('flush commits the latest target immediately and clears state', () => {
    const commits: number[] = [];
    const scrub = coalescer(commits);
    scrub.nudge(30_000);
    scrub.flush();
    expect(commits).toEqual([30_000]);
    expect(scrub.target).toBeNull();
    vi.advanceTimersByTime(1000);
    expect(commits).toEqual([30_000]);
  });
  it('cancel clears timer and target without committing', () => {
    const commits: number[] = [];
    const scrub = coalescer(commits);
    scrub.nudge(40_000);
    scrub.cancel();
    expect(scrub.target).toBeNull();
    vi.advanceTimersByTime(1000);
    expect(commits).toEqual([]);
  });
  it('flush with no pending nudge is a no-op', () => {
    const commits: number[] = [];
    const scrub = coalescer(commits);
    scrub.flush();
    expect(commits).toEqual([]);
  });
  it('honors a custom delay', () => {
    const commits: number[] = [];
    const scrub = coalescer(commits, 100);
    scrub.nudge(5_000);
    vi.advanceTimersByTime(100);
    expect(commits).toEqual([5_000]);
  });
});
