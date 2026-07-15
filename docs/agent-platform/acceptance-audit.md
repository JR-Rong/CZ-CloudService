# Hermes Agent Platform Acceptance Audit

Last updated: 2026-06-25

This audit maps the acceptance criteria from
`docs/agent-platform/hermes-agent-platform-design.md#19-acceptance-criteria` to
current evidence. It is intentionally stricter than the local test result:
criteria that require the real Windows AI host, real Docker/Hermes image, or
real Docker lifecycle stay blocked until those live checks pass.

## Status Legend

- `Pass`: Current local or live evidence directly proves the criterion.
- `Partial`: Evidence proves part of the criterion, but a live environment gate
  remains.
- `Blocked`: The required evidence depends on the currently unavailable real
  Docker/Hermes runtime.

## Criteria Matrix

| # | Criterion | Status | Current evidence |
| ---: | --- | --- | --- |
| 1 | Phase 0 confirms the Hermes image contract or a wrapper image satisfies it. | Partial | `agent-platform/hermes-wrapper/` now contains a Dockerfile and file-backed `hermes-profilectl` shim, and `apps/ui/test/script.test.js` exercises the wrapper contract locally. The image still has not been built and verified in the live Docker environment. |
| 2 | `hermes-profilectl health/create/list/start/stop/delete` contract tests pass. | Blocked | Static tests cover the smoke script command set, JSON output checks, idempotent create, delete removal, second-delete `missing: true`, and Windows Docker now runs a Linux engine. Live execution is still blocked because the Windows checkout does not yet contain the wrapper image context or real Hermes image, and the platform launcher remains `DOCKER_MANAGER_MODE=dry-run` without an `AI_API_KEY` line. |
| 3 | Admin can create an employee account. | Pass | `apps/ui/test/api.test.js` covers admin user creation through the API. |
| 4 | The employee has exactly one Docker container record. | Pass | Store/API tests cover deterministic single container creation and role-change preservation. |
| 5 | Admin can create/start/stop/restart/reset the employee container. | Pass | API lifecycle tests and dry-run Docker executor coverage prove the control-plane behavior. |
| 6 | Employee can start/stop/restart only their own container. | Pass | RBAC and policy tests cover employee-scoped container visibility and actions. |
| 7 | Employee can create profiles through the web UI in their own container. | Pass | In-app browser smoke on `127.0.0.1:3094` logged in as employee `alice-ui`, submitted `#profile-form`, rendered `Employee UI Profile`, and showed execution history for `docker exec -i hermes-alice-ui hermes-profilectl create --slug employee-ui-profile --name "Employee UI Profile" --config-json -`. |
| 8 | Employee cannot create profiles for another employee. | Pass | `employees can create profiles only in their own container` API test returns `403` for cross-container create. |
| 9 | Profile config is delivered through `docker exec -i ... --config-json -`. | Pass | Docker planner tests assert `docker exec -i` and stdin config with no `/tmp/profile.json`. |
| 10 | Reset can replay profiles idempotently against a retained Docker volume. | Pass | Reset replay tests cover `profile.list`, idempotent create replay, and restart of previously running profiles. |
| 11 | Profile creation uses the private LLM config automatically. | Pass | Docker/profile config tests assert private model injection and reject model override fields. |
| 12 | Employee cannot configure public model providers. | Pass | API tests reject `model`, `provider`, `baseUrl`, `apiKey`, and related fields. |
| 13 | Username slug collisions are rejected. | Pass | Store tests cover slug collision rejection. |
| 14 | Usernames that cannot produce a Docker-safe slug are rejected with a clear validation message. | Pass | Store tests cover empty/unsafe slug rejection. |
| 15 | JSON store writes are serialized and atomic. | Pass | Store tests cover concurrent writes and atomic temp-file write behavior. |
| 16 | Same-target lifecycle actions are rejected with `409 Conflict` while one is in progress. | Pass | Container/profile lifecycle tests cover same-target conflicts and `operationId` state. |
| 17 | Slow Docker/profile commands do not block unrelated state mutations while they run. | Pass | Slow lifecycle tests cover unrelated mutations while target lock is held. |
| 18 | Execution records are stored with redacted command/stdout/stderr. | Pass | Docker and API tests cover command, stdout, stderr, and secret reference redaction. |
| 19 | CSRF is required for authenticated mutating requests. | Pass | API tests cover missing/mismatched CSRF rejection. |
| 20 | CORS is not enabled for the MVP API. | Pass | API tests assert no permissive `Access-Control-Allow-Origin` headers. |
| 21 | Login lockout works. | Pass | API tests cover repeated failures returning `429`. |
| 22 | Login lockout counters are bounded, in-memory, and cleaned when expired. | Pass | Login throttler tests cover bounded map size and expiration cleanup. |
| 23 | Login lockout is keyed by username only because FRP TCP hides real client IP from the web app. | Pass | API tests cover username-keyed throttling and the design records the FRP TCP reason. |
| 24 | Bootstrap admin must change password after first login. | Pass | API and browser smoke verify forced password change. |
| 25 | Password change always requires the current password. | Pass | API tests cover current password requirement. |
| 26 | Password change invalidates other active sessions for that user. | Pass | API tests cover session revocation after self-change and admin reset. |
| 27 | Final admin cannot be deleted or downgraded. | Pass | Store/API tests cover final-admin safeguards. |
| 28 | Profile has an `enabled` flag separate from runtime `status`. | Pass | Store/API/UI tests cover `enabled` separately from lifecycle status. |
| 29 | Disabled profiles cannot be started. | Pass | API tests cover disabled start/restart rejection. |
| 30 | Skill/MCP resources can be private or company-shared. | Pass | Policy/API/UI tests cover private and company visibility. |
| 31 | Chat binding metadata can be saved for WeChat, Feishu, WeCom, and QQ. | Pass | Static UI and profile payload tests cover all four chat binding platforms. |
| 32 | `credentialRef` is validated as metadata and not resolved to raw secrets in the MVP. | Pass | SecretResolver and API tests cover reference validation and unresolved metadata behavior. |
| 33 | The app is reachable locally at `127.0.0.1:3080`. | Pass | After the Windows restart, SSH through `60.205.213.254:2222` reached the Windows host and `curl.exe -s -o NUL -w "%{http_code}" http://127.0.0.1:3080/` returned `200`. |
| 34 | The app is reachable through FRP at `60.205.213.254:2444`. | Pass | `RUN_PUBLIC_SMOKE=1 bash agent-platform/local-acceptance.sh` confirmed TCP connect to `60.205.213.254:2444`, `HTTP/1.1 200 OK`, and the `Hermes Agent 管理平台` login page. |
| 35 | Tests cover RBAC. | Pass | API and policy tests cover admin/employee RBAC. |
| 36 | Tests cover Docker command planning. | Pass | `apps/ui/test/docker.test.js` covers create/reset/delete/profile command planning. |
| 37 | Tests cover private model enforcement. | Pass | Docker/API tests cover private model config and model override rejection. |
| 38 | Tests cover profile ownership. | Pass | API tests cover own-container profile creation and cross-owner rejection. |
| 39 | Tests cover resource visibility. | Pass | API/policy/static tests cover private/company resource visibility and UI controls. |
| 40 | Tests cover CSRF. | Pass | API tests cover CSRF requirements. |
| 41 | Tests cover session expiry. | Pass | Store tests cover expired session rejection. |
| 42 | Tests cover slug collisions. | Pass | Store tests cover slug collision rejection. |
| 43 | Tests cover same-target lifecycle conflicts. | Pass | API lifecycle tests cover same-target conflict responses. |
| 44 | Tests cover `operationId` stale-result handling. | Pass | API tests cover stale container, profile update, and reset replay results. |
| 45 | Tests cover concurrent state writes. | Pass | Store tests cover serialized concurrent writes and startup recovery of stale in-progress records. |
| 46 | Tests cover reset replay. | Pass | API tests cover reset replay and readiness timeout skip. |
| 47 | Tests cover execution redaction. | Pass | Docker tests cover command/stdout/stderr redaction. |
| 48 | Tests cover CORS disabled behavior. | Pass | API tests cover disabled CORS behavior. |
| 49 | Tests cover username-only login lockout. | Pass | API tests cover username-keyed lockout. |
| 50 | Tests cover disabled profile start rejection. | Pass | API tests cover disabled profile lifecycle rejection. |
| 51 | Tests cover session revocation after password change. | Pass | API tests cover self-change and reset session revocation. |
| 52 | Tests cover container reconciliation. | Pass | API tests cover Docker inspect and health reconciliation. |
| 53 | Tests cover static page serving. | Pass | Static tests cover HTML, JS, CSS, and inline favicon serving; `agent-platform/local-acceptance.sh` now repeats the local Phase 5 test, syntax, script dry-run, and diff gates. |

