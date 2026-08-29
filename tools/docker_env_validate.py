#!/usr/bin/env python3
"""Fail-fast validator for the Docker Compose environment file.

``compose.yml`` is the only consumer of ``.env.docker``; this script checks
exactly its key set: required host paths, port/IP/CIDR formats, playback and
storage limits, credentials, and the qBittorrent legal notice. Stale or
unknown keys produce warnings, never errors, and secret values are never
echoed. Exit status: 0 when no errors were found, 2 otherwise.

Full variable reference:
https://github.com/mihaiflorentin88/filelist-streaming-service/blob/master/docs/DOCKER_ENV.md
"""

import ipaddress
import re
import sys
from pathlib import Path

DOCS_URL = (
    "https://github.com/mihaiflorentin88/filelist-streaming-service"
    "/blob/master/docs/DOCKER_ENV.md"
)

USAGE = "usage: python3 tools/docker_env_validate.py [env_file]"

# compose.yml refuses to start without these (":?" substitutions).
REQUIRED_KEYS = ("APP_DATA_DIR", "QBITTORRENT_CONFIG_DIR", "DOWNLOADS_DIR")

# Every key compose.yml reads, including the required ones above.
CONSUMED_KEYS = frozenset(
    {
        "FILELIST_STREAMING_VERSION", "QBITTORRENT_IMAGE", "QBT_LEGAL_NOTICE",
        "SERVER_BIND_IP", "SERVER_HOST_PORT", "SERVER_INSTANCE_NAME",
        "TRUSTED_CIDRS",
        "QBITTORRENT_WEBUI_BIND_IP", "QBITTORRENT_WEBUI_HOST_PORT",
        "QBITTORRENT_WEBUI_CONTAINER_PORT",
        "QBITTORRENT_BIND_IP", "QBITTORRENT_HOST_PORT",
        "QBITTORRENT_CONTAINER_PORT",
        "APP_DATA_DIR", "QBITTORRENT_CONFIG_DIR", "DOWNLOADS_DIR",
        "PUID", "PGID", "PAGID", "UMASK", "TZ",
        "FILELIST_URL", "FILELIST_USERNAME", "FILELIST_PASSKEY",
        "TMDB_API_KEY", "SUBDL_URL", "SUBDL_API_KEY",
        "METADATA_LANGUAGE", "METADATA_FALLBACK_LANGUAGE",
        "INITIAL_BUFFER_BYTES", "READ_AHEAD_BYTES",
        "PIECE_WAIT_TIMEOUT_SECONDS", "ALLOCATION_GB", "RESERVE_GB",
        "WATCHED_THRESHOLD_PERCENT", "CATALOG_MAX_AGE_HOURS",
        "ARTWORK_CACHE_MAX_BYTES", "SUBTITLE_CACHE_MAX_BYTES",
        "MAX_CONCURRENT_JOBS", "TITLE_REFRESH_TIMEOUT_MINUTES",
        "PREFERRED_AUDIO_LANGUAGE", "PREFERRED_SUBTITLE_LANGUAGE",
        "FALLBACK_SUBTITLE_LANGUAGE",
    }
)

# Values of these keys must never appear in validator output.
SECRET_KEYS = frozenset(
    {"FILELIST_USERNAME", "FILELIST_PASSKEY", "TMDB_API_KEY", "SUBDL_API_KEY"}
)

# Notices for optional credentials left empty; the server starts regardless.
EMPTY_CREDENTIAL_NOTES = {
    "FILELIST_USERNAME": "FileList catalog browsing and downloads are limited",
    "FILELIST_PASSKEY": "FileList catalog browsing and downloads are limited",
    "TMDB_API_KEY": "artwork and metadata enrichment stay disabled",
    "SUBDL_API_KEY": "subtitle search stays disabled",
}

