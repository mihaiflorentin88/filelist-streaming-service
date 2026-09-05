# External portal integration lives server-side; the server self-updates in place

---
status: accepted
---

All integration with the external promotions/update service runs through one
Go adapter (`internal/adapters/portalclient`); the application-layer hub
(`internal/application/portal`) caches flags and links, proxies ad delivery
live, and exposes a neutral `/api/v1/portal/*` + `/api/v1/updates/*` surface
plus SSE kinds (`portal.state`, `updates.available`). Clients — webapp, GUI
webview, Tizen — never see the upstream. Any upstream fetch failure or
`enabled: false` marks the feature inactive immediately (no stale serving),
and UIs remove every trace of the surface. The external platform is never
named in the UI or in documentation; the code uses "portal" / "promotions".

The server binary self-updates in place: auto-install on start (checked
asynchronously after boot, fail-open), hourly check with notify-only
messaging, on-demand apply via `--update`, the GUI, or
`POST /api/v1/updates/apply`. Identity comes from the linker-injected
version plus `GOOS-GOARCH` mapped onto the feed's closed platform set.
Install verifies sha256 (cross-checked against the GitHub release's
`checksums.txt` when applicable), swaps atomically keeping `<name>.old`,
then restarts: graceful exit under `Restart=always` systemd, `syscall.Exec`
plain headless, whole-app re-exec in the GUI. Builds that cannot replace
their binary (Docker, root-owned installs — capability-probed) and
`linux/armv7` (absent from the feed's platform set) run notify-only.

Full design: `docs/superpowers/specs/2026-09-05-portal-integration-self-update-design.md`.

## Evidence

- The upstream API requires an API key for donor status and rejects JWTs;
  storing the key server-side is the only way every client, including the
  TV, can hide promotions for donors.
- `deploy/systemd/filelist-streaming.service` ran the binary from
  root-owned `/usr/local/bin` under `ProtectSystem=strict` with
  `Restart=on-failure`: the service user could neither write the binary nor
  bounce the service — in-place update was impossible without the layout
  change (binary under `/var/lib/filelist-streaming/bin`, `Restart=always`).
- Per-client upstream integration would triple the fetch/degrade logic
  (TSX, Tizen, GUI) and still need server push for live update notices.

## Considered options

- **Clients call the upstream directly** (CORS is `*`) — rejected: triplicated
  logic, no TV donor support, hardcoded URL spread across three codebases.
- **Hybrid** (clients gate themselves, server proxies content) — rejected:
  keeps the fragile part tripled while saving little.
- **Privilege-escalation update path** (sudo/pkexec to replace the root-owned
  binary) — rejected: punches a hole in the systemd sandbox
  (`NoNewPrivileges` would have to go).

## Consequences

- `deploy/pi-deploy.sh` installs to the new path with service-user ownership
  and migrates older installs on first run; one redeploy is required.
- Apply interrupts active playback; the update banner warns before running.
- Hub snapshots are only as fresh as the hourly tick; SSE pushes keep UIs
  live within that budget.
- The GUI spec's former "auto-update" non-goal (2026-09-04) is superseded.
