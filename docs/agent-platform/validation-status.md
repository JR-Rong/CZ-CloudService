# Hermes Agent Platform Validation Status

Last updated: 2026-06-25

This file records the current validation state for the MVP described in
`docs/agent-platform/hermes-agent-platform-design.md`.

## Local Automated Validation

Run from `apps/ui`:

```bash
npm test
```

Latest local result:

```text
88 tests, 88 pass, 0 fail
```

Covered local gates include:

- Auth, forced password change, CSRF, strict same-origin host:port Origin
  checks, and disabled CORS.
- Username slug validation and collision handling.
- Username-keyed login lockout, including periodic cleanup without waiting for a
  new login attempt and a bounded in-memory username map.
- Admin and employee RBAC for users, containers, profiles, and resources.
- Employee profile creation succeeds only for the employee's own container and
  direct cross-container create attempts return `403`.
- User role values reject unsupported roles instead of coercing them, and failed
  role updates do not mutate existing users.
- Username and username slug updates are rejected explicitly because Docker
  container names are immutable in the MVP.
- Admin password reset rejects empty or too-short passwords instead of silently
  ignoring them, and failed resets do not revoke active sessions.
- Bootstrap admin creation enforces the same 12-character admin password
  minimum before hashing the initial password.
- Successful admin password reset revokes all active sessions for the reset
  user and returns them to `mustChangePassword: true`.
- Exactly one active container record for employee users, including role changes.
- Rejection of deleting users with running or in-progress containers.
- Admin container recreation after a successful delete.
- Duplicate container create requests are rejected after the Docker container
  already exists.
- Container reset is rejected before Docker when the container is only
  `defined`.
- Container start is rejected before Docker when the container is only
  `defined`.
- Docker and `hermes-profilectl` command planning.
- Private model env-file injection and command/stdout/stderr redaction.
- Reset removes stale env files after container removal before writing a fresh
  runtime env file.
- Successful real Docker container delete removes the runtime env file after
  Docker succeeds.
- JSON store serialization, atomic temp-file writes, session expiry, and startup
  recovery for stale in-progress records.
- Container/profile lifecycle locks and stale `operationId` result handling.
- Lifecycle in-progress records use UUID-style `operationId` values before slow
  Docker/profile commands run.
- Unsupported container lifecycle actions are rejected before state changes.
- Container/profile lifecycle `409` conflicts include the current status and a
  concise reason when the target state or same-target in-process lock blocks
  the requested action.
- Execution retention preserves at least the newest 200 records per owner while
  trimming global history growth.
- Reset replay with idempotent profile create and stale replay protection.
- Reset replay records the pre-replay `hermes-profilectl list --json` command in
  execution history before profile create/start replay.
- Hermes image contract smoke verifies duplicate `create` leaves exactly one
  profile, `delete` removes the smoke profile from `list --json`, and deleting
  the already-missing profile reports `missing: true`.
- Container readiness polling records `hermes-profilectl health --json` commands
  in execution history.
- Hermes health probes reject unsupported `status` values instead of treating
  them as available container health.
- Container reconciliation records `docker inspect` commands in execution
  history before applying observed Docker status.
- Failed profile create records can be retried with the `create` action, and the
  dashboard exposes a `Retry apply` control for errored profiles.
- Readiness timeout marks the container `error`, stores the latest health output,
  and skips reset profile replay.
- Disabled profiles reject both `start` and `restart` actions before any
  lifecycle command can make them running again.
- Running profile disable requests preserve the failed stop result instead of
  masking it as stopped/disabled.
- Deleted profiles reject direct lifecycle actions without being resurrected.
- Delete-failed profiles are retained for delete retry and reject ordinary
  lifecycle actions and reset replay paths that would resurrect them.
- Skill/MCP resources reject unsupported type and visibility values instead of
  coercing them, and failed updates do not mutate in-memory state.
- Skill/MCP resource creation rejects unknown owner ids, while admin-created
  resources can still be assigned to an existing employee owner.
- Malformed chat binding records return `400` instead of leaking an internal
  `500` error.
- Chat binding credential references must match `secret://<provider>/<name>`;
  empty references are rejected instead of being stored as unresolved metadata.
- Profile create/edit forms collect multiple chat binding records for WeChat,
  Feishu, WeCom, and QQ while preserving existing binding ids.
- Deleting a user removes their owned shared resources from remaining profile
  bindings so other profiles do not retain dangling `resourceIds`.
- Deleting a Skill/MCP resource through the API removes it from profile
  bindings so profiles do not retain dangling `resourceIds`.
