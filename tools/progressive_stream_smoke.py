#!/usr/bin/env python3
"""Controlled server-side smoke test for an incomplete qBittorrent stream.

The script reads qBittorrent credentials from the server's protected application
settings, never prints them, throttles only the newly-created test torrent, and
removes both the torrent and its files when the test finishes.
"""

from __future__ import annotations

import argparse
import http.cookiejar
import json
import subprocess
import time
import urllib.error
import urllib.parse
import urllib.request


def json_request(url: str, *, method: str = "GET", data: bytes | None = None) -> dict:
    request = urllib.request.Request(url, data=data, method=method)
    if data is not None:
        request.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(request, timeout=45) as response:
        body = response.read()
        return json.loads(body) if body else {}


def qb_opener(settings: dict) -> tuple[urllib.request.OpenerDirector, str]:
    base = settings["qbittorrentUrl"].rstrip("/")
    opener = urllib.request.build_opener(
        urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar())
    )
    login = urllib.parse.urlencode(
        {
            "username": settings["qbittorrentUsername"],
            "password": settings["qbittorrentPassword"],
        }
    ).encode()
    with opener.open(base + "/api/v2/auth/login", login, timeout=45) as response:
        if response.read(32).strip().lower() != b"ok.":
            raise RuntimeError("qBittorrent rejected the configured credentials")
    return opener, base


def qb_form(
    opener: urllib.request.OpenerDirector, base: str, endpoint: str, values: dict
) -> None:
    data = urllib.parse.urlencode(values).encode()
    with opener.open(base + endpoint, data, timeout=45) as response:
        if response.status // 100 != 2:
            raise RuntimeError(f"qBittorrent {endpoint} returned HTTP {response.status}")


def read_range(url: str, start: int, end: int) -> dict:
    request = urllib.request.Request(url, headers={"Range": f"bytes={start}-{end}"})
    started = time.monotonic()
    with urllib.request.urlopen(request, timeout=180) as response:
        body = response.read()
        expected = end - start + 1
        if response.status != 206 or len(body) != expected:
            raise RuntimeError(
                f"range {start}-{end} returned HTTP {response.status} and {len(body)} bytes"
            )
        return {
            "status": response.status,
            "bytes": len(body),
            "contentRange": response.headers.get("Content-Range"),
            "seconds": round(time.monotonic() - started, 3),
        }


def delete_with_retry(base: str, download_id: str) -> None:
    url = f"{base}/api/v1/downloads/{download_id}"
    for attempt in range(20):
        try:
            json_request(url, method="DELETE")
            return
        except urllib.error.HTTPError as error:
            if error.code != 409 or attempt == 19:
                raise
            time.sleep(0.25)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--release-id", required=True)
    parser.add_argument("--settings", required=True)
    parser.add_argument("--base-url", default="http://127.0.0.1:8097")
    parser.add_argument("--limit-bytes", type=int, default=2 * 1024 * 1024)
    parser.add_argument("--ffprobe", action="store_true")
    args = parser.parse_args()

    base = args.base_url.rstrip("/")
    with open(args.settings, encoding="utf-8") as handle:
        settings = json.load(handle)

    existing = json_request(base + "/api/v1/downloads").get("items", [])
    if any(str(item.get("releaseId")) == args.release_id for item in existing):
        raise RuntimeError("refusing to reuse or delete an existing download")

    prepared: dict | None = None
    opener: urllib.request.OpenerDirector | None = None
    qb_base = ""
    torrent_hash = ""
    try:
        prepared = json_request(
            f"{base}/api/v1/releases/{urllib.parse.quote(args.release_id)}/prepare",
            method="POST",
            data=b"{}",
        )
        engine_id = str(prepared["engineId"])
        if not engine_id.startswith("qb:"):
            raise RuntimeError("prepared download is not managed by qBittorrent")
        torrent_hash = engine_id.removeprefix("qb:")
        opener, qb_base = qb_opener(settings)
        qb_form(
            opener,
            qb_base,
            "/api/v2/torrents/setDownloadLimit",
            {"hashes": torrent_hash, "limit": str(args.limit_bytes)},
        )

        stream_url = base + prepared["streamUrl"]
        size = int(prepared["sizeBytes"])
        chunk = min(1024 * 1024, size)
        result = {
            "downloadId": prepared["id"],
            "preparedProgress": prepared["progress"],
            "startup": read_range(stream_url, 0, chunk - 1),
            "tail": read_range(stream_url, size - chunk, size - 1),
        }

        if args.ffprobe:
            probe = subprocess.run(
                [
                    "ffprobe",
                    "-v",
                    "error",
                    "-rw_timeout",
                    "120000000",
                    "-show_entries",
                    "format=format_name,duration",
                    "-of",
                    "json",
                    stream_url,
                ],
                check=False,
                capture_output=True,
                text=True,
                timeout=150,
            )
            result["ffprobe"] = {
                "exitCode": probe.returncode,
                "output": json.loads(probe.stdout or "{}"),
                "error": probe.stderr.strip()[:500],
            }
            if probe.returncode != 0:
                raise RuntimeError("ffprobe could not parse the progressive stream")

        current = json_request(base + "/api/v1/downloads").get("items", [])
        match = next(item for item in current if item["id"] == prepared["id"])
        result["verifiedProgress"] = match["progress"]
        result["playbackMode"] = match["playbackMode"]
        if float(match["progress"]) >= 1 or match["playbackMode"] != "progressive":
            raise RuntimeError("torrent completed before progressive playback was verified")
        print(json.dumps(result, indent=2, sort_keys=True))
        return 0
    finally:
        if opener is not None and qb_base and torrent_hash:
            try:
                qb_form(
                    opener,
                    qb_base,
                    "/api/v2/torrents/setDownloadLimit",
                    {"hashes": torrent_hash, "limit": "0"},
                )
            except Exception:
                # Deletion below remains authoritative; resetting first is a
                # safeguard if deletion is temporarily blocked by a lease.
                pass
        if prepared is not None:
            delete_with_retry(base, prepared["id"])


if __name__ == "__main__":
    raise SystemExit(main())
