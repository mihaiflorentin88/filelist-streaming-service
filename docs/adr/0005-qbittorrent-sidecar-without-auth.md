# qBittorrent ships as a no-auth sidecar published to the household LAN

---
status: accepted
---

Scope note (0007): this ADR governs deployments whose active download engine is
qBittorrent — the compose `qbittorrent` profile and external-qBittorrent setups.
The native engine default needs neither the sidecar nor its no-auth WebUI.

A from-scratch Docker start must require zero qBittorrent knowledge — no port to discover, no credentials to create. The compose stack therefore owns a qBittorrent sidecar whose WebUI authentication is removed and whose port is published to the household LAN, extending the existing trust model: the server itself has no login and gates only on trusted CIDRs, and the stack is never port-forwarded. Connecting to an existing external qBittorrent instance remains supported for the bare-metal Pi deployment.

## Considered options

- **Auto-generated credentials injected into both containers** — rejected: extra moving parts for a boundary (the trusted LAN) every other component already relies on.
- **No-auth WebUI bound to the internal Docker network only** — rejected: the operator loses direct visibility into qBittorrent, and LAN reachability is the point of a household appliance.

## Consequences

- Anyone on the household LAN has full qBittorrent WebUI access; the stack must never be exposed beyond the LAN (existing rule, now load-bearing for qBittorrent too).
- The sidecar also disables the WebUI host header validation. qBittorrent compares the Host header port against its in-container listening port, so a published host port different from the container port (e.g. `127.0.0.1:8081` -> `:8080`) is rejected with `401` before the auth bypass applies — in browsers and probes alike. On a credential-free WebUI there are no sessions or cookies for host header validation to protect, so the check only broke the published URL.