## Remaining Blocking Evidence

Latest live checks as of `2026-06-25 16:02 CST` show the FRP gate is restored:

- `nc -vz -w 5 60.205.213.254 2222`: TCP connects and reaches Windows SSH
  authentication.
- `nc -vz -w 5 60.205.213.254 2444`: TCP connects.
- `curl --noproxy '*' -sS -o /tmp/cz-agent-platform-2444.html -w '%{http_code} %{size_download}\n' http://60.205.213.254:2444/`:
  returns `200 1118`, and the saved page is the management login page.
- ECS `systemctl is-active frps`: `active`.
- ECS `ss -tlnp | grep -E ':(7000|2222|2444|9000)'`: `*:7000`, `*:2222`,
  `*:2444`, and `*:9000` are listening under `frps`.
- Windows `tasklist /FI "IMAGENAME eq frpc.exe"`: two `frpc.exe` processes are
  running, both launched with `C:\Users\chuan\todesk-ssh\frpc.toml`; public
  access is healthy, but the duplicate should be normalized with the stable
  Scheduled Task setup.
- Windows `curl.exe -s -o NUL -w "%{http_code}" http://127.0.0.1:3080/`:
  returns `200`.
- Windows `curl.exe -s -o NUL -w "http_code=%{http_code} size=%{size_download}\n" http://127.0.0.1:3080/`:
  returns `http_code=200 size=1118`.
