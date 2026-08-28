# Specs — Player Fixes

Status: **IMPLEMENTED 2026-08-28** — Specs 1–2 shipped through tickets #23–#31 (decision ledger below records every resolved grill decision). Outstanding verification: the viewer's manual TV test (hide button, 2 s auto-hide, any-key reveal) and audible confirmation on household screens.

Scope: reported 2026-08-28 against the post-`0ffcba8` build:

1. Webapp plays with no sound (all content).
2. Player controls (both clients): auto-hide after 2 s + a manual hide button.
3. Tizen search found nothing — **closed as environmental** (FileList rate limiting); see Spec 3.

Environment constraints: no local installs; runtime verification against the Pi (`mihai@192.168.50.2`, service `http://192.168.50.2:8097`). The TV cannot be driven programmatically — Tizen verification is code-level plus user manual test. TV confirmed running the latest WGT (user-installed).

---

## Spec 1 — Controls: 2 s auto-hide + hide button (web + Tizen)

### Current state (facts)

| Aspect | Web | Tizen |
|---|---|---|
| Hide timer | 5000 ms, single literal `web/src.tsx:198` | 5000 ms inside `revealControls`, `clients/tizen/src/main.tsx:97` |
| Reveal triggers | `mousemove`/`keydown` on player root, `web/src.tsx:165-172` | every recognized remote key routes through `revealControls`, `main.tsx:249` |
| Paused behavior | hides anyway (`controlsHold` covers only panels/messages, `web/src.tsx:85`) | sticky while paused (`main.tsx:148`) |
| Cursor hiding | exists, CSS `web/style.css:1897-1905` | n/a |
| Manual hide button | none | none (toolbar row: Restart, −10s, Play, +10s, Audio, Subtitles, Options, Back — `main.tsx:313-317`, focus cols 0–7) |

Both clients already have the full hide machinery (`controlsVisible` state + `controls-visible` class + CSS); no new plumbing needed.

### Requirements

