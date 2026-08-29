# Web Audio A/V Synchronization & Out-of-Band Audio Playback Prior Art

## 1. AudioContext Autoplay Policy & Gain Lifecycle
- **Suspended State & Triggers**: Modern browsers initialize or transition an `AudioContext` into `suspended` if created without prior user activation ([MDN Autoplay Guide](https://developer.mozilla.org/en-US/docs/Web/Media/Guides/Autoplay), [Chrome Autoplay Policy](https://developer.chrome.com/blog/web-audio-autoplay/)). A transient user activation gesture (`click`, `pointerup`, `touchend`, `keydown`) is required before `audioContext.resume()` resolves successfully ([HTML Spec: User Activation](https://html.spec.whatwg.org/multipage/interaction.html#tracking-user-activation)).
- **Recommended Pattern**: Instantiate or reuse an `AudioContext` and trigger `if (ctx.state === 'suspended') await ctx.resume();` directly inside the user gesture event handler before playback starts.
- **Gain Modification while Suspended**: Setting `GainNode.gain.value` or calling `AudioParam` automation methods (`setValueAtTime`) while `AudioContext` is `suspended` modifies the parameter state immediately without error ([W3C Web Audio API: AudioParam](https://www.w3.org/TR/webaudio/#AudioParam)). When the context subsequently transitions to `running` via `resume()`, audio rendering begins at the configured gain levels without artifacts.
- **Adoption for this repo**: Maintain a singleton `AudioContext`, un-suspend it inside the video play click/tap handler via `ctx.resume()`, and set initial volume directly via `gainNode.gain.value` regardless of context suspension state.

## 2. Precise A/V Clock Correlation (`getOutputTimestamp` & Latencies)
- **Clock Divergence**: `HTMLVideoElement.currentTime` tracks video frame presentation time, whereas `AudioContext.currentTime` is driven by monotonic hardware audio clock cycles ([MDN AudioContext.currentTime](https://developer.mozilla.org/en-US/docs/Web/API/BaseAudioContext/currentTime)).
- **A/V Output Timestamp Computation**: To correlate the audio timeline position that reaches the listener at wall-clock instant `performance.now()` with `video.currentTime`:
  - `AudioContext.getOutputTimestamp()` returns `{ contextTime, performanceTime }` mapping the audio graph time to the high-resolution `performance.now()` clock ([MDN getOutputTimestamp](https://developer.mozilla.org/en-US/docs/Web/API/AudioContext/getOutputTimestamp), [W3C AudioTimestamp](https://www.w3.org/TR/webaudio/#AudioTimestamp)).
  - Total output delay comprises `audioCtx.outputLatency` (hardware/Bluetooth buffer) + `audioCtx.baseLatency` (processing buffer) ([MDN outputLatency](https://developer.mozilla.org/en-US/docs/Web/API/AudioContext/outputLatency), [MDN baseLatency](https://developer.mozilla.org/en-US/docs/Web/API/AudioContext/baseLatency)).
  - The rendered audio timeline position at current time $T_{\text{now}}$ is:
    $$\text{currentAudioTime} = \text{contextTime} + \frac{T_{\text{now}} - \text{performanceTime}}{1000} - (\text{audioCtx.outputLatency} + \text{audioCtx.baseLatency})$$
  - Fallback when `getOutputTimestamp` is unavailable: $\text{currentAudioTime} = \text{audioCtx.currentTime} - (\text{audioCtx.outputLatency} \parallel 0) - (\text{audioCtx.baseLatency} \parallel 0)$.
- **Adoption for this repo**: Calculate audio playback position relative to `video.currentTime` using `audioCtx.getOutputTimestamp()` minus `(outputLatency + baseLatency)` to account for Bluetooth and audio pipeline delays.

## 3. Drift Correction Without Restarts (`playbackRate` Nudging)
- **Phase-Locked Loop (PLL) Nudge Technique**: Stopping/restarting an `AudioBufferSourceNode` or seeking `<video>` introduces audible pops and frame drops. Web players maintain phase-lock by micro-adjusting `source.playbackRate` within a subtle band ($1.0 \pm 0.05$) to dynamically correct clock skew ([W3C Web Audio Issue #2397](https://github.com/WebAudio/web-audio-api/issues/2397)).
- **Threshold Tiers**:
  - Drift $|\Delta| < 15\,\text{ms}$: In-sync deadband, `playbackRate = 1.0`.
  - Drift $15\,\text{ms} \le |\Delta| \le 200\,\text{ms}$: Nudge `playbackRate = 1.0 + clamp(-0.05, 0.05, k_p \cdot \Delta)` to glide audio into sync without noticeable pitch distortion.
  - Drift $|\Delta| > 200\,\text{ms}$: Hard resync required (cancel scheduled nodes, flush buffer, reschedule at `video.currentTime`).
- **Open-Source Implementations**:
  - [Shaka Player Playhead Drift Control](https://github.com/shaka-project/shaka-player/blob/main/lib/media/playhead.js) (adjusts `playbackRate` within $0.95\times - 1.05\times$ to align buffer clocks with media presentation timeline).
  - [video-sync / WatchParty WebRTC implementations](https://github.com/rudra-sah00/nightwatch/blob/main/docs/features/WATCH_PARTY.md) (uses continuous PID rate micro-adjustments for multi-client stream synchronization).
  - [Warp Player by Eyevinn](https://github.com/Eyevinn/warp-player) (maintains WebAudio/WebCodecs clock synchronization loop via rate adjustments).
- **Adoption for this repo**: Implement a 250ms periodic drift check adjusting active `AudioBufferSourceNode.playbackRate` between `0.97` and `1.03` when drift is between 20ms and 150ms, avoiding jarring audio restarts.

## 4. Scheduling Decoded AudioBuffers Against a Moving Video Clock
- **Flaws of `onended` Event-Driven Scheduling**: The `AudioScheduledSourceNode.onended` callback runs asynchronously on the JavaScript main thread. Main thread contention, GC pauses, and timer throttling delay the event, leading to audible gaps and cumulative clock drift ([MDN AudioScheduledSourceNode: onended](https://developer.mozilla.org/en-US/docs/Web/API/AudioScheduledSourceNode/ended_event)).
- **Predictive Timeline Scheduling (`start(when)`)**:
  - Pre-schedule consecutive buffers using explicit `when` parameters on the `AudioContext.currentTime` timeline ([MDN AudioBufferSourceNode.start](https://developer.mozilla.org/en-US/docs/Web/API/AudioScheduledSourceNode/start), [MDN BaseAudioContext.currentTime](https://developer.mozilla.org/en-US/docs/Web/API/BaseAudioContext/currentTime)).
  - Maintain a timeline cursor: `nextStartTime = Math.max(audioCtx.currentTime + lookahead, expectedAudioTime)`.
  - For each decoded PCM slice: call `sourceNode.start(nextStartTime)` and advance `nextStartTime += buffer.duration`.
  - Maintain a lookahead buffer window (e.g. 200–500ms ahead of current time) to ensure the audio thread never starves.
- **Adoption for this repo**: Eliminate `onended` chaining; queue decoded PCM slices by pre-calculating continuous `start(nextStartTime)` timeline offsets with a 300ms lookahead window.

## 5. In-Browser MKV/EAC3 Demuxing & Decoding (ffmpeg.wasm / WebCodecs)
- **Architecture**: Web media players decoding EAC3/DDP (such as [libmedia](https://github.com/zhaohappy/libmedia) and [movi-player](https://github.com/MrUjjwalG/movi-player)) demux containers in a Web Worker, decode compressed EAC3 packets via `ffmpeg.wasm` into planar Float32 PCM arrays, and schedule playback via `AudioContext` while the `<video>` element plays muted.
- **Seek Handling (Drop-and-Refill vs Nudge)**:
  - On user seek (`seeking` / `seeked` events): Players perform a drop-and-refill: immediately call `sourceNode.stop()`, clear pending PCM queues, flush decoder buffers (`avcodec_flush_buffers`), seek demuxer to the target keyframe, and re-anchor audio scheduling at `video.currentTime` ([movi-player sync pipeline](https://github.com/mrujjwalg/movi-player)).
  - Rate nudges are used exclusively for steady-state clock drift, not seeks.
- **Volume & Mute Control**:
  - The `<video>` element remains permanently muted (`video.muted = true`, `video.volume = 0`) to comply with browser autoplay policies.
  - UI volume and mute states are applied directly to a master `GainNode` via `gainNode.gain.setValueAtTime(vol, audioCtx.currentTime)` ([W3C Web Audio API: GainNode](https://www.w3.org/TR/webaudio/#GainNode)).
  - For 5.1 surround sound: explicitly configure `audioCtx.destination.channelCount = 6` and `channelInterpretation = 'discrete'` to prevent unwanted stereo downmixing ([W3C Web Audio API: Channel Rules](https://www.w3.org/TR/webaudio/#ChannelOrdering)).
- **Adoption for this repo**: On `video.onseeked`, flush the Wasm audio queue and abort in-flight buffer nodes; route all UI volume and mute interactions through the master `GainNode` while keeping `<video>` muted.
