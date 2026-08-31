#!/usr/bin/env python3
"""Build and validate an Apps2Samsung-compatible Tizen WGT package."""

from __future__ import annotations

import argparse
import hashlib
import os
from pathlib import Path, PurePosixPath
import re
import struct
import tempfile
import xml.etree.ElementTree as ET
import zipfile

MAX_UNCOMPRESSED_SIZE = 128 * 1024 * 1024
HTML_REFERENCE = re.compile(rb"(?:src|href)\s*=\s*[\"']([^\"']+)[\"']", re.I)
SIGNATURE = re.compile(r"^(?:author-signature|signature[0-9]+)\.xml$")
PACKAGE_ID = re.compile(r"^[A-Za-z0-9]{10}$")
MODULE_SCRIPT = re.compile(rb"<script\b[^>]*\btype\s*=\s*[\"']module[\"']", re.I)
MODULE_PRELOAD = re.compile(rb"<link\b[^>]*\brel\s*=\s*[\"']modulepreload[\"']", re.I)
CSS_GAP_PROPERTY = re.compile(rb"(?:\A\s*|[{;]\s*)(column-gap|grid-gap|row-gap|gap)\s*:", re.I)
STYLE_BLOCK = re.compile(rb"<style\b[^>]*>(.*?)</style>", re.I | re.S)
ENGINE_FLOOR_APIS: tuple[tuple[str, re.Pattern[bytes]], ...] = (
    # Call shapes the Tizen 5.0 floor engine (Chromium 63) lacks. Method rules
    # anchor to the calling dot so longer identifiers cannot match: '.charAt('
    # and '.split(' never trip the '.at(' rule, 'flatMapless' never trips
    # '.flatMap('. Owner-qualified rules (Object/Promise) pin the receiver so a
    # user-defined 'x.allSettled(' does not false-positive. globalThis anchors
    # to member access ('globalThis.' / 'globalThis[') because that is the
    # crash shape: a bare 'typeof globalThis' guard is safe by construction and
    # comment prose such as 'globalThis does not exist' must pass. A bare value
    # read ('var g = globalThis') also crashes on the floor but is deliberately
    # unmatched so prose passes; the headless smoke is the backstop for it.
    ("flatMap", re.compile(rb"\.\s*flatMap\s*\(")),
    ("flat", re.compile(rb"\.\s*flat\s*\(")),
    ("Object.fromEntries", re.compile(rb"\bObject\s*\.\s*fromEntries\s*\(")),
    ("globalThis", re.compile(rb"\bglobalThis\s*(?:\.|\[)")),
    ("String.replaceAll", re.compile(rb"\.\s*replaceAll\s*\(")),
    ("matchAll", re.compile(rb"\.\s*matchAll\s*\(")),
    ("structuredClone", re.compile(rb"\bstructuredClone\s*\(")),
    ("Promise.allSettled", re.compile(rb"\bPromise\s*\.\s*allSettled\s*\(")),
    ("Promise.any", re.compile(rb"\bPromise\s*\.\s*any\s*\(")),
    (".at", re.compile(rb"\.\s*at\s*\(")),
    ("ResizeObserver", re.compile(rb"\bnew\s+ResizeObserver\b|\bResizeObserver\s*\(")),
)


class WGTError(ValueError):
    """An invalid or incompatible WGT package."""