- Windows `curl.exe -s -o NUL -w "http_code=%{http_code} size=%{size_download}\n" http://60.205.213.254:2444/`:
  returns `http_code=200 size=1118`.
- Windows `schtasks /Query /TN "CZ Hermes Agent Platform"`: task mode is
  `Running`.
- Windows `schtasks /Query /TN "CZ CloudService frpc"`: task is not registered
  under the stable expected name. Legacy/one-shot frpc task names exist, but
  the live proxy is currently proven by process and TCP/HTTP checks.
- Windows `findstr` on `start-agent-platform.cmd`: `DOCKER_MANAGER_MODE=dry-run`.
- Windows `winget install Docker.DockerDesktop` installed Docker Desktop 4.78.0,
  and `winget install Microsoft.WSL` installed WSL 2.7.8 after Docker Desktop
  reported `WSL not installed`.
- Windows `CZ Docker Desktop` Scheduled Task is registered and `Running`, and
  `docker desktop status` reports `running`.
- Windows `docker version --format "client={{.Client.Version}} server={{.Server.Version}} os={{.Server.Os}}"`:
  returns `client=29.5.3 server=29.5.3 os=linux`.
- Windows `docker volume create cz-docker-smoke` plus
  `docker volume rm cz-docker-smoke` succeeded.
- `RUN_PUBLIC_SMOKE=1 bash agent-platform/local-acceptance.sh`: repeats local
  Phase 5 checks, then verifies public `2444` TCP and HTTP `200 OK`.
- `node --test --test-reporter=spec apps/ui/test/script.test.js`: 17 tests
  pass, including the smoke helper test that rejects missing-delete responses
  unless they contain `missing: true`.
- Windows PowerShell parser validation passed for
  `scripts\windows\setup-frpc.ps1`,
  `scripts\windows\setup-agent-platform.ps1`, and
  `scripts\windows\check-agent-platform.ps1` from the Windows host copy.

The remaining required action is Hermes runtime image validation and real-mode
platform enablement:

- `agent-platform/hermes-wrapper/` now provides a Phase 0 wrapper image asset,
  but the Windows checkout at `C:\Users\chuan\CZ-CloudService` did not yet
  contain `agent-platform\hermes-wrapper`, so the Windows Docker image build was
  not run in this check.
- `scripts/windows/check-agent-platform.ps1` now reports Docker CLI, Docker
  service candidates, and `start-agent-platform.cmd` `DOCKER_MANAGER_MODE` so
  the remaining runtime blocker is visible in one Windows diagnostic run.
- The current `CZ Hermes Agent Platform` scheduled task launcher still sets
  `DOCKER_MANAGER_MODE=dry-run`, and the launcher does not include an
  `AI_API_KEY` line, so real container lifecycle and Phase 0 Hermes image
  contract checks cannot pass yet.

After Docker is available, rerun the Phase 0 real Hermes image checks and switch
the scheduled task to `DOCKER_MANAGER_MODE=real`.
