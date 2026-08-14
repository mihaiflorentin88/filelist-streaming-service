#!/usr/bin/env python3
"""Temporarily enable subnet-bypass access without touching qB credentials."""

from __future__ import annotations

import argparse
from pathlib import Path


VALUES = {
    "WebUI\\AuthSubnetWhitelist": "0.0.0.0/0",
    "WebUI\\AuthSubnetWhitelistEnabled": "true",
}


def enable(original: bytes) -> bytes:
    text = original.decode("utf-8")
    lines = text.splitlines(keepends=True)
    newline = "\r\n" if any(line.endswith("\r\n") for line in lines) else "\n"
    output: list[str] = []
    seen: set[str] = set()
    section = ""
    inserted = False

    def insert() -> None:
        nonlocal inserted
        if inserted:
            return
        for key, value in VALUES.items():
            if key not in seen:
                output.append(f"{key}={value}{newline}")
        inserted = True

    for line in lines:
        stripped = line.strip()
        if stripped.startswith("[") and stripped.endswith("]"):
            if section == "Preferences":
                insert()
            section = stripped[1:-1]
            output.append(line)
            continue
        if section == "Preferences" and "=" in stripped:
            key = stripped.split("=", 1)[0]
            if key in VALUES:
                ending = "\r\n" if line.endswith("\r\n") else "\n"
                output.append(f"{key}={VALUES[key]}{ending}")
                seen.add(key)
                continue
        output.append(line)
    if section == "Preferences":
        insert()
    if not inserted:
        if output and not output[-1].endswith(("\n", "\r\n")):
            output[-1] += newline
        output.append(f"[Preferences]{newline}")
        insert()
    return "".join(output).encode("utf-8")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    args.output.write_bytes(enable(args.input.read_bytes()))


if __name__ == "__main__":
    main()