- Changing a company resource back to private removes it from profiles owned by
  other employees.
- Employee UI hides edit/share/delete controls for company resources owned by
  another employee while preserving controls for the employee's own resources.
- Employee UI hides the admin-only system configuration summary, including
  Docker mode, private model endpoint, and public access target.
- Resource binding UI shows resource type, owner, visibility, and package
  reference in both the create-profile selector and inline edit-profile resource
  selector, and also shows the resource version in binding labels and the
  resource table.
- Skill/MCP resource create and edit forms expose type, visibility, description,
  and version metadata matching the resource model and API payload.
- Profile editing uses an inline dashboard form instead of browser-native
  `window.prompt()` dialogs, preserving compatibility with browser surfaces that
  do not expose native prompt dialogs.
- Admin user display-name/password edits and Skill/MCP resource edits also use
  inline dashboard forms instead of browser-native `window.prompt()` dialogs.
- Employee dashboard renders employee-scoped section labels for `My container`,
  `My container health`, `My profiles`, `Chat bindings`, and `Skill/MCP
  library`.
- Employee dashboard hides profile creation until the visible container is
  `running` with `health: "ready"` and shows the disabled-action reason.
- Profile rows render visible disabled-action reasons when lifecycle buttons are
  blocked by container health or profile state.
- Dashboard lifecycle and mutation failures render the API error in the
  dashboard error area instead of becoming unhandled browser rejections.
- Dashboard renders container reconciliation warnings when Docker status or
  Hermes health checks are unavailable, so stale stored container state is
  visibly marked.
- The `/api/system` deployment summary is admin-only and still redacts the LLM
  API key.
- Real Docker container create/reset plans require a resolved runtime LLM API key
  before writing env files or executing Docker.
- The Hermes image contract smoke script statically covers
  `health/create/list/start/stop/restart/delete` profilectl commands.
- The Hermes image contract smoke script validates `list`, idempotent `create`,
  and lifecycle command stdout is a JSON object shape, then checks aggregated
  command output for raw API key leaks.
- The Hermes image contract smoke script validates that a second delete of the
  smoke profile returns `missing: true`, so idempotent delete behavior is not
  only JSON-shaped.
- The Hermes image contract smoke script validates `health --json` reports
  `status: "ready"` plus the expected private model `baseUrl`, `model`, and
  `privateOnly: true` metadata.
- The Hermes image contract smoke script explicitly verifies
  `hermes-profilectl` is on the container PATH and `/var/run/docker.sock` is not
  exposed inside the container.
- The Hermes image contract smoke script injects private model settings through
  a temporary env file instead of `docker run -e OPENAI_API_KEY=...` command
  arguments.
- The smoke JSON validator accepts formatted multiline JSON output rather than
  requiring one-line JSON.
- Skill/MCP visibility and unresolved `credentialRef` metadata.
- Static web app asset serving, inline favicon, and admin dashboard control
  surface checks.
- The dashboard exposes container/profile lifecycle status summaries and a
  container health summary.
- The profile editor exposes chat binding and resource assignment update paths
  for employee-owned profiles.
- Windows app setup script statically carries the runtime LLM API key into the
  generated Scheduled Task launcher and fails real mode when the key is absent.
- Windows app setup script accepts an explicit `-NodeExe` path for hosts that
  run the management web app with portable Node.js instead of a global `PATH`
  install.
- Windows app setup script supports both `AtLogon` and elevated `AtStartup`
  Scheduled Task triggers for the management web app.
- Windows app and frpc setup scripts use the Windows-supported `Limited`
  `RunLevel` for current-user `AtLogon` Scheduled Tasks.
- Windows frpc setup script supports `-RestartExistingDetached` for updates run
  through the same FRP SSH tunnel that the old `frpc` process carries.
- Windows app setup script writes generated launcher environment variables with
  quoted `set "KEY=value"` lines for values such as the bootstrap password.
- Cloud `frps` setup dry-run defaults to allowing SSH `2222`, Hermes web
  console `2444`, and LLM `9000`, and still supports explicit
  `--allow-ports 2222,2444,9000`.
- Cloud `frps` diagnostic script coverage for service status,
  `7000/2222/2444/9000` listeners, `allowPorts`, and web plus LLM proxy log
  registration.
- Deployment verification uses `curl --noproxy '*'` for the public web check so
  local HTTP proxy settings do not mask the real FRP result.
- Deployment guide documentation covers the full Hermes contract smoke checks:
  `hermes-profilectl` on `PATH`, no Docker socket exposure, lifecycle
  `start/restart/stop/delete`, idempotent create/delete, and redacted command
  outputs.
