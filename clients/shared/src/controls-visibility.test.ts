import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ControlsVisibility } from '@filelist/shared';

type Harness = { controls: ControlsVisibility; changes: boolean[] };

const create = (overrides: Partial<{ playing: boolean; panelOpen: boolean; statusShowing: boolean }> = {}): Harness => {
  const changes: boolean[] = [];
  const controls = new ControlsVisibility({
    policy: { armWhilePaused: true, statusHolds: true },
    onChange: visible => changes.push(visible),
    ...overrides,
  });
  return { controls, changes };
};

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('Controls visibility — browser policy', () => {
  it('hides once after two idle seconds, not a tick sooner', () => {
    const { controls, changes } = create();
    expect(controls.visible).toBe(true);
    controls.reveal();
    vi.advanceTimersByTime(1999);
    expect(controls.visible).toBe(true);
    vi.advanceTimersByTime(1);
    expect(changes).toEqual([false]);
    vi.advanceTimersByTime(60_000);
    expect(changes).toEqual([false]);
  });

  it('restarts the two seconds on every reveal', () => {
    const { controls } = create();
    controls.reveal();
    vi.advanceTimersByTime(1000);
    controls.reveal();
    vi.advanceTimersByTime(1999);
    expect(controls.visible).toBe(true);
    vi.advanceTimersByTime(1);
    expect(controls.visible).toBe(false);
  });

  it('hides while paused — playback state is not a hold', () => {
    const { controls } = create({ playing: true });
    controls.setPlaying(false);
    controls.reveal();
    vi.advanceTimersByTime(1999);
    expect(controls.visible).toBe(true);
    vi.advanceTimersByTime(1);
    expect(controls.visible).toBe(false);
  });

  it('pausing mid-count does not stop the hide', () => {
    const { controls } = create();
    controls.reveal();
    vi.advanceTimersByTime(1000);
    controls.setPlaying(false);
    vi.advanceTimersByTime(999);
    expect(controls.visible).toBe(true);
    vi.advanceTimersByTime(1);
    expect(controls.visible).toBe(false);
  });

  it('holds while a subtitle or audio panel is open and re-arms when it closes', () => {
    const { controls } = create();
    controls.setPanelOpen(true);
    controls.reveal();
    vi.advanceTimersByTime(60_000);
    expect(controls.visible).toBe(true);
    controls.setPanelOpen(false);
    controls.refresh();
    vi.advanceTimersByTime(1999);
    expect(controls.visible).toBe(true);
    vi.advanceTimersByTime(1);
    expect(controls.visible).toBe(false);
  });

  it('holds while a status message shows and re-arms when it clears', () => {
    const { controls } = create();
    controls.setStatus(true);
    controls.reveal();
    vi.advanceTimersByTime(60_000);
    expect(controls.visible).toBe(true);
    controls.setStatus(false);
    controls.refresh();
    vi.advanceTimersByTime(1999);
    expect(controls.visible).toBe(true);
    vi.advanceTimersByTime(1);
    expect(controls.visible).toBe(false);
  });

  it('re-arms from zero when a hold clears mid-count', () => {
    const { controls } = create();
    controls.reveal();
    vi.advanceTimersByTime(500);
    controls.setStatus(true);
    controls.refresh();
    vi.advanceTimersByTime(2000);
    expect(controls.visible).toBe(true);
    controls.setStatus(false);
    controls.refresh();
    vi.advanceTimersByTime(1999);
    expect(controls.visible).toBe(true);
    vi.advanceTimersByTime(1);
    expect(controls.visible).toBe(false);
  });

  it('dispose cancels the pending hide', () => {
    const { controls, changes } = create();
    controls.reveal();
    controls.dispose();
    vi.advanceTimersByTime(60_000);
    expect(controls.visible).toBe(true);
    expect(changes).toEqual([]);
  });
});

describe('Controls visibility — TV policy', () => {
  const createTV = (overrides: Partial<{ playing: boolean; panelOpen: boolean; statusShowing: boolean }> = {}): Harness => {
    const changes: boolean[] = [];
    const controls = new ControlsVisibility({
      policy: { armWhilePaused: true, statusHolds: false },
      onChange: visible => changes.push(visible),
      ...overrides,
    });
    return { controls, changes };
  };

  it('hides two seconds after a plain reveal while playing', () => {
    const { controls } = createTV({ playing: true });
    controls.reveal();
    vi.advanceTimersByTime(1999);
    expect(controls.visible).toBe(true);
    vi.advanceTimersByTime(1);
    expect(controls.visible).toBe(false);
  });

  it('hides while paused, like the browser — pausing is not a hold', () => {
    const { controls } = createTV({ playing: true });
    controls.setPlaying(false);
    controls.reveal();
    vi.advanceTimersByTime(1999);
    expect(controls.visible).toBe(true);
    vi.advanceTimersByTime(1);
    expect(controls.visible).toBe(false);
    controls.setPlaying(true);
    vi.advanceTimersByTime(60_000);
    expect(controls.visible).toBe(false);
  });

  it('holds while the menu is open and restarts the countdown after it closes', () => {
    const { controls } = createTV({ playing: true });
    controls.setPanelOpen(true);
    controls.reveal(true);
    vi.advanceTimersByTime(60_000);
    expect(controls.visible).toBe(true);
    controls.setPanelOpen(false);
    controls.reveal();
    vi.advanceTimersByTime(1999);
    expect(controls.visible).toBe(true);
    vi.advanceTimersByTime(1);
    expect(controls.visible).toBe(false);
  });

  it('sticky reveals (scrub, timeline) never arm while playing', () => {
    const { controls } = createTV({ playing: true });
    controls.reveal(true);
    vi.advanceTimersByTime(60_000);
    expect(controls.visible).toBe(true);
  });

  it('a plain reveal after a sticky one restarts the countdown', () => {
    const { controls } = createTV({ playing: true });
    controls.reveal(true);
    vi.advanceTimersByTime(1000);
    controls.reveal();
    vi.advanceTimersByTime(1999);
    expect(controls.visible).toBe(true);
    vi.advanceTimersByTime(1);
    expect(controls.visible).toBe(false);
  });

  it('ignores status messages — they are not a hold on TV', () => {
    const { controls } = createTV({ playing: true });
    controls.setStatus(true);
    controls.reveal();
    vi.advanceTimersByTime(1999);
    expect(controls.visible).toBe(true);
    vi.advanceTimersByTime(1);
    expect(controls.visible).toBe(false);
  });

  it('buffering holds and completion re-arms', () => {
    const { controls } = createTV({ playing: true });
    controls.setPlaying(false);
    controls.reveal(true);
    vi.advanceTimersByTime(60_000);
    expect(controls.visible).toBe(true);
    controls.setPlaying(true);
    controls.reveal();
    vi.advanceTimersByTime(1999);
    expect(controls.visible).toBe(true);
    vi.advanceTimersByTime(1);
    expect(controls.visible).toBe(false);
  });

  it('a scrub hold released by seek lands in an armed countdown', () => {
    const { controls } = createTV({ playing: true });
    controls.reveal(true);
    vi.advanceTimersByTime(400);
    controls.reveal();
    vi.advanceTimersByTime(1999);
    expect(controls.visible).toBe(true);
    vi.advanceTimersByTime(1);
    expect(controls.visible).toBe(false);
  });
});
