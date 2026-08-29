// Measured audio anchoring for client-decoded sessions (ADR-0002): a seek
// hint may pick what bytes to download, but the content that plays is placed
// by measured PTS from the server's audio-span probe.

export interface AudioSpan {
 streamIndex: number;
 startByte: number;
 lengthBytes: number;
 firstPtsMs: number;
 lastPtsMs: number;
}

export type SpanFetcher = (startByte: number, lengthBytes: number) => Promise<AudioSpan>;

export interface SessionAnchor {
 startByte: number;
 lengthBytes: number;
 /** Time to drop from the start of the decoded window audio, in ms. */
 trimMs: number;
 /** Measured PTS of the window's first audio sample (ffprobe truth). */
 windowFirstPtsMs: number;
 /** Measured duration of the window's audio content (lastPtsMs - firstPtsMs). */
 windowLengthMs: number;
 probes: number;
 /** True when the target fell in a cluster-boundary seam between windows and
  * the nearest reachable window was accepted with a clamped trim instead. */
 degradedMs?: number;
}

export const MAX_ANCHOR_PROBES = 8;
export const ANCHOR_WINDOW_BYTES = 16 << 20;

const assertFinite = (value: number, name: string): number => {
 if (!Number.isFinite(value)) {
  throw new Error(`${name} must be a finite number`);
 }
 return value;
};

const assertSpan = (span: AudioSpan): void => {
 for (const [name, value] of Object.entries(span)) {
  if (!Number.isFinite(value)) {
   throw new Error(`audio span ${name} must be a finite number`);
  }
 }
 if (span.lengthBytes < 1) {
  throw new Error("audio span window is empty");
 }
};

const clamp = (value: number, low: number, high: number): number => Math.min(Math.max(value, low), high);

/**
 * Plans the decode session for a requested position: probes measured audio
 * spans (at most MAX_ANCHOR_PROBES) until a window contains the requested
 * PTS. Both directions move by the window's own measured byte density; when
 * a step overshoots into a ping-pong across the target (small targets sit in
 * cluster-boundary seams between adjacent windows), the search bisects
 * between the two straddling hints. If no window contains the target exactly,
 * the nearest reachable window is accepted with a clamped trim and a
 * `degradedMs` report instead of failing playback. Throws only when nothing
 * at all was measured.
 */
export async function planSessionStart(
 requestedMs: number,
 estimateBytes: number,
 totalBytes: number,
 fetchSpan: SpanFetcher,
 windowBytes: number = ANCHOR_WINDOW_BYTES,
): Promise<SessionAnchor> {
 assertFinite(requestedMs, "requestedMs");
 assertFinite(estimateBytes, "estimateBytes");
 assertFinite(totalBytes, "totalBytes");
 if (requestedMs < 0) {
  throw new Error("requestedMs must not be negative");
 }
 if (totalBytes < 1) {
  throw new Error("totalBytes must be at least 1");
 }
 const requestLength = Math.min(windowBytes, totalBytes);
 const maxStart = Math.max(0, totalBytes - requestLength);
 let hint = clamp(Math.round(estimateBytes), 0, maxStart);
 const measured = new Map<number, { first: number; last: number; span: AudioSpan }>();
 let previous = -1;
 for (let probe = 1; probe <= MAX_ANCHOR_PROBES; probe++) {
  const span = await fetchSpan(hint, requestLength);
  assertSpan(span);
  measured.set(hint, { first: span.firstPtsMs, last: span.lastPtsMs, span });
  const trimMs = requestedMs - span.firstPtsMs;
  const windowMs = span.lastPtsMs - span.firstPtsMs;
  // A discontinuous window (lastPtsMs < firstPtsMs, valid per packet-order
  // measurement) has no PTS-derivable length: accept it on trim >= 0 and
  // report an unbounded length so the controller's replan guard never
  // triggers on it.
  if (windowMs < 0 && trimMs >= 0) {
   return {
    startByte: span.startByte,
    lengthBytes: span.lengthBytes,
    trimMs,
    windowFirstPtsMs: span.firstPtsMs,
    windowLengthMs: Number.POSITIVE_INFINITY,
    probes: probe,
   };
  }
  if (trimMs >= 0 && trimMs <= windowMs) {
   return {
    startByte: span.startByte,
    lengthBytes: span.lengthBytes,
    trimMs,
    windowFirstPtsMs: span.firstPtsMs,
    windowLengthMs: windowMs,
    probes: probe,
   };
  }
  const density = windowMs > 0 ? span.lengthBytes / windowMs : 0;
  if (span.firstPtsMs > requestedMs) {
   // Window content sits after the target: walk toward the file head by
   // the window's measured density.
   if (span.startByte <= 0) {
    break;
   }
   const back = density > 0 ? Math.round((span.firstPtsMs - requestedMs) * density) : windowBytes;
   const next = clamp(hint - Math.max(windowBytes, back), 0, maxStart);
   if (next === hint || measured.has(next)) {
    hint = bisect(previous === -1 ? 0 : previous, hint, maxStart);
    if (measured.has(hint)) {
     break;
    }
    previous = hint;
    continue;
   }
   previous = hint;
   hint = next;
   continue;
  }
  // Window content ends before the target: walk toward the file tail,
  // guided by the window's own measured byte density.
  const forward = density > 0 ? Math.round((requestedMs - span.lastPtsMs) * density) : windowBytes;
  const next = clamp(hint + Math.max(windowBytes, forward), 0, maxStart);
  if (next === hint || measured.has(next)) {
   hint = bisect(previous === -1 ? maxStart : previous, hint, maxStart);
   if (measured.has(hint)) {
    break;
   }
   previous = hint;
   continue;
  }
  previous = hint;
  hint = next;
 }
 if (measured.size === 0) {
  throw new Error(`audio anchor measured no windows for ${requestedMs} ms`);
 }
 // No probed window contains the target exactly: it sits in a seam between
 // adjacent windows (cluster-boundary rounding). Accept the nearest window
 // with a clamped trim rather than failing playback.
 let best: { hint: number; distance: number } | undefined;
 for (const [key, entry] of measured) {
  const distance = requestedMs < entry.first ? entry.first - requestedMs : requestedMs > entry.last ? requestedMs - entry.last : 0;
  if (best === undefined || distance < best.distance) {
   best = { hint: key, distance };
  }
 }
 if (best === undefined) {
    throw new Error(`audio anchor measured no windows for ${requestedMs} ms`);
  }
  const entry = measured.get(best.hint)!;
 const trimMs = clamp(requestedMs - entry.first, 0, entry.last - entry.first);
 return {
  startByte: entry.span.startByte,
  lengthBytes: entry.span.lengthBytes,
  trimMs,
  windowFirstPtsMs: entry.first,
  windowLengthMs: entry.last - entry.first,
  probes: measured.size,
  degradedMs: best.distance === 0 ? undefined : Math.round(best.distance),
 };
}

function bisect(low: number, high: number, maxStart: number): number {
 const a = clamp(Math.min(low, high), 0, maxStart);
 const b = clamp(Math.max(low, high), 0, maxStart);
 return clamp(Math.round((a + b) / 2), 0, maxStart);
}
