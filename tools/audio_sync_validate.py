#!/usr/bin/env python3
"""Automated audio-anchoring validation loop (ADR-0002).

For N byte windows across one managed source, compares the server's measured
audio-anchor span against what a decoder actually produces from the same
concatenated artifact (container head + fetch window):

  - decoder first PTS: piped `ffprobe -show_frames` (decoded frames — the same
    non-seekable-input path the web worker's ffmpeg decode uses)
  - decoder window duration: PCM length of the artifact minus the head's PCM

The server span matches the decoder within tolerance, and the implied trim
must be achievable, or the window fails. Exit code is nonzero when any window
fails, so this doubles as the red/green loop for anchoring fixes.
"""
import argparse
import json
import subprocess
import sys
import urllib.request

sys.path.insert(0, __file__.rsplit("/", 1)[0])
import progressive_stream_smoke as smoke  # noqa: E402

TOLERANCE_MS = 60


def scan_frames(ffprobe: str, media: bytes, stream_index: int) -> list:
    """Decoded-frame PTS list from a piped ffprobe (decoder-truth path)."""
    probe = subprocess.run(
        [ffprobe, "-v", "error", "-select_streams", "a",
         "-show_entries", "frame=stream_index,pts_time", "-of", "json", "pipe:0"],
        input=media, check=False, capture_output=True, timeout=150,
    )
    if probe.returncode != 0:
        raise RuntimeError(f"ffprobe frames failed: {probe.stderr.decode(errors='replace').strip()[:200]}")
    frames = []
    for entry in json.loads(probe.stdout or "{}").get("frames", []):
        if entry.get("stream_index") != stream_index:
            continue
        pts = entry.get("pts_time")
        if pts is None:
            continue
        frames.append(int(round(float(pts) * 1000)))
    return frames


def decode_ms(ffmpeg: str, media: bytes) -> int:
    return smoke.ffmpeg_decode_ms(ffmpeg, media)


def validate_window(*, base, source_id, stream_index, start, length, head_bytes, fetch_range, ffprobe, ffmpeg):
    head = fetch_range(0, head_bytes - 1)
    window = fetch_range(start, start + length - 1)
    artifact = head + window
    span = smoke.json_request(
        f"{base}/api/v1/downloads/{source_id}/audio-anchor?startByte={start}&lengthBytes={length}&streamIndex={stream_index}"
    )
    head_ms = decode_ms(ffmpeg, head)
    window_ms = decode_ms(ffmpeg, artifact) - head_ms
    # Frames carry no byte positions: drop the head's own audio frames by
    # scanning the head alone and keeping only frames past its last PTS.
    head_frames = scan_frames(ffprobe, head, stream_index)
    all_frames = scan_frames(ffprobe, artifact, stream_index)
    head_last = head_frames[-1] if head_frames else -1
    frames = [pts for pts in all_frames if pts > head_last]
    if not frames:
        return {"startByte": start, "error": "decoder produced no window frames", "ok": False}
    decoder_first = frames[0]
    server_first = int(span["firstPtsMs"])
    server_last = int(span["lastPtsMs"])
    delta = decoder_first - server_first
    trim_ok = 0 <= window_ms
    ok = abs(delta) <= TOLERANCE_MS and trim_ok
    return {
        "startByte": start,
        "serverFirstPtsMs": server_first,
        "decoderFirstPtsMs": decoder_first,
        "deltaMs": delta,
        "serverLastPtsMs": server_last,
        "decoderWindowMs": window_ms,
        "decoderSpanMs": frames[-1] - frames[0],
        "headLastPtsMs": head_last,
        "ok": ok,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base-url", default="http://192.168.50.2:8097")
    parser.add_argument("--source-id", required=True)
    parser.add_argument("--stream-index", type=int, default=1)
    parser.add_argument("--windows", type=int, default=8)
    parser.add_argument("--window-bytes", type=int, default=16 * 1024 * 1024)
    parser.add_argument("--head-bytes", type=int, default=2 * 1024 * 1024)
    parser.add_argument("--ffprobe", default="ffprobe")
    parser.add_argument("--ffmpeg", default="ffmpeg")
    args = parser.parse_args()

    base = args.base_url.rstrip("/")
    items = smoke.json_request(base + "/api/v1/downloads").get("items", [])
    download = next(item for item in items if item["id"] == args.source_id)
    size = int(download["sizeBytes"])
    stream_url = base + download["streamUrl"]

    def fetch_range(start: int, end: int) -> bytes:
        return smoke.fetch_range_bytes(stream_url, start, end)

    reports = []
    usable = size - args.head_bytes - args.window_bytes
    stride = max(1, usable // args.windows)
    for index in range(args.windows):
        start = args.head_bytes + index * stride
        if start + args.window_bytes > size:
            break
        try:
            report = validate_window(
                base=base, source_id=args.source_id, stream_index=args.stream_index,
                start=start, length=args.window_bytes, head_bytes=args.head_bytes,
                fetch_range=fetch_range, ffprobe=args.ffprobe, ffmpeg=args.ffmpeg,
            )
        except Exception as error:  # noqa: BLE001 — the loop must survive probe errors
            report = {"startByte": start, "error": str(error)[:200], "ok": False}
        reports.append(report)
        print(json.dumps(report), flush=True)

    failures = [report for report in reports if not report.get("ok")]
    print(json.dumps({"windows": len(reports), "failures": len(failures),
                      "maxAbsDeltaMs": max((abs(r.get("deltaMs", 0)) for r in reports), default=0)}))
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
