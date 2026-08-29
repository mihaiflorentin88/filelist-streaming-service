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
}

export const MAX_ANCHOR_PROBES = 5;
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
 * PTS, then returns the window plus the exact time trim that lands the first
 * scheduled sample on the target. Both directions move by the window's own
 * measured byte density, and a tail-clamped window is probed once before
 * giving up. Throws when the target is unreachable.
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
 for (let probe = 1; probe <= MAX_ANCHOR_PROBES; probe++) {
  const span = await fetchSpan(hint, requestLength);
  assertSpan(span);
  const trimMs = requestedMs - span.firstPtsMs;
  if (trimMs >= 0 && trimMs <= span.lastPtsMs - span.firstPtsMs) {
   return {
    startByte: span.startByte,
    lengthBytes: span.lengthBytes,
    trimMs,
    windowFirstPtsMs: span.firstPtsMs,
    windowLengthMs: span.lastPtsMs - span.firstPtsMs,
    probes: probe,
   };
  }
  const windowMs = span.lastPtsMs - span.firstPtsMs;
  const density = windowMs > 0 ? span.lengthBytes / windowMs : 0;
  if (span.firstPtsMs > requestedMs) {
   // Window content sits after the target: walk toward the file head by
   // the window's measured density.
   if (span.startByte <= 0) {
    break;
   }
   const back = density > 0 ? Math.round((span.firstPtsMs - requestedMs) * density) : windowBytes;
   const next = clamp(hint - Math.max(windowBytes, back), 0, maxStart);
   if (next === hint) {
    break;
   }
   hint = next;
   continue;
  }
  // Window content ends before the target: walk toward the file tail,
  // guided by the window's own measured byte density.
  const forward = density > 0 ? Math.round((requestedMs - span.lastPtsMs) * density) : windowBytes;
  const next = clamp(hint + Math.max(windowBytes, forward), 0, maxStart);
  if (next === hint) {
   break;
  }
  hint = next;
 }
 throw new Error(`audio anchor did not converge for ${requestedMs} ms within ${MAX_ANCHOR_PROBES} probes`);
}