def local_name(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def parse_version(value: str, *, widget: bool = False) -> tuple[int, int, int]:
    parts = value.split(".")
    if (widget and len(parts) != 3) or not 1 <= len(parts) <= 3:
        raise WGTError(f"{value!r} has an invalid component count")
    try:
        numbers = [int(part) for part in parts]
    except ValueError as error:
        raise WGTError(f"{value!r} must contain only numbers") from error
    if any(number < 0 for number in numbers):
        raise WGTError(f"{value!r} must contain non-negative numbers")
    numbers.extend([0] * (3 - len(numbers)))
    if widget and (numbers[0] > 255 or numbers[1] > 255 or numbers[2] > 65535):
        raise WGTError(f"{value!r} exceeds Tizen widget version limits")
    return tuple(numbers)


def is_signature(name: str) -> bool:
    return SIGNATURE.fullmatch(PurePosixPath(name).name) is not None


def collect_entries(source: Path, config: Path, icon: Path) -> dict[str, bytes]:
    if not source.is_dir():
        raise WGTError(f"frontend source {source} is not a directory; build it first")
    entries: dict[str, bytes] = {}
    for file in sorted(source.rglob("*")):
        if not file.is_file():
            continue
        name = file.relative_to(source).as_posix()
        if name == "config.xml" or is_signature(name):
            continue
        entries[name] = file.read_bytes()
    for file in (config, icon):
        if not file.is_file():
            raise WGTError(f"required package file {file} does not exist")
        entries[file.name] = file.read_bytes()
    return entries


def write_archive(output: Path, entries: dict[str, bytes]) -> None:
    output.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(prefix=".wgt-", suffix=".tmp", dir=output.parent)
    os.close(descriptor)
    temporary = Path(temporary_name)
    try:
        with zipfile.ZipFile(temporary, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
            for name in sorted(entries):
                info = zipfile.ZipInfo(name, date_time=(2000, 1, 1, 0, 0, 0))
                info.compress_type = zipfile.ZIP_DEFLATED
                info.external_attr = 0o100644 << 16
                archive.writestr(info, entries[name])
        temporary.replace(output)
    finally:
        temporary.unlink(missing_ok=True)


def read_archive(file: Path) -> tuple[dict[str, bytes], bool]:
    if file.suffix != ".wgt":
        raise WGTError("package filename must end in .wgt")
    files: dict[str, bytes] = {}
    total = 0
    signed = False
    try:
        with zipfile.ZipFile(file) as archive:
            for info in archive.infolist():
                name = info.filename
                path = PurePosixPath(name)
                if not name or name.startswith("/") or "\\" in name or ".." in path.parts:
                    raise WGTError(f"unsafe archive path {name!r}")
                if name in files:
                    raise WGTError(f"duplicate archive entry {name!r}")
                if info.is_dir():
                    continue
                total += info.file_size
                if total > MAX_UNCOMPRESSED_SIZE:
                    raise WGTError("uncompressed package exceeds 128 MiB validation limit")
                files[name] = archive.read(info)
                signed = signed or is_signature(name)
    except (OSError, zipfile.BadZipFile) as error:
        raise WGTError(f"cannot open WGT as ZIP: {error}") from error
    return files, signed


def child(root: ET.Element, name: str) -> ET.Element | None:
    return next((element for element in root if local_name(element.tag) == name), None)


def children(root: ET.Element, name: str) -> list[ET.Element]:
    return [element for element in root if local_name(element.tag) == name]


def validate_manifest(config: bytes, files: dict[str, bytes], target: str) -> tuple[str, str, str, str]:
    try:
        root = ET.fromstring(config)
    except ET.ParseError as error:
        raise WGTError(f"cannot parse config.xml: {error}") from error
    if local_name(root.tag) != "widget":
        raise WGTError("config.xml root must be widget")
    parse_version(root.attrib.get("version", ""), widget=True)

    application = child(root, "application")
    if application is None:
        raise WGTError("Tizen application declaration is missing")
    package = application.attrib.get("package", "")
    app_id = application.attrib.get("id", "")
    required_text = application.attrib.get("required_version", "")
    if not PACKAGE_ID.fullmatch(package):
        raise WGTError("Tizen package ID must contain exactly 10 ASCII letters or digits")
    if not app_id.startswith(package + "."):
        raise WGTError("Tizen application ID must start with the package ID and a dot")
    required = parse_version(required_text)
    if required > parse_version(target):
        raise WGTError(f"package requires Tizen {required_text} but target TV is Tizen {target}")

    if not any(element.attrib.get("name") == "tv-samsung" for element in children(root, "profile")):
        raise WGTError("config.xml must declare the tv-samsung profile")
    content = child(root, "content")
    icon = child(root, "icon")
    for label, element in (("content", content), ("icon", icon)):
        name = element.attrib.get("src", "") if element is not None else ""
        if not name:
            raise WGTError(f"{label} path is missing from config.xml")
        if name not in files:
            raise WGTError(f"{label} file {name!r} is missing from WGT")

    privileges = {element.attrib.get("name") for element in children(root, "privilege")}
    for required_privilege in (
        "http://tizen.org/privilege/internet",
        "http://tizen.org/privilege/download",
        "http://tizen.org/privilege/tv.inputdevice",
    ):
        if required_privilege not in privileges:
            raise WGTError(f"required privilege {required_privilege!r} is missing")
    if "http://tizen.org/privilege/vpnservice" in privileges:
        raise WGTError("partner-only vpnservice privilege is not compatible with Apps2Samsung public signing")
    if not any(element.attrib.get("origin") == "*" for element in children(root, "access")):
        raise WGTError("wildcard network access is required for the browser-configured server URL")
    return app_id, required_text, content.attrib["src"], icon.attrib["src"]


def validate_html_references(html: bytes, files: dict[str, bytes]) -> None:
    for match in HTML_REFERENCE.finditer(html):
        reference = match.group(1).decode("utf-8")
        if reference.startswith(("$WEBAPIS/", "http:", "https:", "data:", "blob:", "#")):
            continue
        reference = PurePosixPath(reference.split("?", 1)[0].lstrip("/")).as_posix()
        if reference and reference not in files:
            raise WGTError(f"HTML references missing bundled asset {reference!r}")


def validate_classic_tv_bootstrap(html: bytes, files: dict[str, bytes]) -> None:
    if MODULE_SCRIPT.search(html) or MODULE_PRELOAD.search(html):
        raise WGTError("Tizen entry point must use classic scripts, not ES modules")
    for required in (b"$WEBAPIS/webapis/webapis.js", b"startup.js", b"app.js"):
        if required not in html:
            raise WGTError(f"Tizen entry point is missing {required.decode()!r}")
    app = files.get("app.js", b"")
    if not app:
        raise WGTError("classic application bundle app.js is missing or empty")
    if re.search(rb"(?m)^\s*(?:import|export)\s", app):
        raise WGTError("app.js still contains an ES module import or export")


def validate_avplay_lifecycle(html: bytes, files: dict[str, bytes]) -> None:
    if b"application/avplayer" in html:
        raise WGTError("AVPlay surface must not exist in startup HTML; create it only in the playback view")
    app = files.get("app.js", b"")
    for token in (
        b"application/avplayer",
        b".open(",
        b"setDisplayRect",
        b"prepareAsync",
        b".stop(",
        b".close(",
    ):
        if token not in app:
            raise WGTError(f"app.js is missing required AVPlay lifecycle token {token.decode()!r}")

def validate_app_engine_floor(files: dict[str, bytes]) -> None:
    # Static gate over every shipped script, including the verbatim boot scripts
    # the ES5-only rule exists for. Comments or strings that mention a call shape
    # can still reject; the headless smoke run is the dynamic backstop.
    for script in ("app.js", "startup.js", "fatal-error.js"):
        data = files.get(script)
        if data is None:
            continue
        missing = [name for name, pattern in ENGINE_FLOOR_APIS if pattern.search(data)]
        if missing:
            raise WGTError(
                f"{script!r} uses {len(missing)} floor-missing API(s): "
                f"{', '.join(missing)}; the Tizen 5.0 floor engine lacks them"
            )


def validate_css_layout_gaps(files: dict[str, bytes]) -> None:
    for name in sorted(files):
        data = files[name]
        lower = name.lower()
        if lower.endswith(".css"):
            chunks: tuple[bytes, ...] = (data,)
        elif lower.endswith((".html", ".htm")):
            # Inline <style> blocks ship real CSS rules (e.g. the startup screen) and are bound by the same ADR-0006 rule.
            chunks = tuple(STYLE_BLOCK.findall(data))
        else:
            continue
        for chunk in chunks:
            match = CSS_GAP_PROPERTY.search(chunk)
            if match:
                raise WGTError(
                    f"{name!r} uses flex/grid gap property {match.group(1).decode()!r}; "
                    "ADR-0006 requires margin-based spacing"
                )


def validate_tv_icon(name: str, data: bytes) -> None:
    if name != "icon.png":
        raise WGTError("Samsung TV launcher icon must be named icon.png")
    if len(data) < 24 or data[:8] != b"\x89PNG\r\n\x1a\n" or data[12:16] != b"IHDR":
        raise WGTError("icon.png is not a valid PNG image")
    width, height = struct.unpack(">II", data[16:24])
    if (width, height) != (117, 117):
        raise WGTError(f"Samsung TV launcher icon must be 117x117 pixels, got {width}x{height}")


def validate_archive(file: Path, target: str) -> str:
    parse_version(target)
    files, signed = read_archive(file)
    if "config.xml" not in files:
        raise WGTError("root config.xml is missing")
    app_id, required, content, icon = validate_manifest(files["config.xml"], files, target)
    validate_html_references(files[content], files)
    validate_classic_tv_bootstrap(files[content], files)
    validate_avplay_lifecycle(files[content], files)
    validate_app_engine_floor(files)
    validate_css_layout_gaps(files)
    validate_tv_icon(icon, files[icon])
    signing = (
        "contains signatures; Apps2Samsung will re-sign this custom package"
        if signed
        else "unsigned; Apps2Samsung will sign it for the selected TV"
    )
    return (
        f"Compatible package structure: app={app_id}, profile=tv-samsung, "
        f"requires Tizen {required}, target=Tizen {target}, {signing}"
    )


def write_checksum(file: Path) -> str:
    digest = hashlib.sha256(file.read_bytes()).hexdigest()
    file.with_name(file.name + ".sha256").write_text(f"{digest}  {file.name}\n", encoding="utf-8")
    return digest


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    pack = commands.add_parser("pack")
    pack.add_argument("--source", type=Path, required=True)
    pack.add_argument("--config", type=Path, required=True)
    pack.add_argument("--icon", type=Path, required=True)
    pack.add_argument("--output", type=Path, required=True)
    pack.add_argument("--target-tizen", required=True)
    validate = commands.add_parser("validate")
    validate.add_argument("--file", type=Path, required=True)
    validate.add_argument("--target-tizen", required=True)
    args = parser.parse_args()

    try:
        if args.command == "pack":
            if args.output.suffix != ".wgt":
                raise WGTError("output filename must end in .wgt")
            write_archive(args.output, collect_entries(args.source, args.config, args.icon))
            try:
                report = validate_archive(args.output, args.target_tizen)
            except Exception:
                args.output.unlink(missing_ok=True)
                raise
            digest = write_checksum(args.output)
            print(f"Created {args.output}\nSHA-256: {digest}\n{report}")
        else:
            print(validate_archive(args.file, args.target_tizen))
    except WGTError as error:
        parser.error(str(error))


if __name__ == "__main__":
    main()
