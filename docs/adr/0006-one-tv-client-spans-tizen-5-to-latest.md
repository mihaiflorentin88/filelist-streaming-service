# One TV client spans Tizen 5.0 through the latest platform

---
status: accepted
---

The household runs Samsung sets from more than one generation (a 2019 premium Tizen 5.0 TV beside the 2023 S90C), and the client previously declared `required_version="7.0"`, locking the older set out. We ship a single WGT declaring `required_version="5.0"` — Samsung treats it as a pure floor, so the same unsigned package installs and runs on every platform from 5.0 up, and both household sets install from one distributor certificate. Behavior differences between engine generations are absorbed by runtime feature detection in one client-side capability module, not by version branching or per-era builds; where the older engine lacks a modern convenience, polish may degrade but behavior may not.

## Considered options

- **Keep a 7.0-only client** — rejected: it excludes the 2019 TV and every pre-2023 set.
- **Raise the floor to 6.0+ if 5.0 proved costly** — rejected: the costs turned out bounded; Tizen 5.0's Chromium 63 already runs the existing `es2017` bundle, and the real work is CSS authoring plus a few guarded APIs.
- **Branch on the reported platform version** — rejected: firmware variants and future platforms (8.0+) fall through version ranges; feature detection degrades gracefully instead.
- **Per-era builds (a 5.x artifact and a 7+ artifact)** — rejected: two packages double the packaging, signing, and verification surface for no capability gain.

## Consequences

- **Authoring rules and their enforcement**: flex/grid `gap` (Chromium 84+) is off-limits — spacing is margin-based, and the offline WGT validator rejects `gap`-family properties in shipped CSS and inline `<style>` blocks. The rules the build still cannot check: `AbortController` (Chromium 66+) must be guarded (LAN discovery depends on it), and missing niceties such as native image lazy-loading fall back to eager loading on old engines.
- **The support promise is tested-on-mine**: behavior counts as confirmed only on the household's Verified TVs; every other Tizen 5.0-or-newer set is best-effort, since the offline WGT validator proves packaging, not engine behavior.
- **Codec spread is handled by "pick another release"**: Samsung sets since 2018 (both generations here) decode no DTS-class audio, and AV1 needs a 2021+ set. Direct play stays the only route (ADR-0001), so an unsupported source is avoided by the viewer at selection time, not ranked away by the server.
- Validation and docs gain a 5.0 story: the manifest floor drops, the validator gate (`required ≤ target`) keeps passing against newer targets, and the physical-TV log records each TV generation separately.

Platform and engine-level facts behind this decision are collected in [the Tizen 5-to-latest compatibility research](../research/tizen-tv-5-to-latest-compatibility.md).