_PORTS = (
    "SERVER_HOST_PORT", "QBITTORRENT_WEBUI_HOST_PORT",
    "QBITTORRENT_WEBUI_CONTAINER_PORT", "QBITTORRENT_HOST_PORT",
    "QBITTORRENT_CONTAINER_PORT",
)
_BIND_IPS = ("SERVER_BIND_IP", "QBITTORRENT_WEBUI_BIND_IP", "QBITTORRENT_BIND_IP")
_POSITIVE_INTS = (
    "PUID", "PGID", "INITIAL_BUFFER_BYTES", "READ_AHEAD_BYTES",
    "ARTWORK_CACHE_MAX_BYTES", "SUBTITLE_CACHE_MAX_BYTES",
    "CATALOG_MAX_AGE_HOURS", "PIECE_WAIT_TIMEOUT_SECONDS",
    "TITLE_REFRESH_TIMEOUT_MINUTES", "MAX_CONCURRENT_JOBS",
)
_NON_EMPTY = (
    "FILELIST_STREAMING_VERSION", "QBITTORRENT_IMAGE", "TZ",
    "METADATA_LANGUAGE", "METADATA_FALLBACK_LANGUAGE",
    "PREFERRED_AUDIO_LANGUAGE", "PREFERRED_SUBTITLE_LANGUAGE",
    "FALLBACK_SUBTITLE_LANGUAGE",
)
_URLS = ("FILELIST_URL", "SUBDL_URL")

_DIGITS = re.compile(r"[0-9]+")
_OCTAL = re.compile(r"[0-7]{1,4}")
_POSITIVE_NUMBER = re.compile(r"[0-9]+(?:\.[0-9]+)?")
_KEY = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")


def _check_port(value):
    if not _DIGITS.fullmatch(value) or not 1 <= int(value) <= 65535:
        return "must be an integer between 1 and 65535"
    return None


def _check_positive_int(value):
    if not _DIGITS.fullmatch(value) or int(value) == 0:
        return "must be a positive integer"
    return None


def _check_bind_ip(value):
    try:
        ipaddress.ip_address(value)
    except ValueError:
        return "must be an IPv4 or IPv6 address"
    return None


def _check_pagid(value):
    if value == "":
        return None
    for group in value.split(","):
        if not _DIGITS.fullmatch(group) or int(group) == 0:
            return "must be empty or a comma-separated list of positive integers"
    return None


def _check_umask(value):
    if not _OCTAL.fullmatch(value):
        return "must be 1-4 octal digits"
    return None


def _check_non_empty(value):
    return None if value else "must not be empty"


def _check_trusted_cidrs(value):
    reason = (
        "must be a comma-separated list of CIDRs;"
        " a bare address is allowed as a single host"
    )
    if value == "":
        return reason
    for cidr in value.split(","):
        try:
            ipaddress.ip_network(cidr, strict=False)
        except ValueError:
            return reason
    return None


def _check_url(value):
    http = value.startswith("http://") and len(value) > len("http://")
    https = value.startswith("https://") and len(value) > len("https://")
    if not (http or https):
        return 'must be a URL starting with "http://" or "https://"'
    return None


def _check_gib(value):
    if not _POSITIVE_NUMBER.fullmatch(value) or float(value) <= 0:
        return "must be a positive number of GiB (fractions allowed)"
    return None


def _check_percent(value):
    if not _DIGITS.fullmatch(value) or int(value) > 100:
        return "must be an integer between 0 and 100"
    return None


FORMAT_CHECKS = {
    **{key: _check_port for key in _PORTS},
    **{key: _check_bind_ip for key in _BIND_IPS},
    **{key: _check_positive_int for key in _POSITIVE_INTS},
    **{key: _check_non_empty for key in _NON_EMPTY},
    **{key: _check_url for key in _URLS},
    "ALLOCATION_GB": _check_gib,
    "RESERVE_GB": _check_gib,
    "PAGID": _check_pagid,
    "UMASK": _check_umask,
    "TRUSTED_CIDRS": _check_trusted_cidrs,
    "WATCHED_THRESHOLD_PERCENT": _check_percent,
}


def _unquote(value):
    if len(value) >= 2 and value[0] == value[-1] and value[0] in "'\"":
        return value[1:-1]
    return value


