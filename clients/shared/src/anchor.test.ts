import { describe, expect, it } from "vitest";
import { MAX_ANCHOR_PROBES, planSessionStart, type AudioSpan } from "./anchor";

// A synthetic original file whose byte->PTS mapping is piecewise: dense
// opening (like an anime cold-open at high bitrate) then sparse. The span
// fetcher measures exactly what a decoder artifact would contain, mirroring
// the server's ffprobe-on-artifact contract (the server normalizes windows
// inside the head to zero and echoes the normalized start).
function denseThenSparseFile() {
  const windowBytes = 16 << 20;
  // [0, 130 MB) covers 0..508.5 s (532 B/ms); [130 MB, 270 MB) covers the
  // rest at ~245 B/ms. Requested 600 s in this file needs ~156 MB.
  const sparseStartByte = 130 << 20;
  const sparseStartPts = 508_500;
  const span = (start: number): AudioSpan => {
    const normalized = Math.max(0, start);
    const end = Math.min(normalized + windowBytes, 270 << 20);
    const ptsAt = (byte: number): number =>
      byte <= sparseStartByte ? Math.round(byte / 532) : sparseStartPts + Math.round((byte - sparseStartByte) / 245);
    return { streamIndex: 1, startByte: normalized, lengthBytes: end - normalized, firstPtsMs: ptsAt(normalized), lastPtsMs: ptsAt(end) };
  };
  return { windowBytes, fetchSpan: async (start: number) => span(start) };
}

function tableFile(): { windowBytes: number; fetchSpan: (start: number) => Promise<AudioSpan> } {
  // A perfectly uniform file: every window answers exactly (trivial oracle).
  const windowBytes = 16 << 20;
  return {
    windowBytes,
    fetchSpan: async (start: number) => ({
      streamIndex: 1,
      startByte: start,
      lengthBytes: windowBytes,
      firstPtsMs: Math.round(start / 500),
      lastPtsMs: Math.round((start + windowBytes) / 500),
    }),
  };
}

describe("planSessionStart", () => {
  it("anchors a uniform file in one probe when the estimate is exact", async () => {
    const { fetchSpan } = tableFile();
    const anchor = await planSessionStart(60_000, 30_000_000, 300 << 20, fetchSpan);
    expect(anchor.probes).toBe(1);
    expect(anchor.windowFirstPtsMs).toBe(60_000);
    expect(anchor.trimMs).toBe(0);
  });

  it("converges on dense-then-sparse content within the probe budget", async () => {
    const { windowBytes, fetchSpan } = denseThenSparseFile();
    const anchor = await planSessionStart(600_000, 124_700_000, 270 << 20, fetchSpan, windowBytes);
    expect(anchor.windowFirstPtsMs).toBeLessThanOrEqual(600_000);
    expect(anchor.windowFirstPtsMs).toBeGreaterThan(560_000);
    expect(anchor.trimMs).toBeGreaterThanOrEqual(0);
    expect(anchor.trimMs).toBeLessThan(40_000);
    expect(anchor.probes).toBeLessThanOrEqual(MAX_ANCHOR_PROBES);
  });

  it("walks backwards when the window content sits after the target", async () => {
    // Estimate lands at 200 s of content but the target is 60 s.
    const { windowBytes, fetchSpan } = tableFile();
    const anchor = await planSessionStart(60_000, 100 << 20, 300 << 20, fetchSpan, windowBytes);
    // The window's first content PTS sits at or before the target (a valid
    // anchor trims forward) and within one window of it.
    expect(anchor.windowFirstPtsMs).toBeLessThanOrEqual(60_000);
    expect(anchor.windowFirstPtsMs).toBeGreaterThan(60_000 - 33_555);
    expect(anchor.trimMs).toBe(60_000 - anchor.windowFirstPtsMs);
    expect(anchor.startByte).toBeLessThan(100 << 20);
    expect(anchor.probes).toBeLessThanOrEqual(MAX_ANCHOR_PROBES);
    void windowBytes;
  });

  it("normalizes estimates inside the container head to a zero window", async () => {
    const seen: number[] = [];
    const fetchSpan = async (start: number): Promise<AudioSpan> => {
      seen.push(start);
      const normalized = start < 2 << 20 ? 0 : start;
      return { streamIndex: 1, startByte: normalized, lengthBytes: (16 << 20) - normalized, firstPtsMs: Math.round(normalized / 500), lastPtsMs: Math.round(((16 << 20) - normalized + 100) / 500) };
    };
    const anchor = await planSessionStart(10_000, 1 << 19, 300 << 20, fetchSpan);
    expect(seen[0]).toBe(1 << 19); // the raw hint goes out; the server normalizes
    expect(anchor.startByte).toBe(0);
    expect(anchor.windowFirstPtsMs).toBe(0);
    expect(anchor.trimMs).toBe(10_000);
  });

  it("gives up after the probe budget when the target is beyond the file", async () => {
    const { windowBytes, fetchSpan } = tableFile();
    await expect(planSessionStart(10_000_000, 200 << 20, 300 << 20, fetchSpan, windowBytes)).rejects.toThrow(/did not converge/);
    void windowBytes;
  });
});
