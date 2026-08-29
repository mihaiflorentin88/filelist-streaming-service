import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { OsdLayer } from './osd';
import type { OsdFeedback } from './osd';

// Only fake the timers the OSD uses; preact's act() needs microtasks real.
beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }));
afterEach(() => vi.useRealTimers());

function mount(feedback: OsdFeedback | null, onHidden: () => void = () => { }) {
  const host = document.createElement('div');
  document.body.append(host);
  act(() => { render(<OsdLayer feedback={feedback} onHidden={onHidden} />, host) });
  return host;
}

function swap(host: HTMLElement, feedback: OsdFeedback | null, onHidden: () => void = () => { }) {
  act(() => { render(<OsdLayer feedback={feedback} onHidden={onHidden} />, host) });
}

describe('OsdLayer rendering', () => {
  it('renders nothing for null feedback', () => {
    const host = mount(null);
    expect(host.querySelector('.osd')).toBeNull();
  });

  it('renders seek feedback with ghost marker and hint', () => {
    const host = mount({ kind: 'seek', fraction: 0.25, hint: '+5s' });
    const root = host.querySelector('.osd')!;
    expect(root.getAttribute('role')).toBe('status');
    const ghost = root.querySelector('.osd-ghost')!;
    expect(ghost.getAttribute('style')).toBe('left: 25%;');
    expect(root.querySelector('.osd-hint-text')!.textContent).toBe('+5s');
  });

  it('renders volume feedback with track, fill and percent label', () => {
    const host = mount({ kind: 'volume', percent: 42 });
    const root = host.querySelector('.osd')!;
    const fill = root.querySelector('.osd-volume-fill')!;
    expect(root.querySelector('.osd-volume-track')).not.toBeNull();
    expect(fill.getAttribute('style')).toBe('width: 42%;');
    expect(root.querySelector('.osd-volume-label')!.textContent).toBe('42%');
  });

  it('renders volume feedback with a slider flash marker on the fill', () => {
    const host = mount({ kind: 'volume', percent: 42 });
    const fill = host.querySelector('.osd-volume-fill')!;
    expect(fill.classList.contains('osd-volume-flash')).toBe(true);
  });

  it('replaces the fill element when feedback identity changes so the flash restarts', () => {
    const host = mount({ kind: 'volume', percent: 40 });
    const first = host.querySelector('.osd-volume-fill')!;
    swap(host, { kind: 'volume', percent: 50 });
    const second = host.querySelector('.osd-volume-fill')!;
    expect(second).not.toBe(first);
    expect(second.classList.contains('osd-volume-flash')).toBe(true);
  });

  it('keeps the fill element while the feedback object is unchanged', () => {
    const feedback: OsdFeedback = { kind: 'volume', percent: 40 };
    const host = mount(feedback);
    const first = host.querySelector('.osd-volume-fill')!;
    swap(host, feedback);
    expect(host.querySelector('.osd-volume-fill')).toBe(first);
  });

  it('renders seek, mute and hint feedback without a volume flash marker', () => {
    expect(mount({ kind: 'seek', fraction: 0.5, hint: '+5s' }).querySelector('.osd-volume-flash')).toBeNull();
    expect(mount({ kind: 'mute', muted: true }).querySelector('.osd-volume-flash')).toBeNull();
    expect(mount({ kind: 'hint', text: 'Subtitles on' }).querySelector('.osd-volume-flash')).toBeNull();
  });

  it('renders mute feedback icon with accessible label', () => {
    const muted = mount({ kind: 'mute', muted: true });
    expect(muted.querySelector('.osd-mute-label svg')).not.toBeNull();
    expect(muted.querySelector('.osd-mute-label')!.getAttribute('aria-label')).toBe('Muted');
    const unmuted = mount({ kind: 'mute', muted: false });
    expect(unmuted.querySelector('.osd-mute-label')!.getAttribute('aria-label')).toBe('Sound on');
  });

  it('renders plain hint feedback', () => {
    const host = mount({ kind: 'hint', text: 'Subtitles on' });
    expect(host.querySelector('.osd-hint-text')!.textContent).toBe('Subtitles on');
  });

  it('renders exactly one feedback at a time (latest replaces)', () => {
    const host = mount({ kind: 'hint', text: 'first' });
    swap(host, { kind: 'hint', text: 'second' });
    expect(host.querySelectorAll('.osd').length).toBe(1);
    expect(host.querySelector('.osd-hint-text')!.textContent).toBe('second');
  });
});

describe('OsdLayer auto-hide', () => {
  it('calls onHidden once after 2000ms', () => {
    const onHidden = vi.fn();
    mount({ kind: 'hint', text: 'x' }, onHidden);
    vi.advanceTimersByTime(1999);
    expect(onHidden).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onHidden).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(5000);
    expect(onHidden).toHaveBeenCalledTimes(1);
  });

  it('restarts the timer when feedback identity changes', () => {
    const onHidden = vi.fn();
    const host = mount({ kind: 'hint', text: 'a' }, onHidden);
    vi.advanceTimersByTime(1500);
    swap(host, { kind: 'hint', text: 'b' }, onHidden);
    vi.advanceTimersByTime(1500);
    expect(onHidden).not.toHaveBeenCalled();
    vi.advanceTimersByTime(500);
    expect(onHidden).toHaveBeenCalledTimes(1);
  });

  it('runs no timer while feedback is null', () => {
    const onHidden = vi.fn();
    mount(null, onHidden);
    vi.advanceTimersByTime(10_000);
    expect(onHidden).not.toHaveBeenCalled();
  });
});
