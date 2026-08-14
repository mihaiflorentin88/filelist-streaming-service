#!/usr/bin/env python3
"""Merge the small, non-secret streaming policy into a qBittorrent config."""

from __future__ import annotations

import argparse
from pathlib import Path


MANAGED = {
    "Downloads\\PreAllocation": "false",
    "Downloads\\TempPathEnabled": "true",
    "Downloads\\UseIncompleteExtension": "false",
}


def managed_values(template: bytes | None = None) -> dict[str, str]:
    if template is None:
        return dict(MANAGED)
    values: dict[str, str] = {}
    section = ""
    for raw in template.decode("utf-8").splitlines():
        line = raw.strip()
        if line.startswith("[") and line.endswith("]"):
            section = line[1:-1]
        elif section == "Preferences" and "=" in line:
            key, value = line.split("=", 1)
            values[key] = value
    allowed = set(MANAGED) | {"Downloads\\TempPath"}
    if set(values) != allowed:
        raise ValueError("streaming template must contain only the four managed download settings")
    return values


def merge_config(original: bytes, temp_path: str, template: bytes | None = None) -> bytes:
    try:
        text = original.decode("utf-8")
    except UnicodeDecodeError as error:
        raise ValueError("qBittorrent config must be UTF-8") from error
    values = managed_values(template)
    values["Downloads\\TempPath"] = temp_path.rstrip("/") + "/"
    lines = text.splitlines(keepends=True)
    newline = "\r\n" if any(line.endswith("\r\n") for line in lines) else "\n"
    output: list[str] = []
    seen: set[str] = set()
    section = ""
    inserted = False

    def insert_missing() -> None:
        nonlocal inserted
        if inserted:
            return
        for key, value in values.items():
            if key not in seen:
                output.append(f"{key}={value}{newline}")
        inserted = True

    for line in lines:
        stripped = line.strip()
        if stripped.startswith("[") and stripped.endswith("]"):
            if section == "Preferences":
                insert_missing()
            section = stripped[1:-1]
            output.append(line)
            continue
        if section == "Preferences" and "=" in stripped and not stripped.startswith(("#", ";")):
            key = stripped.split("=", 1)[0]
            if key in values:
                ending = "\r\n" if line.endswith("\r\n") else "\n" if line.endswith("\n") else ""
                output.append(f"{key}={values[key]}{ending or newline}")
                seen.add(key)
                continue
        output.append(line)
    if section == "Preferences":
        insert_missing()
    if not inserted:
        if output and not output[-1].endswith(("\n", "\r\n")):
            output[-1] += newline
        output.append(f"[Preferences]{newline}")
        insert_missing()
    return "".join(output).encode("utf-8")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--temp-path", required=True)
    parser.add_argument("--template", type=Path)
    args = parser.parse_args()
    template = args.template.read_bytes() if args.template else None
    args.output.write_bytes(merge_config(args.input.read_bytes(), args.temp_path, template))


if __name__ == "__main__":
    main()