def parse_env_lines(text):
    """Parse KEY=VALUE lines into (lineno, key, value) plus (lineno, reason) errors."""
    entries = []
    errors = []
    for lineno, raw in enumerate(text.splitlines(), start=1):
        line = raw.strip()
        if not line or line.startswith("#") or line.startswith(";"):
            continue
        if line.startswith("export "):
            line = line[len("export "):].lstrip()
        key, sep, value = line.partition("=")
        if not sep:
            errors.append((lineno, "expected KEY=VALUE"))
            continue
        key = key.strip()
        if not _KEY.fullmatch(key):
            errors.append((lineno, f'"{key}" is not a valid variable name'))
            continue
        entries.append((lineno, key, _unquote(value.strip())))
    return entries, errors


def _last_occurrences(entries):
    """Collapse duplicate keys to their last value (compose semantics), keeping file order."""
    last = {key: (lineno, key, value) for lineno, key, value in entries}
    return [last[key] for key in dict.fromkeys(key for _, key, _ in entries)]


def _value_error(key, reason, value):
    if value == "":
        return f"{key} {reason}; the value is empty"
    if key in SECRET_KEYS:
        return f"{key} {reason}"
    return f'{key} {reason} (got "{value}")'


def _required_errors(by_key, env_file):
    errors = []
    for key in REQUIRED_KEYS:
        value = by_key.get(key)
        if value is None:
            errors.append(
                f"{key} is required by compose.yml but is missing from {env_file}"
            )
        elif value == "":
            errors.append(f"{key} is required by compose.yml but the value is empty")
        elif value.startswith("CHANGE_ME") or value.startswith("/absolute/path"):
            errors.append(
                f'{key} still contains the example placeholder "{value}";'
                " set a real absolute host path"
            )
        elif not value.startswith("/"):
            errors.append(f'{key} must be an absolute host path starting with "/"')
    return errors


def collect_findings(text, env_file):
    """Validate env text; return ordered (level, message) pairs.

    Levels: "error" (exit 2), "warning" (stale/unknown keys), "info"
    (optional credentials left empty).
    """
    findings = []
    entries, parse_errors = parse_env_lines(text)
    for lineno, reason in parse_errors:
        findings.append(("error", f"line {lineno}: {reason}"))

    unique = _last_occurrences(entries)
    by_key = {key: value for _, key, value in unique}

    for _, key, value in unique:
        if key in REQUIRED_KEYS:
            continue
        check = FORMAT_CHECKS.get(key)
        if check is None:
            continue
        reason = check(value)
        if reason is not None:
            findings.append(("error", _value_error(key, reason, value)))

    findings.extend(("error", msg) for msg in _required_errors(by_key, env_file))

    notice = by_key.get("QBT_LEGAL_NOTICE")
    if notice is not None and notice != "confirm":
        findings.append(
            (
                "error",
                _value_error(
                    "QBT_LEGAL_NOTICE",
                    'must be "confirm" to accept the qBittorrent legal notice',
                    notice,
                ),
            )
        )

    for _, key, value in unique:
        if key not in CONSUMED_KEYS and not key.startswith("COMPOSE_"):
            findings.append(
                (
                    "warning",
                    f"{key} is ignored by compose;"
                    " see the migration section of the reference below",
                )
            )
        note = EMPTY_CREDENTIAL_NOTES.get(key)
        if note is not None and value == "":
            findings.append(
                ("info", f"{key} is (empty); {note}; the server still starts")
            )
    return findings


def main(argv=None):
    args = sys.argv[1:] if argv is None else list(argv)
    if len(args) > 1:
        print(USAGE, file=sys.stderr)
        return 2
    env_file = args[0] if args else ".env.docker"
    try:
        text = Path(env_file).read_text(encoding="utf-8")
    except FileNotFoundError:
        findings = [
            (
                "error",
                f"{env_file} is missing;"
                " run 'make docker-configure' or copy .env.docker.example",
            )
        ]
    except UnicodeDecodeError:
        findings = [("error", f"{env_file} is not valid UTF-8 text")]
    except OSError as exc:
        findings = [("error", f"{env_file} cannot be read: {exc}")]
    else:
        findings = collect_findings(text, env_file)

    errors = 0
    for level, message in findings:
        print(f"{level}: {message}")
        if level == "error":
            errors += 1
    if findings:
        print(f"{errors} error(s), {len(findings) - errors} warning(s)")
    print(f"Full variable reference: {DOCS_URL}")
    return 2 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