- Windows diagnostic script coverage for local web app, `frpc` process,
  Scheduled Tasks, public TCP, and no-proxy public HTTP checks.

Additional local checks:

```bash
node --check src/server.js src/store.js src/docker.js src/secrets.js public/app.js
bash -n agent-platform/hermes-contract-smoke.sh scripts/cloud/setup-frps.sh scripts/cloud/check-frps-agent-platform.sh
git diff --check
```

Latest result: all passed.

## Rendered UI Validation

Temporary local dry-run server:

```bash
HOST=127.0.0.1 PORT=3090 DOCKER_MANAGER_MODE=dry-run \
AGENT_PLATFORM_DATA=/tmp/cz-agent-platform-ui-check/state.json \
AGENT_PLATFORM_RUNTIME_DIR=/tmp/cz-agent-platform-ui-check/runtime \
BOOTSTRAP_ADMIN_PASSWORD=<temporary-test-password> \
node src/server.js
```

Browser flow verified:

```text
/ -> admin login -> forced password change -> dashboard -> create employee
```

Observed evidence:

- Page title is `Hermes Agent 管理平台`.
- Dashboard renders employee accounts, containers, profiles, resource library,
  system configuration, and execution history sections.
- Creating employee `alice` renders container `hermes-alice`.
- In real Docker mode with a deliberately missing Docker binary, creating
  employee `alice` renders a `Container warnings` panel for `hermes-alice`
  with the Docker spawn failure reason instead of silently showing stale state.
- In dry-run mode, editing `Sales Assistant` renders an inline editor with a
  resource option such as `Shared helper | mcp | company | owner usr_admin |
  mcp/shared-helper`.
- In dry-run Browser validation, admin user reset opens an inline
  `data-user-editor` password form instead of a browser prompt.
- In dry-run Browser validation, creating Skill/MCP resource
  `contract-review` with description and version preserves those values in the
  inline `data-resource-editor`.
- Latest in-app browser smoke on `127.0.0.1:3092` verified
  `/ -> admin login -> forced password change -> dashboard`, with no console
  errors or warnings after login and on the dashboard.
- Employee UI smoke on `127.0.0.1:3094` verified admin-created employee
  `alice-ui`, container create in dry-run mode, employee login and forced
  password change, then employee-submitted `#profile-form` creating
  `Employee UI Profile` in `hermes-alice-ui`. The rendered execution history
  showed `docker exec -i hermes-alice-ui hermes-profilectl create --slug
  employee-ui-profile --name "Employee UI Profile" --config-json -`, and no
  console errors or warnings were recorded.
- A Playwright CLI viewport screenshot confirmed the login page renders at
  `1280x720`; after adding the inline favicon, the only remaining first-load
  console error is the expected unauthenticated `/api/me` session probe
  returning `401`.
- The current mobile viewport override in the in-app browser did not take
  effect, so no fresh mobile screenshot is claimed in this record.
- The rendered page did not expose the temporary passwords used for the smoke.

## Repeatable Local Acceptance

Run from the repository root:

```bash
bash agent-platform/local-acceptance.sh
```

This script runs the local Phase 5 checks that do not require production Docker:

- Bash syntax checks for agent-platform and cloud scripts.
- Cloud `frps` dry-run for `2222,2444,9000,9999`.
- Node test suite and JavaScript syntax checks.
- `git diff --check`.
- PowerShell parser validation when `pwsh` is available.
- Optional public FRP TCP/HTTP smoke when `RUN_PUBLIC_SMOKE=1`.

It intentionally reports the Docker real-mode smoke as an external gate:

```bash
AI_API_KEY=<runtime-secret> HERMES_IMAGE=hermes:latest \
  bash agent-platform/hermes-contract-smoke.sh
```

Latest local-plus-public result:

```text
RUN_PUBLIC_SMOKE=1 bash agent-platform/local-acceptance.sh
88 tests, 88 pass, 0 fail
public 2444 TCP connected
public HTTP returned 200 OK and the Hermes Agent 管理平台 login page
```

## External Validation Still Required

These gates require the real Windows AI host Docker/Hermes runtime and are not
proven by local dry-run tests:

- Phase 0 Hermes image contract:
  - `hermes-profilectl health --json`
  - `create --config-json -`
  - `list --json`
  - `start`
  - `stop`
  - `restart`
  - `delete`
  - idempotent create/delete behavior
  - deleting an already-missing profile returns `missing: true`
  - no raw API key in command output
