// Shared, framework-free controls-visibility state machine for both players
// (browser and TV). Players feed it events — reveals, playback state, panel and
// status state — and apply the visibility it emits; per-client differences are
// policy parameters, not divergent logic.
export interface ControlsVisibilityPolicy {
  /** True hides controls regardless of playback state; false makes a paused/buffered/waiting player hold them. */
  armWhilePaused: boolean;
  /** True holds controls while a transient status message shows (browser); false ignores status (TV). */
  statusHolds: boolean;
  /** Web capability: reveal triggers within this many milliseconds of a manual hide are ignored, so the pointer cannot instantly undo the button. 0 or omitted disables it (TV). */
  manualHideSuppressionMs?: number;
}

export interface ControlsVisibilityOptions {
  policy: ControlsVisibilityPolicy;
  onChange: (visible: boolean) => void;
  timeoutMs?: number;
  playing?: boolean;
  panelOpen?: boolean;
  statusShowing?: boolean;
}

export class ControlsVisibility {
  #policy: ControlsVisibilityPolicy;
  #onChange: (visible: boolean) => void;
  #timeoutMs: number;
  #playing: boolean;
  #panelOpen: boolean;
  #statusShowing: boolean;
  #suppressMs: number;
  #suppressUntil = 0;
  #visible = true;
  // Pending-hide timeout id, 0 when idle. Browsers hand back a numeric id; the
  // node typings leaking into the type programs use a Timeout object, so the
  // assignment casts back to the numeric contract.
  #hideTimer: number = 0;

  constructor(options: ControlsVisibilityOptions) {
    this.#policy = options.policy;
    this.#onChange = options.onChange;
    this.#timeoutMs = options.timeoutMs ?? 2000;
    this.#playing = options.playing ?? false;
    this.#panelOpen = options.panelOpen ?? false;
    this.#statusShowing = options.statusShowing ?? false;
    this.#suppressMs = options.policy.manualHideSuppressionMs ?? 0;
  }

  get visible(): boolean {
    return this.#visible;
  }

  /** A qualifying input arrived (pointer move, key press, remote key, tap). `hold` reveals without arming the hide timer (TV sticky reveals). */
  reveal(hold = false): void {
    if (Date.now() < this.#suppressUntil) return;
    if (!this.#visible) {
      this.#visible = true;
      this.#onChange(true);
    }
    this.#schedule(!hold);
  }

  /** Manual hide (the hide button): dismiss now, holds notwithstanding, and open the reveal-suppression window. */
  hide(): void {
    this.#cancelHide();
    this.#suppressUntil = this.#suppressMs > 0 ? Date.now() + this.#suppressMs : 0;
    if (this.#visible) {
      this.#visible = false;
      this.#onChange(false);
    }
  }

  setPlaying(playing: boolean): void {
    this.#playing = playing;
  }

  setPanelOpen(open: boolean): void {
    this.#panelOpen = open;
  }

  setStatus(showing: boolean): void {
    this.#statusShowing = showing;
  }

  /** Re-evaluate after a hold input changed without a reveal (browser hold-conditions effect). */
  refresh(): void {
    this.#schedule(true);
  }

  dispose(): void {
    this.#cancelHide();
  }

  #cancelHide(): void {
    if (this.#hideTimer) {
      clearTimeout(this.#hideTimer);
      this.#hideTimer = 0;
    }
  }

  #schedule(allowed: boolean): void {
    this.#cancelHide();
    if (!allowed || !this.#visible) return;
    if (!(this.#policy.armWhilePaused || this.#playing) || this.#panelOpen || (this.#policy.statusHolds && this.#statusShowing)) return;
    this.#hideTimer = setTimeout(() => {
      this.#hideTimer = 0;
      this.#visible = false;
      this.#onChange(false);
    }, this.#timeoutMs) as unknown as number;
  }
}
