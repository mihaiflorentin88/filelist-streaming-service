# qBittorrent ships as a no-auth sidecar published to the household LAN

---
status: accepted
---

A from-scratch Docker start must require zero qBittorrent knowledge — no port to discover, no credentials to create. The compose stack therefore owns a qBittorrent sidecar whose WebUI authentication is removed and whose port is published to the household LAN, extending the existing trust model: the server itself has no login and gates only on trusted CIDRs, and the stack is never port-forwarded. Connecting to an existing external qBittorrent instance remains supported for the bare-metal Pi deployment.

## Considered options

- **Auto-generated credentials injected into both containers** — rejected: extra moving parts for a boundary (the trusted LAN) every other component already relies on.
- **No-auth WebUI bound to the internal Docker network only** — rejected: the operator loses direct visibility into qBittorrent, and LAN reachability is the point of a household appliance.

## Consequences

- Anyone on the household LAN has full qBittorrent WebUI access; the stack must never be exposed beyond the LAN (existing rule, now load-bearing for qBittorrent too).