- Real Docker mode with `DOCKER_MANAGER_MODE=real`.

Current local blockers:

- `agent-platform/hermes-wrapper/` now provides a Dockerfile plus file-backed
  `hermes-profilectl` shim for the Phase 0 wrapper path. The local Node test
  exercises its health/create/list/start/restart/stop/delete behavior without
  leaking the test API key, but this is not a substitute for a real Docker
  image smoke on the Windows host.
- `agent-platform/hermes-contract-smoke.sh` correctly rejects missing
  `AI_API_KEY`.
- With a placeholder key, the smoke reaches Docker and fails because the local
  Colima Docker socket is unavailable at
  `/Users/rongjianrui/.colima/default/docker.sock` with
  `connect: no such file or directory`.
- PowerShell is not installed in this local macOS environment, but Windows
  parser validation passed on the Windows host for:
  `C:\Users\chuan\CZ-CloudService\scripts\windows\setup-frpc.ps1`,
  `C:\Users\chuan\CZ-CloudService\scripts\windows\setup-agent-platform.ps1`,
  and
  `C:\Users\chuan\CZ-CloudService\scripts\windows\check-agent-platform.ps1`.
- After the Windows host recheck, SSH through `60.205.213.254:2222` reaches
  Windows authentication and the provided operator account can enter the host.
- Windows `Win32_OperatingSystem.LastBootUpTime` reports
  `2026-06-24T10:54:27.5387890+08:00`.
- Windows `curl.exe -s -o NUL -w "%{http_code}" http://127.0.0.1:3080/`
  returned `200`.
- Public
  `curl --noproxy '*' -i --max-time 10 http://60.205.213.254:2444/` returned
  `HTTP/1.1 200 OK` and the `Hermes Agent 管理平台` login page.
- As of `2026-06-25 15:25 CST`, ECS `ss -tlnp` shows `frps` listening on
  `*:7000`, `*:2222`, `*:2444`, and `*:9000`.
- As of `2026-06-25 16:02 CST`, public `2222` and `2444` TCP checks still
  connect, public `2444` returns `200 1118`, Windows local
  `127.0.0.1:3080` returns `200 1118`, and Windows public self-check for
  `60.205.213.254:2444` returns `200 1118`.
- As of `2026-06-25 17:10 CST`, Docker Desktop and WSL were installed on the
  Windows host with `winget install Docker.DockerDesktop` and
  `winget install Microsoft.WSL`.
- Windows `docker desktop status` reports `running`, and a `CZ Docker Desktop`
  current-user Scheduled Task is `Running` so Docker Desktop stays alive beyond
  the transient SSH command.
- Windows `docker version --format "client={{.Client.Version}} server={{.Server.Version}} os={{.Server.Os}}"`:
  returns `client=29.5.3 server=29.5.3 os=linux`.
- Windows `docker volume create cz-docker-smoke` followed by
  `docker volume rm cz-docker-smoke` succeeded, proving the Docker daemon
  accepts mutating commands.
- Windows `wsl -l -v` shows `docker-desktop` running with WSL version `2`.
- `scripts/windows/check-agent-platform.ps1` now includes read-only checks for
  Docker CLI, Docker service candidates, and the generated
  `start-agent-platform.cmd` `DOCKER_MANAGER_MODE` value.
- Windows `tasklist /FI "IMAGENAME eq frpc.exe"` shows two `frpc.exe`
  processes using `C:\Users\chuan\todesk-ssh\frpc.toml`. Public access is
  healthy, but this duplicate process state should be cleaned up during the
  next FRP service normalization.
- Windows `schtasks /Query /TN "CZ CloudService frpc"` currently fails with
  "The system cannot find the file specified."; other legacy/one-shot frpc
  tasks exist, but the stable task name expected by the diagnostic script is
  not registered.
- The Windows `CZ Hermes Agent Platform` scheduled task is running, but its
  launcher still sets `DOCKER_MANAGER_MODE=dry-run`.
- The Windows `CZ Hermes Agent Platform` launcher does not currently include an
  `AI_API_KEY` line and still points `LOCAL_LLM_API_KEY_ENV` at `AI_API_KEY`,
  so the platform was not switched to `DOCKER_MANAGER_MODE=real` during Docker
  installation.
- The Windows checkout at `C:\Users\chuan\CZ-CloudService` did not yet contain
  `agent-platform\hermes-wrapper`, so the Phase 0 wrapper image build was not
  run on the Windows host in this check.

## Completion Rule

The MVP should not be marked fully accepted until the external validation gates
above pass against the real deployment environment.