- R1: Controls auto-hide after **2000 ms** (supersedes the closed issue #18 contract of 5 s). One literal per client.
- R2: Auto-hide counting semantics — **RESOLVED (a)**: 2 s from the last qualifying input (pointer move, key press, tap), identical contract on both clients, applied **paused included**. The TV's sticky-on-pause is removed. *Flagged at grill close: this changes current TV behavior; user may veto during spec review.*
- R3: A manual **hide** control on the control bar on both clients — a faster way to hide than waiting for the timer; auto-hide itself unchanged. Web: button in `.player-control-row` (`web/src.tsx:208`). TV: new focusable toolbar item, focus grid renumbered (`main.tsx:314-317`), reveal via key handler branch when hidden (`main.tsx:232-249`).
- R4: Reveal-after-manual-hide — **RESOLVED (a, user-adjusted)**: TV reveals on any key (existing handler); web ignores reveal triggers for **0.5 s** after manual hide (user set 0.5 s over the proposed 2 s — a longer suppression reads as UI lag), then normal reveal behavior resumes.
- R5: Cursor hiding behavior unchanged; hidden state fully hides chrome (existing CSS reused).

### Acceptance criteria

- [ ] Both clients hide controls 2 s after the last qualifying input, paused included (R2).
- [ ] Both clients offer a visible hide affordance per R3; activating it hides controls immediately.
- [ ] Web: reveal triggers suppressed for 0.5 s after manual hide, then any mouse/key reveals (R4). TV: any key reveals; TV never gets stuck without controls.
- [ ] Web: cursor hides with chrome (regression-checked).
- [ ] Tizen manual test by user on real TV; web verified via browser against the Pi.

---

## Spec 2 — Webapp audio silence

### Current state (facts)

- Since `0ffcba8` the server never transcodes (ADR-0001); AC3/EAC3/DTS-class audio depends entirely on the client WASM decode chain: `web/src.tsx:124-136` → `web/audio-decode.ts` → `web/audio-decode-worker.ts` (`@ffmpeg/core` 0.12.10).
- **No fallback exists**: worker failing 3 windows ends the session with the video element still muted (`web/src.tsx:133`, `web/audio-decode-worker.ts:112-116`); a suspended `AudioContext` silently schedules nothing forever (`web/audio-decode.ts:105,166`). Failure modes are silent by design.
- Selection can force the decode route even for natively-playable files: English-first `preferredAudioTrack` (`clients/shared/src/index.ts:29`) + `multiTrackSwitch` (`web/src.tsx:125`).
- The served webapp is frozen into the Go binary (`go:embed`, `internal/adapters/httpapi/api.go:29-30`). **Verified 2026-08-28: Pi serves `index-ShIrJ_C8.js` / `index-D-cmht1l.css`, byte-identical to the repo's `internal/adapters/httpapi/static/index.html` — stale deployment ruled out.**
- `docs/KNOWN_ISSUES.md:11` records the decode path was verified on exactly one EAC3 title; audibility "still need[s] observation".
- Stale doc to clean up: `docs/SUBTITLES.md:33` still references the removed audio-only compatibility route.

### Root-cause diagnosis plan (implement phase; Pi-driven)

- D1: DONE — deployed bundle verified current (see Current state). Stale-deployment cause ruled out.
- D2: Scope **RESOLVED (Q3=a): all content is silent, every file.** Discriminating test: an AAC single-track file that should play natively through the element — if even that is silent, the defect is upstream of codec routing (element mute state, decode-lifecycle effect, volume wiring), not the WASM chain itself. Then pin the exact live-code cause: suspended `AudioContext`, decode-lifecycle misfire, or selection-forced decode route.
- D3: Fix root cause; failure contract **RESOLVED (Q7=b)**: loud visible error + automatic fallback to a natively-playable track when one exists; error only when nothing is playable.
- R-LOG (Q7 addendum): the decode chain logs verbose diagnostics to the browser console — route decision (native vs decode, and why), AudioContext state transitions, worker lifecycle (start / window decode / failure / EOS), fallback activation — so field-undfixable cases remain debuggable.

### Acceptance criteria

- [ ] Sound audible on the Pi-served webapp for all content classes (native-route and decode-route files).
- [ ] No decode failure can present as unexplained silence: user-visible signal, always.
- [ ] A file with ≥1 native-playable track always plays sound (auto-switch); error only when nothing is playable.
- [ ] Verbose console diagnostics per R-LOG observable in devtools during playback and during an induced failure.
- [ ] `docs/SUBTITLES.md` stale route reference removed (cleanup phase).

---

## Spec 3 — Tizen search — CLOSED (environmental)

**Resolution (Q4 + Q6):** TV runs the latest WGT and search works again; the outage coincided with FileList tracker rate limiting. No code defect — nothing to fix.

Defects the investigation surfaced (real, but **out of scope unless the user requests them**): TV search failures render invisibly (`main.tsx:382,411` — `detailMessage` only shows inside an open detail overlay), refetch errors swallowed (`:380,383,384`), sub-3-char queries 400 silently (`service.go:597-600`), SSE-down leaves async results silently missing, stale `category` filter can silently zero search results.

---

## Decision ledger (resolved 2026-08-28)

| Q | Decision | Status |
|---|---|---|
| Q1 | 2 s from last qualifying input, both clients, paused included (recommendation (a); TV sticky-pause removed — veto window open until specs approved) | Resolved |
| Q2 | Hide button on the control bar, both clients; auto-hide unchanged; button = faster manual hide | Resolved |
| Q3 | (a) All content silent, every file | Resolved |
| Q4 | Search was FileList rate limiting; works again | Resolved |
| Q5 | (a) suppression after manual hide, at **0.5 s** (user-adjusted from proposed 2 s) | Resolved |
| Q6 | TV runs the latest WGT build | Resolved |
| Q7 | (b) visible error + auto-fallback to native-playable track **+ verbose console logging** | Resolved |
