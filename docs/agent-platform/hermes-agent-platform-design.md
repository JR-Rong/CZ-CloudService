# Hermes Agent Management Platform Design

Last updated: 2026-06-24

## 0. Phase 0 Blocking Contracts

The MVP cannot start from the web app alone. It depends on a precise contract
between the management platform and the standard Hermes Docker image. This
contract is a Phase 0 deliverable and must be verified before the management
platform is considered runnable.

Phase 0 has two acceptable outcomes:

1. Verify an existing Hermes image already satisfies the contract in this
   section.
2. Build or wrap the Hermes image so it satisfies the contract in this section.

If neither outcome is true, profile creation, profile lifecycle actions, and
private-model enforcement are not implemented.

### 0.1 Standard Hermes Image Contract

The standard image is the only image used for employee containers in the MVP.
The default image reference is configured by:

```text
HERMES_IMAGE=hermes:latest
```

The image must satisfy these requirements:

- Reads the local private model environment variables listed in `0.2`.
- Does not require employee-provided public model credentials.
- Provides `hermes-profilectl` on `PATH`.
- Stores profile data under `/data`, backed by the employee Docker volume.
- Supports one container containing multiple profiles.
- Does not expose Docker socket access or host shell access to employees.
- Provides a health command that confirms the profile controller is ready.

### 0.2 Private Model Environment Contract

The management platform is authoritative for model configuration. Employee UI
and employee API requests must not override these values.

Canonical environment variables:

| Variable | Required | Value | Purpose |
| --- | --- | --- | --- |
| `OPENAI_BASE_URL` | Yes | `http://192.168.100.12:8000/v1` | OpenAI-compatible client base URL. |
| `OPENAI_API_BASE` | Yes | Same as `OPENAI_BASE_URL` | Compatibility alias for older clients. |
| `OPENAI_MODEL` | Yes | `qwen3.6-35b-a3b` | Served model name. |
| `LOCAL_LLM_MODEL` | Yes | Same as `OPENAI_MODEL` | Compatibility alias for local tooling. |
| `OPENAI_API_KEY` | Yes | Runtime secret | Private LLM API key. |
| `HERMES_PRIVATE_MODEL_ONLY` | Yes | `1` | Tells Hermes to reject public provider fallback. |
| `HERMES_OWNER_ID` | Yes | User id | Platform owner id. |
| `HERMES_EMPLOYEE_USERNAME` | Yes | Username | Human/debug owner name. |

Priority rules inside the image:

1. `OPENAI_BASE_URL` is the authoritative base URL.
2. `OPENAI_API_BASE` is a compatibility alias and must not override
   `OPENAI_BASE_URL` when both are present.
3. `OPENAI_MODEL` is the authoritative model.
4. `LOCAL_LLM_MODEL` is a compatibility alias and must not override
   `OPENAI_MODEL` when both are present.
5. If `HERMES_PRIVATE_MODEL_ONLY=1`, Hermes must not use public provider
   defaults, public environment variables, or built-in public-model fallback.

If the current Hermes image uses different environment variable names, the MVP
must either add these aliases to the image or wrap its entrypoint. The web app
must not carry image-specific branching logic for multiple incompatible images.

### 0.3 `hermes-profilectl` Command Contract

The image must expose:

```text
hermes-profilectl
```

Required commands:

```bash
hermes-profilectl health --json
hermes-profilectl create --slug <slug> --name <display-name> --config-json -
hermes-profilectl start <slug>
hermes-profilectl stop <slug>
hermes-profilectl restart <slug>
hermes-profilectl delete <slug>
hermes-profilectl list --json
```

Important semantics:

- `--config-json -` means the command reads profile config from stdin.
- `create` is intentionally idempotent upsert:
  - If the profile does not exist, create it.
  - If the profile already exists, update its stored config.
  - It must not create duplicates.
  - It exits `0` when the desired profile state is applied.
- `delete` is idempotent:
  - Deleting a missing profile exits `0` and reports `missing: true`.
- `start`, `stop`, and `restart` operate on the slug.
- Every command must return non-zero on malformed input or runtime failure.
- Every command must write machine-readable JSON to stdout when `--json` is
  present or when a lifecycle command changes state.
- Commands must not print raw API keys or raw chat credentials.

Standard exit codes:

| Code | Meaning |
| ---: | --- |
| `0` | Success or idempotent no-op success. |
| `2` | Invalid arguments or invalid config payload. |
| `3` | Profile not found for a non-idempotent action such as `start`. |
| `4` | Profile already running/stopped where the command treats that as an error. |
| `10` | Hermes runtime error. |
| `20` | Private model configuration is missing or invalid. |

`list --json` response schema:

```json
{
  "version": 1,
  "profiles": [
    {
      "slug": "sales-assistant",
      "displayName": "Sales Assistant",
      "status": "running",
      "updatedAt": "2026-06-24T00:00:00.000Z"
    }
  ]
}
```

`health --json` response schema:

```json
{
  "status": "ready",
  "privateModel": {
    "baseUrl": "http://192.168.100.12:8000/v1",
    "model": "qwen3.6-35b-a3b",
    "privateOnly": true
  }
}
```

Valid `health.status` values:

```text
starting
ready
degraded
error
```

The management platform treats only `ready` as ready for profile replay.

### 0.4 Profile Config Payload Contract

Profile config payloads are versioned. Version `1` is the MVP format.

The platform sends the payload through stdin:

```bash
docker exec -i hermes-alice \
  hermes-profilectl create \
  --slug sales-assistant \
  --name "Sales Assistant" \
  --config-json -
```

The JSON body is written to stdin. The platform must not rely on
`/tmp/profile.json` inside the container because `docker exec` does not copy
files into the container.

Version `1` payload:

```json
{
  "version": 1,
  "slug": "sales-assistant",
  "displayName": "Sales Assistant",
  "description": "Helps Alice draft customer replies.",
  "model": {
    "provider": "openai-compatible",
    "baseUrl": "http://192.168.100.12:8000/v1",
    "model": "qwen3.6-35b-a3b",
    "privateOnly": true
  },
  "bindings": [],
  "resources": []
}
```

Compatibility rules:

- `version` is required.
- Unknown top-level fields must be ignored by the image.
- Unknown required future versions must fail with exit code `2`.
- Missing private model fields must fail with exit code `20`.

### 0.5 Contract Verification Test

Before integrating a real image with the web platform, run this sequence against
the image:

```bash
docker run -d \
  --name hermes-contract-test \
  --env-file C:/ProgramData/CZ-CloudService/agent-platform/runtime/hermes-contract-test.env \
  -v hermes-contract-test-data:/data \
  hermes:latest

docker exec hermes-contract-test hermes-profilectl health --json

printf '%s' '<profile-config-json>' | \
  docker exec -i hermes-contract-test \
  hermes-profilectl create --slug smoke --name Smoke --config-json -

docker exec hermes-contract-test hermes-profilectl list --json
docker exec hermes-contract-test hermes-profilectl start smoke
docker exec hermes-contract-test hermes-profilectl stop smoke
docker exec hermes-contract-test hermes-profilectl delete smoke
docker rm -f hermes-contract-test
```

Acceptance:

- Health returns `status: "ready"`.
- `list --json` includes the created profile after create.
- Start and stop return success.
- Delete removes the profile.
- Re-running create for the same slug updates without duplicates.
- No command output contains the raw LLM API key.

## 1. Purpose

This document defines the first implementation target for an internal Hermes
agent management platform.

The platform will run on the Windows AI host, expose a web console through FRP
on public port `2444`, and manage one isolated Docker environment per employee.
Each employee can create and manage Hermes profiles only through the web
console. Employees must not directly create profiles inside the container or
change the model provider. All Hermes profiles must use the locally deployed
private LLM service documented in this repository.

The design is intentionally operational. It should be detailed enough for a
developer or agent to implement the MVP without making product or architecture
decisions.

## 2. Current Environment Facts

The repository currently documents three relevant deployment surfaces:

- AI server LLM service:
  - Host: `192.168.100.12`
  - LLM port: `8000`
  - OpenAI-compatible base URL for clients: `http://192.168.100.12:8000/v1`
  - Served model name: `qwen3.6-35b-a3b`
  - Runtime service: `ai-llm.service`
  - API key exists on the AI server, but must not be committed to this repo.
- Existing FRP access path:
  - Cloud ECS public host: `60.205.213.254`
  - FRP server control port: `7000`
  - Existing SSH public proxy: `2222`
  - Existing Windows SSH target: `127.0.0.1:22222`
- Desired new web access path:
  - Public URL: `http://60.205.213.254:2444/`
  - FRP proxy: `remotePort = 2444`
  - Windows local target: `127.0.0.1:3080`

The platform must not store real FRP tokens, LLM API keys, chat platform
secrets, SSH keys, or generated runtime config files in Git.

## 3. Product Requirements

### 3.1 User Roles

The platform has two roles:

| Role | Responsibility |
| --- | --- |
| Admin | Creates employee accounts, manages all employee containers, manages all profiles, resets broken environments, reviews shared skill/MCP resources. |
| Employee | Manages only their own Docker environment and profiles through the web UI. |

### 3.2 Employee Docker Rule

Each employee owns exactly one Docker container.

The container is the employee's isolated Hermes environment. Inside that
container, the employee may have multiple Hermes profiles. The employee is not
allowed to create profiles directly through a shell, Docker command, or any
other bypass path. Profile creation must flow through the platform web UI.

### 3.3 Hermes Profile Rule

Hermes profiles are logical workspaces inside one employee container.

Examples:

- `sales-assistant`
- `weekly-report-agent`
- `customer-support-bot`
- `feishu-ops-helper`

Each profile may have its own:

- Display name.
- Description.
- Enabled/disabled flag.
- Chat tool bindings.
- Skill/MCP resource bindings.
- Runtime status.

Each profile must inherit the employee container's private LLM configuration.
Employees cannot choose public model providers or public API keys.

### 3.4 Private LLM Rule

All employee containers and profiles must use the local private LLM service.

Default values:

```text
OPENAI_BASE_URL=http://192.168.100.12:8000/v1
OPENAI_MODEL=qwen3.6-35b-a3b
HERMES_PRIVATE_MODEL_ONLY=1
```

The API key is supplied at runtime through an environment variable such as
`AI_API_KEY`. The exact key value must never be rendered in the web UI, logs,
tests, or documentation.

Employee-facing screens must not include editable fields for:

- Model provider.
- Base URL.
- Model name.
- API key.
- Public model fallback.

### 3.5 Chat Binding Rule

The first version must support configuration records for these chat tools:

- WeChat.
- Feishu.
- WeCom.
- QQ.

The MVP stores and passes binding configuration to Hermes profiles. It does not
need to implement full message ingress/egress for every chat platform inside the
management platform itself.

The standard expectation is:

- The management platform stores profile binding metadata.
- The management platform passes binding metadata into the employee container.
- The Hermes container image or its adapters perform the actual platform
  integration.

### 3.6 Skill and MCP Rule

The platform includes an internal skill/MCP resource library.

Employees can:

- Create skill records.
- Create MCP server records.
- Keep resources private.
- Share resources company-wide.
- Bind available resources to their own profiles.

Admins can:

- View all resources.
- Edit or delete inappropriate resources.
- Manage shared resources.
- Bind resources to any employee profile.

## 4. MVP Scope

### 4.1 In Scope

- Phase 0 Hermes image contract verification or wrapper work:
  - Private model environment variable support.
  - `hermes-profilectl` command support.
  - Health check support.
  - Idempotent profile create/delete behavior.
- Web console for admin and employee roles.
- Admin-created employee accounts.
- One Docker container record per employee.
- Docker lifecycle actions:
  - Create.
  - Start.
  - Stop.
  - Restart.
  - Reset.
  - Delete, admin only.
- Hermes profile lifecycle actions:
  - Create.
  - Edit metadata.
  - Start.
  - Stop.
  - Restart.
  - Delete.
- Fixed private model injection into each employee container.
- Chat binding metadata for WeChat, Feishu, WeCom, and QQ.
- Skill/MCP resource library with private and company visibility.
- JSON store correctness:
  - In-process write serialization.
  - Atomic temp-file then rename writes.
  - Real-time session expiry checks during authentication.
- MVP security baseline:
  - CSRF protection for mutating authenticated API requests.
  - Origin or host validation for mutating authenticated requests.
  - Login failure throttling and short lockout.
  - Bootstrap admin must change password after first login.
  - Admin and employee self-service password change.
- Minimal structured execution history for Docker and profile commands.
- FRP exposure on public port `2444`.
- Deployment docs for Windows host, cloud FRP allow list, and smoke checks.

### 4.2 Out of Scope for MVP

- Full chat platform OAuth flows.
- Direct chat webhook implementation inside the management platform.
- Billing, quotas, cost accounting, or per-profile token usage accounting.
- Advanced container network egress blocking.
- Multi-admin approval workflow.
- Full audit dashboard.
- External identity provider integration.
- HTTPS termination. Public port `2444` is HTTP for the MVP, protected by
  source IP restrictions where possible.
- Full encrypted chat secret storage and resolution. MVP keeps
  `credentialRef` as unresolved metadata.
- Full chat platform message ingress/egress inside the management platform.
- Real-time Docker event streaming.

### 4.3 Future Hardening

Future versions should add:

- HTTPS reverse proxy.
- Encrypted secret storage.
- Network-level deny rules for public model endpoints.
- Full per-profile audit dashboard.
- Stronger distributed rate limits backed by a database or cache.
- Backup and restore for profile data.
- Real chat webhook routing.
- Admin approval for company-wide shared resources.
- Container egress policy that denies known public model provider domains.

## 5. Architecture

### 5.1 High-Level Components

```text
Browser
  |
  | http://60.205.213.254:2444
  v
Cloud ECS frps
  |
  | remotePort 2444
  v
Windows frpc
  |
  | 127.0.0.1:3080
  v
Agent Management Web App
  |
  | Docker CLI
  v
Employee Docker Containers
  |
  | OpenAI-compatible HTTP
  v
Private LLM service at 192.168.100.12:8000
```

### 5.2 Runtime Processes

The Windows host runs:

- Docker Desktop or a Docker Engine-compatible runtime.
- The management web app on `127.0.0.1:3080`.
- `frpc.exe`, which registers public port `2444` with the cloud `frps`.
- Existing Windows SSH service and existing `2222` FRP tunnel.

The cloud ECS host runs:

- `frps` on control port `7000`.
- Public listener `2222` for SSH.
- Public listener `2444` for the management web console.

### 5.3 Repository Placement

Recommended repository layout:

```text
apps/ui/
  package.json
  src/
  public/
  test/

docs/agent-platform/
  hermes-agent-platform-design.md
  deployment-guide.md

scripts/windows/
  setup-frpc.ps1
  setup-agent-platform.ps1

scripts/cloud/
  setup-frps.sh
```

The management app belongs under `apps/ui` because `README.md` already reserves
that path for future UI work. The design and deployment documentation belong
under `docs/agent-platform` because they describe a new product surface rather
than only FRP, AI stack, or webdisk operations.

## 6. Data Model

The MVP may use a local JSON state file. The state file should be treated as a
runtime artifact, not a source-controlled file.

Recommended runtime path:

```text
apps/ui/data/state.json
```

The directory `apps/ui/data/` must be ignored by Git.

### 6.1 User

```json
{
  "id": "usr_abc123",
  "username": "alice",
  "usernameSlug": "alice",
  "displayName": "Alice Zhang",
  "role": "employee",
  "mustChangePassword": false,
  "passwordHash": {
    "algorithm": "scrypt",
    "salt": "<random-salt>",
    "hash": "<hash>"
  },
  "createdAt": "2026-06-24T00:00:00.000Z",
  "updatedAt": "2026-06-24T00:00:00.000Z"
}
```

Rules:

- `username` is unique.
- `usernameSlug` is unique and is the Docker-safe normalized username.
- `username` must contain at least one ASCII letter or digit so it can produce a
  usable Docker slug. Chinese names should be stored in `displayName`.
- `role` is either `admin` or `employee`.
- Passwords are never stored in plain text.
- Admin users can create employee users.
- Employee users cannot create users.
- The bootstrap admin starts with `mustChangePassword: true`.
- Resetting a user's password sets `mustChangePassword: true`.
- Deleting or downgrading the final admin is forbidden.
- Creating a user must reject slug collisions. For example, if two distinct
  usernames normalize to the same Docker slug, the second create request fails
  with a validation error.
- Creating a user whose username normalizes to an empty slug fails with a clear
  message such as `username must include at least one ASCII letter or digit`.

### 6.2 Employee Container

```json
{
  "id": "ctr_abc123",
  "ownerId": "usr_abc123",
  "name": "Alice Hermes Container",
  "containerName": "hermes-alice",
  "image": "hermes:latest",
  "status": "created",
  "health": "unknown",
  "llm": {
    "baseUrl": "http://192.168.100.12:8000/v1",
    "model": "qwen3.6-35b-a3b",
    "privateOnly": true
  },
  "lastAction": null,
  "createdAt": "2026-06-24T00:00:00.000Z",
  "updatedAt": "2026-06-24T00:00:00.000Z"
}
```

Rules:

- Each employee user has exactly one active container record.
- Admin users may create, reset, delete, and recreate employee containers.
- Employee users may start, stop, and restart only their own container.
- Employees cannot change `llm.baseUrl`, `llm.model`, or `llm.privateOnly`.
- Container name is deterministic: `hermes-{username}`.
- The container has a dedicated Docker volume: `hermes-{username}-data`.
- `status` uses the container state enum in `6.9`.
- `health` uses the health enum returned by `hermes-profilectl health --json`.

### 6.3 Hermes Profile

```json
{
  "id": "pro_abc123",
  "containerId": "ctr_abc123",
  "ownerId": "usr_abc123",
  "slug": "sales-assistant",
  "displayName": "Sales Assistant",
  "description": "Helps Alice draft customer replies.",
  "enabled": true,
  "status": "defined",
  "bindings": [
    {
      "id": "bind_abc123",
      "platform": "feishu",
      "displayName": "Sales Feishu Bot",
      "externalRef": "bot-sales-01",
      "credentialRef": "secret://feishu/sales-01",
      "enabled": true
    }
  ],
  "resourceIds": ["res_skill_abc123", "res_mcp_def456"],
  "createdAt": "2026-06-24T00:00:00.000Z",
  "updatedAt": "2026-06-24T00:00:00.000Z"
}
```

Rules:

- Profile `slug` is unique inside one employee container.
- Profile `enabled` is a management flag. A disabled profile remains stored but
  cannot be started until re-enabled.
- Employees can create profiles only under their own container.
- Employees can edit only their own profile metadata, bindings, and resource
  assignments.
- Employees cannot assign resources they are not allowed to see.
- Starting a profile requires the employee container to exist.
- If a container is reset, the platform should replay profile creation from its
  stored profile records.
- `status` uses the profile state enum in `6.9`.
- Chat bindings are profile child objects. They are not independent top-level
  records in the MVP.
- `enabled` and `status` are separate:
  - `enabled: false` means the platform must reject profile `start` with `409`.
  - `status: stopped` means the profile is enabled but not currently running.
  - Disabling a running profile should first stop it, then set `enabled: false`.

### 6.4 Chat Binding

```json
{
  "id": "bind_abc123",
  "platform": "wechat",
  "displayName": "Customer WeChat Bot",
  "externalRef": "wechat-bot-customer-01",
  "credentialRef": "secret://wechat/customer-01",
  "enabled": true
}
```

Rules:

- `platform` is one of `wechat`, `feishu`, `wecom`, or `qq`.
- `credentialRef` is a reference name, not a raw secret.
- Raw tokens are not stored in the MVP JSON file unless a later encrypted secret
  store is implemented.
- Disabled bindings are retained but not passed as active bindings to Hermes.
- In the MVP, `credentialRef` is unresolved placeholder metadata. The platform
  validates its syntax and passes the reference string to Hermes, but does not
  resolve it into a secret value.

### 6.5 Skill/MCP Resource

```json
{
  "id": "res_abc123",
  "ownerId": "usr_abc123",
  "type": "skill",
  "name": "contract-review",
  "description": "Internal contract review helper skill.",
  "visibility": "company",
  "packageRef": "skills/contract-review",
  "version": "0.1.0",
  "createdAt": "2026-06-24T00:00:00.000Z",
  "updatedAt": "2026-06-24T00:00:00.000Z"
}
```

Rules:

- `type` is either `skill` or `mcp`.
- `visibility` is either `private` or `company`.
- Private resources are visible only to their owner and admins.
- Company resources are visible to all employees.
- Only the owner or an admin can edit a resource.
- Employees can bind company resources to their own profiles but cannot edit
  the resource record unless they own it.

### 6.6 Session

```json
{
  "token": "<random-session-token>",
  "userId": "usr_abc123",
  "csrfToken": "<random-csrf-token>",
  "createdAt": "2026-06-24T00:00:00.000Z",
  "expiresAt": "2026-06-24T12:00:00.000Z"
}
```

Rules:

- Session tokens are stored in HttpOnly cookies.
- Expired sessions are removed during normal state writes.
- Authentication must check `expiresAt` on every request before accepting a
  session. It must not rely only on cleanup.
- CSRF tokens are stored server-side with the session and returned to the web UI
  through authenticated JSON responses.
- Cookie should use `SameSite=Lax`.
- In the MVP, `Secure` cookie flag is not enabled because public access is HTTP.
  A future HTTPS deployment should enable it.

### 6.7 Secret Resolver

The MVP defines the interface but does not resolve real chat credentials.

Interface shape:

```text
resolveCredential(credentialRef, actor, purpose) -> SecretResolution
```

MVP response:

```json
{
  "resolved": false,
  "credentialRef": "secret://feishu/sales-01",
  "reason": "secret-resolution-not-implemented"
}
```

Rules:

- `credentialRef` must match `secret://<provider>/<name>`.
- Raw secret values are never stored in `state.json`.
- Raw secret values are never passed to profile config in the MVP.
- Future secret storage must implement this interface rather than changing
  profile or binding schemas.

### 6.8 Execution Record

Every Docker or `hermes-profilectl` command creates an execution record.

```json
{
  "id": "exec_abc123",
  "operationId": "op_550e8400-e29b-41d4-a716-446655440000",
  "actorId": "usr_admin",
  "targetType": "profile",
  "targetId": "pro_abc123",
  "operation": "profile.create",
  "mode": "real",
  "redactedCommand": "docker exec -i hermes-alice hermes-profilectl create --slug sales-assistant --name \"Sales Assistant\" --config-json -",
  "exitCode": 0,
  "stdout": "{\"status\":\"defined\"}",
  "stderr": "",
  "startedAt": "2026-06-24T00:00:00.000Z",
  "finishedAt": "2026-06-24T00:00:01.000Z"
}
```

Rules:

- Store redacted command text only.
- Redact API keys from stdout and stderr before storing.
- Keep enough records for troubleshooting the latest failures. The MVP should
  retain at least the newest 200 execution records per owner and may also keep
  a global cap such as the newest 2,000 records to bound file growth.
- Execution records are visible to admins. Employees can see records only for
  their own containers and profiles.

### 6.9 State Enums and Transitions

Container status values:

| Status | Meaning |
| --- | --- |
| `defined` | Record exists, Docker container has not been created. |
| `creating` | Docker create is in progress. |
| `created` | Docker container exists but is not confirmed running. |
| `starting` | Docker start or restart is in progress. |
| `running` | Container is running and health is ready. |
| `stopping` | Docker stop is in progress. |
| `stopped` | Container exists but is stopped. |
| `resetting` | Reset is in progress. |
| `deleting` | Delete is in progress. |
| `deleted` | Container was removed. |
| `error` | Last command failed. |

Container health values:

```text
unknown
starting
ready
degraded
error
```

Profile status values:

| Status | Meaning |
| --- | --- |
| `defined` | Record exists, not yet applied inside container. |
| `applying` | Create/upsert command is in progress. |
| `stopped` | Applied inside container and not running. |
| `starting` | Start command is in progress. |
| `running` | Profile is running. |
| `stopping` | Stop command is in progress. |
| `deleting` | Delete command is in progress. |
| `deleted` | Profile was deleted. |
| `error` | Last command failed. |
| `delete_failed` | Delete command failed; record is retained for retry. |

Required transition rules:

- A lifecycle action first moves the record into an in-progress state.
- When a lifecycle action moves a target into an in-progress state, it writes a
  one-time `operationId` on that target record.
- A target with an in-progress lifecycle state rejects a second lifecycle
  action with `409 Conflict`.
- Success moves the record to the target steady state.
- Failure moves the record to `error`, except delete failure moves profile to
  `delete_failed`.
- Profile `start`, `stop`, and `restart` are allowed only when the parent
  container is `running` and health is `ready`.
- Container `reset` may run from `created`, `running`, `stopped`, or `error`.
- Container `delete` is admin-only and requires confirmation.
- In-progress container states are `creating`, `starting`, `stopping`,
  `resetting`, and `deleting`.
- In-progress profile states are `applying`, `starting`, `stopping`, and
  `deleting`.

### 6.10 Lifecycle Operation Locks

The JSON write queue protects file integrity. It does not, by itself, protect
one Docker target from two simultaneous lifecycle commands. The MVP also needs
logical operation locks.

Rules:

- Maintain an in-process lock keyed by target:
  - `container:<containerId>`
  - `profile:<profileId>`
- A profile lifecycle action also checks the parent container lock. If the
  container is being reset, deleted, created, started, or stopped, profile
  actions return `409 Conflict`.
- Before starting a lifecycle command, validate that the target is not already
  in an in-progress state.
- When the target enters the in-progress state, write a new UUID-style
  `operationId` on the record.
- The final lifecycle write must verify that the target still has the same
  `operationId`. If it does not match, the command result is stale.
- If the target is in progress, return `409 Conflict` with the current status
  and a user-facing reason.
- Locks are released in `finally` blocks after the final state write attempt.
- On process restart, there are no in-memory locks. Startup recovery must mark
  stale in-progress records as `error` before accepting lifecycle commands.

### 6.11 JSON Store Consistency

The JSON store is acceptable for the MVP only with these correctness rules:

- All state mutations run through a single in-process async queue.
- A mutation reads the latest in-memory state, applies changes, writes a temp
  file, then atomically renames it over `state.json`.
- The temp file lives in the same directory as `state.json`.
- A failed write leaves the previous `state.json` intact.
- Slow Docker/profile commands must not hold stale state across the full command
  without reloading or rechecking the target before writing the final result.
- The implementation must prevent two concurrent writes from interleaving.
- If the process crashes during a Docker command, the next startup may find an
  in-progress state. Startup recovery should mark stale in-progress records as
  `error` with a recovery note.

Slow lifecycle operations use a three-stage pattern:

1. Enqueue a short state write:
   - Acquire the target operation lock.
   - Re-read the latest target state.
   - Validate permissions and current status.
   - Mark the target in-progress.
   - Persist state atomically.
   - Release the JSON write queue, but keep the target operation lock.
2. Execute Docker or `hermes-profilectl` outside the JSON write queue.
   - This may take up to the readiness timeout.
   - Other users can still log in and mutate unrelated targets.
   - Other actions for the same target return `409 Conflict`.
3. Enqueue a final state write:
   - Re-read the latest target record.
   - If the target was deleted or no longer matches the expected `operationId`,
     store an execution record and do not resurrect the deleted or changed
     record.
   - Write success or failure status.
   - Clear the `operationId` when the result is applied to the target.
   - Persist state atomically.
   - Release the target operation lock.

## 7. Access Control

### 7.1 Capability Matrix

| Capability | Admin | Employee |
| --- | --- | --- |
| Create employee account | Yes | No |
| Edit employee account | Yes | Own password only |
| Delete employee account | Yes | No |
| Change own password | Yes | Yes |
| Reset another user's password | Yes | No |
| Create employee container | Yes | No |
| Start own container | Yes | Yes |
| Stop own container | Yes | Yes |
| Restart own container | Yes | Yes |
| Reset employee container | Yes | No by default |
| Delete employee container | Yes | No |
| Create own profile | Yes | Yes |
| Edit own profile | Yes | Yes |
| Start own profile | Yes | Yes |
| Stop own profile | Yes | Yes |
| Delete own profile | Yes | Yes |
| Manage another employee profile | Yes | No |
| Create private skill/MCP resource | Yes | Yes |
| Share own skill/MCP company-wide | Yes | Yes |
| Edit another employee resource | Yes | No |

### 7.2 Important Enforcement Rules

The UI must hide unavailable controls, but API authorization is mandatory.

Required server-side checks:

- An employee can only access a container where `container.ownerId === actor.id`.
- An employee can only access a profile where `profile.ownerId === actor.id`.
- An employee cannot send model configuration fields in profile or container
  updates.
- An employee cannot create a second container.
- An employee cannot bind an invisible private resource owned by another user.
- Admin users cannot delete their own active account through the normal UI.
- The platform must reject deleting the final admin.
- The platform must reject downgrading the final admin to employee.
- Users with `mustChangePassword: true` can only call password-change,
  logout, and `GET /api/me` until the password is changed.
- Mutating authenticated requests must pass CSRF validation before reaching
  business logic.

## 8. Docker Design

### 8.1 Container Naming

Container name:

```text
hermes-{username}
```

Examples:

```text
hermes-alice
hermes-bob
hermes-zhangsan
```

Usernames should be normalized to lowercase ASCII-safe slugs for Docker names.
If the organization needs Chinese display names, keep them in `displayName`,
not in the Docker container name.

Slug normalization rules:

- Convert to lowercase.
- Replace every non-ASCII alphanumeric run with `-`.
- Trim leading and trailing `-`.
- Reject empty slugs.
- Enforce uniqueness of `usernameSlug` at user creation time.

The slug is stored on the user record. Container naming must use the stored slug,
not re-normalize display names later.

### 8.2 Container Create Command

Canonical Docker command shape:

```bash
docker run -d \
  --name hermes-alice \
  --restart unless-stopped \
  --label cz.agent.owner=usr_abc123 \
  --label cz.agent.username=alice \
  --env-file C:/ProgramData/CZ-CloudService/agent-platform/runtime/hermes-alice.env \
  -v hermes-alice-data:/data \
  hermes:latest
```

Implementation notes:

- The env file is generated at runtime with restrictive host permissions:
  - Linux/macOS: mode `0600`.
  - Windows: best-effort ACL limited to the service account.
- The env file path is absolute. Do not rely on the Scheduled Task working
  directory.
- The env file contains the private model variables from `0.2`.
- The command log must show only `--env-file <redacted-env-file>`.
- The employee cannot edit the image or environment variables unless an admin
  exposes that capability later.
- If the Hermes image expects different variable names, add aliases rather than
  removing the OpenAI-compatible names.
- `--env-file` reduces process-list and log leakage but does not hide
  environment variables from a trusted host administrator or `docker inspect`.
  The MVP assumes the Windows host administrator is trusted.
- Container create, reset, and delete own the env-file lifecycle:
  - Create writes or rewrites the env file before `docker run`.
  - Reset removes the old env file after `docker rm -f`, writes a fresh env
    file, then runs the container.
  - Delete removes the env file after container removal succeeds.
  - If delete fails, keep the env file so retry can be diagnosed and completed.
- The MVP does not configure Docker `HEALTHCHECK`. The management app's
  readiness polling through `hermes-profilectl health --json` is the single
  authoritative readiness check.

### 8.3 Container Actions

| Action | Command shape | Actor |
| --- | --- | --- |
| Create | `docker run ...` | Admin |
| Start | `docker start hermes-alice` | Admin or owner |
| Stop | `docker stop hermes-alice` | Admin or owner |
| Restart | `docker restart hermes-alice` | Admin or owner |
| Reset | `docker rm -f hermes-alice` then `docker run ...` then replay profiles | Admin |
| Delete | `docker rm -f hermes-alice` | Admin |

Reset should not delete the named Docker volume unless the admin explicitly
chooses a destructive reset mode in a future version.

Reset replay rules:

- The default reset keeps the Docker volume.
- Because the volume is retained, profile replay depends on idempotent
  `hermes-profilectl create` semantics.
- After recreating the container, the platform waits for container health to be
  `ready`.
- Then it runs `list --json`.
- For every stored profile:
  - If the slug exists, run idempotent `create` to update config.
  - If the slug is missing, run idempotent `create` to create it.
  - If the stored profile status before reset was `running`, start it after
    create succeeds.
- Partial replay failures mark the failed profiles as `error`, keep the
  container `running` if health is ready, and create execution records for each
  failed command.

Container readiness rules:

- `create`, `start`, `restart`, and `reset` must wait for readiness before
  profile commands.
- Readiness means `docker exec hermes-{username} hermes-profilectl health
  --json` returns `status: "ready"`.
- Timeout default: 120 seconds.
- Poll interval default: 2 seconds.
- Timeout moves container status to `error` and records the latest health
  response.

### 8.4 Dry-Run and Real Modes

The management app supports two Docker modes:

```text
DOCKER_MANAGER_MODE=dry-run
DOCKER_MANAGER_MODE=real
```

Rules:

- `dry-run` is default for local development and tests.
- `real` is required for production operation.
- Dry-run returns planned commands without executing Docker.
- Both modes must redact secrets.

## 9. Hermes Profile Control

This section restates the Phase 0 profile-control contract from the management
platform's point of view. The implementation must not invent a second control
path.

### 9.1 Command Invocation Rules

All profile operations use `docker exec`.

Command examples:

```bash
printf '%s' "$PROFILE_CONFIG_JSON" | \
  docker exec -i hermes-alice \
  hermes-profilectl create \
  --slug sales-assistant \
  --name "Sales Assistant" \
  --config-json -

docker exec hermes-alice hermes-profilectl start sales-assistant
docker exec hermes-alice hermes-profilectl stop sales-assistant
docker exec hermes-alice hermes-profilectl restart sales-assistant
docker exec hermes-alice hermes-profilectl delete sales-assistant
docker exec hermes-alice hermes-profilectl list --json
docker exec hermes-alice hermes-profilectl health --json
```

Rules:

- Profile config is sent through stdin.
- The platform does not create `/tmp/profile.json` inside the container.
- The platform does not use `docker cp` for the MVP.
- If a future implementation switches to `docker cp`, it must create a random
  path, delete the file after use, and avoid raw secrets in the file.
- The platform records every invocation as an execution record.

### 9.2 Profile Create Flow

1. Employee submits profile form in the web UI.
2. API validates:
   - Actor owns the container.
   - Container is `running` and health is `ready`.
   - Slug is valid and unique in platform state for that container.
   - Resource IDs are visible to actor.
   - Bindings use supported platforms.
   - Request does not include model provider fields.
3. API creates or updates the profile record with status `applying`.
4. API builds versioned profile config from platform state.
5. API pipes config JSON into `docker exec -i ... hermes-profilectl create`.
6. On command success:
   - Mark profile `stopped` unless command output explicitly reports running.
   - Store execution record.
7. On command failure:
   - Mark profile `error`.
   - Store redacted execution record.
   - Keep profile record for retry or delete.

### 9.3 Profile Update Flow

Profile update uses the same idempotent `create` command.

1. Validate actor owns the profile or is admin.
2. Validate resource visibility and binding shape.
3. Update stored profile record to `applying`.
4. Rebuild the full versioned config.
5. Pipe config into `hermes-profilectl create`.
6. Restore the previous runtime status if possible:
   - If profile was `running`, run `start` after config apply succeeds.
   - If profile was stopped, leave it stopped.

### 9.4 Profile Delete Flow

1. Mark profile `deleting`.
2. Run `docker exec hermes-{username} hermes-profilectl delete <slug>`.
3. On success:
   - Remove the profile record from active profile list, or mark it `deleted`
     if soft delete is selected by the implementation.
4. On failure:
   - Keep the profile record.
   - Mark status `delete_failed`.
   - Store execution record.

MVP recommendation: use soft delete for the first implementation so failed
delete recovery and audit are easier.

### 9.5 Reset Replay Flow

Reset replay handles retained volumes and possible pre-existing profiles.

```text
admin confirms reset
  -> mark container resetting
  -> docker rm -f hermes-alice
  -> docker run ... --env-file ...
  -> wait for health ready
  -> hermes-profilectl list --json
  -> for each stored active profile:
       pipe config to idempotent create
       if previous status was running, start profile
  -> mark container running when health ready
  -> mark failed profiles error
```

Rules:

- `create` must be idempotent because retained Docker volume may already
  contain profile data.
- Replay must not assume the retained volume is empty.
- Replay must continue after a single profile fails, then report partial
  failures.
- The reset response should include:
  - Container execution records.
  - Per-profile replay results.
  - Final container status.
  - Count of failed profiles.

### 9.6 Preventing Direct Profile Creation

The MVP cannot fully prevent a Windows host administrator from entering Docker.
The actual guarantee is platform policy plus container image design:

- Employees do not receive host shell access.
- Employees do not receive Docker socket access.
- Employees manage profiles only through the web app.
- The container should not expose a profile creation API directly to employees.
- Any future SSH or terminal feature must not mount Docker socket into employee
  contexts.
- Any future "open terminal" feature must be admin-only by default and must not
  be available to employees.

## 10. API Design

All API responses are JSON.

### 10.0 Cross-Cutting API Rules

Authentication:

- All API routes except `POST /api/login` require a valid session unless noted.
- Session validity checks `expiresAt` on every request.
- If `mustChangePassword` is true, only these routes are allowed:
  - `GET /api/me`
  - `POST /api/me/password`
  - `POST /api/logout`

CSRF:

- Every mutating authenticated request must include:

```text
X-CSRF-Token: <session-csrf-token>
```

- Mutating methods are `POST`, `PUT`, `PATCH`, and `DELETE`.
- The token is returned by `POST /api/login` and `GET /api/me`.
- The server must compare the submitted token with the token stored on the
  session.
- Missing or mismatched token returns `403`.
- The server should also reject mutating authenticated requests with an
  unexpected `Origin` host when the header is present.

CORS:

- The MVP does not enable cross-origin API access.
- The server should not emit `Access-Control-Allow-Origin`.
- The web app and API are same-origin at `http://60.205.213.254:2444/`.
- This is required because CSRF tokens are returned by `GET /api/me`; allowing
  credentialed cross-origin reads would let another origin steal the token.

Redaction:

- API responses may include redacted commands and execution records.
- API responses must not include raw LLM API keys or raw chat credentials.

Conflict responses:

- Lifecycle requests for a target that is already in progress return
  `409 Conflict`.
- Profile lifecycle requests return `409 Conflict` if the parent container is
  not `running` with `health: "ready"`.
- Conflict responses include the current target status and a concise reason.

### 10.1 Authentication

#### `POST /api/login`

Request:

```json
{
  "username": "alice",
  "password": "password-from-form"
}
```

Response:

```json
{
  "user": {
    "id": "usr_abc123",
    "username": "alice",
    "displayName": "Alice Zhang",
    "role": "employee",
    "mustChangePassword": false
  },
  "csrfToken": "<session-csrf-token>",
  "expiresAt": "2026-06-24T12:00:00.000Z"
}
```

Sets cookie:

```text
cz_agent_session=<token>; HttpOnly; SameSite=Lax; Path=/; Max-Age=<seconds>
```

#### `POST /api/logout`

Deletes the active session.

#### `GET /api/me`

Returns the current user.

Response includes the current session CSRF token:

```json
{
  "user": {
    "id": "usr_abc123",
    "username": "alice",
    "displayName": "Alice Zhang",
    "role": "employee",
    "mustChangePassword": false
  },
  "csrfToken": "<session-csrf-token>"
}
```

#### `POST /api/me/password`

Changes the current user's password.

Request:

```json
{
  "currentPassword": "old-password",
  "newPassword": "new-password"
}
```

Rules:

- Requires a valid CSRF token.
- Always requires the current password, including forced first-login password
  changes.
- New password must be at least 12 characters for admin users and at least 10
  characters for employee users.
- On success, sets `mustChangePassword` to false.
- On success, revokes the user's other active sessions and keeps only the
  current session.

#### Login Throttling

The server tracks failed login attempts by username.

FRP TCP note:

- In the MVP, the web app is reached through an FRP TCP proxy from cloud
  `remotePort = 2444` to Windows `127.0.0.1:3080`.
- The Node HTTP server sees the local `frpc` connection, not the real public
  client IP.
- Therefore app-layer lockout must not depend on source IP.
- Cloud security group source-IP restriction still works at the ECS edge.
- Browser `Origin` validation still works because it is based on HTTP headers,
  not socket source IP.
- The MVP does not use FRP PROXY protocol. Adding it would require app-side
  PROXY protocol parsing and local direct-access compatibility handling.

MVP rule:

- After 5 failed attempts for the same username in 15 minutes, lock that
  username for 15 minutes.
- During lockout, return `429`.
- Do not reveal whether the username exists.
- Successful login clears the failure counter for that username.

### 10.2 Users

#### `GET /api/users`

Admin only. Lists users without password hashes.

#### `POST /api/users`

Admin only.

Request:

```json
{
  "username": "alice",
  "displayName": "Alice Zhang",
  "password": "initial-password",
  "role": "employee"
}
```

Behavior:

- Creates the user.
- Creates the user's single container record.
- Computes and stores unique `usernameSlug`.
- Rejects usernames that contain no ASCII letter or digit with `400` and a
  clear validation message. Put Chinese names in `displayName`.
- Rejects username slug collisions with `409`.
- Sets `mustChangePassword: true`.
- Does not run Docker immediately. Admins create the real container through
  `POST /api/containers/:id/actions` with `action: "create"`.

#### `PUT /api/users/:id`

Admin only.

Allowed fields:

- `displayName`
- `role`
- `password`

Rules:

- Changing `password` sets `mustChangePassword: true`.
- Changing `password` revokes all active sessions for that user.
- Role changes must not remove the final admin.
- Username and username slug are immutable in the MVP because changing them
  would require Docker container rename/migration.

#### `DELETE /api/users/:id`

Admin only. Should require there is no running container, or should stop/remove
the container as part of a confirmed destructive flow.

Rules:

- Cannot delete the final admin.
- Cannot delete a user with a running container unless the request explicitly
  includes a confirmed destructive container cleanup mode.

### 10.3 Containers

#### `GET /api/containers`

Admin sees all containers. Employee sees only their own.

Before returning records, the API performs lightweight reconciliation for the
visible containers:

- Run `docker inspect` or equivalent Docker status check for each visible
  container.
- If Docker reports the container running, run one
  `hermes-profilectl health --json` probe.
- Update stored `status` and `health` when they drift from Docker reality.
- If Docker is unavailable, return the last stored state plus a warning field
  rather than blocking the dashboard indefinitely.

Reason: containers use `--restart unless-stopped`, so after a host reboot Docker
may restart a previously running container before the management app refreshes
its JSON state.

#### `POST /api/containers/:id/actions`

Request:

```json
{
  "action": "start"
}
```

Supported actions:

```text
create
start
stop
restart
reset
delete
```

Rules:

- Employees can use `start`, `stop`, and `restart` on their own container.
- Admins can use all actions.
- `reset` and `delete` require confirmation in the UI.
- `create`, `reset`, and `delete` are admin-only.
- `start`, `restart`, and `reset` wait for `health: ready` before returning
  success.
- Responses include execution records or execution record ids.
- A second lifecycle action for the same container while it is in progress
  returns `409`.

### 10.4 Profiles

#### `GET /api/containers/:id/profiles`

Admin can list profiles in any container. Employee can list only their own.

#### `POST /api/containers/:id/profiles`

Request:

```json
{
  "slug": "sales-assistant",
  "displayName": "Sales Assistant",
  "description": "Helps with sales replies.",
  "bindings": [],
  "resourceIds": []
}
```

Behavior:

- Validates ownership and visibility.
- Stores the profile record.
- Runs Hermes profile create command through stdin config.
- Returns profile and command result.

#### `PUT /api/profiles/:id`

Updates profile metadata, bindings, and resources. It must not accept model
provider fields from employees.

Forbidden request fields for employees and admins:

```text
model
provider
baseUrl
apiKey
openaiBaseUrl
openaiModel
```

These fields are platform-controlled. Requests containing them must return
`400` rather than silently ignoring them, so accidental public-provider UI bugs
are caught early.

#### `DELETE /api/profiles/:id`

Deletes the profile record and runs `hermes-profilectl delete`.

#### `POST /api/profiles/:id/actions`

Request:

```json
{
  "action": "start"
}
```

Supported actions:

```text
start
stop
restart
```

Rules:

- Parent container must be `running`.
- Parent container health must be `ready`.
- A second lifecycle action for the same profile while it is in progress
  returns `409`.
- If the parent container is being reset or deleted, return `409`.

### 10.5 Resources

#### `GET /api/resources`

Admin sees all resources. Employee sees:

- Their own resources.
- Company-visible resources.

#### `POST /api/resources`

Creates a skill or MCP record.

Request:

```json
{
  "type": "skill",
  "name": "contract-review",
  "description": "Internal contract review helper.",
  "visibility": "company",
  "packageRef": "skills/contract-review",
  "version": "0.1.0"
}
```

#### `PUT /api/resources/:id`

Owner or admin only.

#### `DELETE /api/resources/:id`

Owner or admin only.

Deleting a resource should remove it from profile bindings.

### 10.6 Credential Reference Validation

The MVP accepts credential references only as metadata.

Valid format:

```text
secret://<provider>/<name>
```

Examples:

```text
secret://feishu/sales-01
secret://wechat/customer-service
secret://wecom/ops-bot
secret://qq/internal-helper
```

Rules:

- The API validates format and supported provider names.
- The API does not resolve credential references into raw credentials.
- The API passes only the reference string to profile config.
- Future secret resolution must happen through the `SecretResolver` interface
  in `6.7`.

## 11. Web UI Design

The UI is a work console, not a marketing page.

### 11.1 Login Screen

Fields:

- Username.
- Password.

Actions:

- Login.

Display:

- Product title: `Hermes Agent 管理平台`.
- No public registration link.

If login succeeds with `mustChangePassword: true`, the app immediately shows a
password-change screen and hides the rest of the console until the password is
changed.

### 11.2 Admin Dashboard

Admin dashboard sections:

- Employee accounts.
- Employee containers.
- Hermes profiles.
- Skill/MCP resources.
- System configuration summary.

Admin actions:

- Create employee.
- Reset employee password.
- Create/start/stop/restart/reset/delete employee container.
- Create/edit/delete any profile.
- Start/stop/restart any profile.
- Create/edit/delete any skill/MCP resource.

The admin dashboard should show:

- Employee count.
- Container count by status.
- Container health summary.
- Profile count by status.
- Docker manager mode: dry-run or real.
- Current private model endpoint, with API key hidden.
- Public access target: `60.205.213.254:2444`.

### 11.3 Employee Dashboard

Employee dashboard sections:

- My container.
- My container health.
- My profiles.
- Chat bindings.
- Skill/MCP library.

Employee actions:

- Start/stop/restart own container.
- Create profile in own container.
- Edit own profile metadata.
- Add/remove chat bindings on own profile.
- Bind visible skill/MCP resources to own profile.
- Start/stop/restart/delete own profile.

Employee UI must not expose:

- Docker command text with secrets.
- Model provider selection.
- Public API key fields.
- Other employees' containers or profiles.

Employee UI should show why a profile action is disabled. For example, if the
container health is not `ready`, the profile start button should be disabled
with a message that the container is still starting or unhealthy.

### 11.4 Confirmation Dialogs

These actions require confirmation:

- Delete user.
- Reset container.
- Delete container.
- Delete profile.
- Delete resource.

Confirmation text should include the affected user/container/profile name.

## 12. Deployment Design

### 12.1 Windows Local Web App

Recommended local app settings:

```powershell
$env:HOST = "127.0.0.1"
$env:PORT = "3080"
$env:DOCKER_MANAGER_MODE = "real"
$env:HERMES_IMAGE = "hermes:latest"
$env:LOCAL_LLM_BASE_URL = "http://192.168.100.12:8000/v1"
$env:LOCAL_LLM_MODEL = "qwen3.6-35b-a3b"
$env:LOCAL_LLM_API_KEY_ENV = "AI_API_KEY"
$env:AI_API_KEY = "<runtime-secret>"
$env:BOOTSTRAP_ADMIN_USERNAME = "admin"
$env:BOOTSTRAP_ADMIN_PASSWORD = "<initial-admin-password>"
npm start
```

The setup script should create a Scheduled Task for the web app so it starts
when the Windows host starts or when the operator user logs in.

### 12.2 FRP Server

Cloud `frps` must allow SSH, web console, and LLM ports:

```bash
FRPS_AUTH_TOKEN="<runtime-token>" \
  bash scripts/cloud/setup-frps.sh --allow-ports 2222,2444,9000 --apply
```

Cloud security group inbound rules:

| Port | Source | Purpose |
| --- | --- | --- |
| `7000/tcp` | Existing FRP control policy | FRP control channel |
| `2222/tcp` | Operator IPs only | SSH through FRP |
| `2444/tcp` | Company/operator IPs only | Hermes management web console |

Avoid opening `2444/tcp` to `0.0.0.0/0` unless there is no alternative.
For `7000/tcp`, keep the current working FRP control-channel exposure unless a
stable Windows egress IP is available; many home or office networks have dynamic
public IPs, so an overly narrow rule can break the existing tunnel.

### 12.3 FRP Windows Client

The Windows `frpc.toml` should contain two proxy blocks:

```toml
[[proxies]]
name = "windows-ssh-2222"
type = "tcp"
localIP = "127.0.0.1"
localPort = 22222
remotePort = 2222

[[proxies]]
name = "hermes-agent-web-2444"
type = "tcp"
localIP = "127.0.0.1"
localPort = 3080
remotePort = 2444
```

The existing `setup-frpc.ps1` should be extended instead of running two
independent `frpc` processes. One config with two proxy blocks is easier to
restart, inspect, and troubleshoot.

### 12.4 Verification Commands

On Windows:

```powershell
Invoke-WebRequest http://127.0.0.1:3080/ -UseBasicParsing
Get-Process frpc -ErrorAction SilentlyContinue
docker ps
```

On cloud ECS:

```bash
systemctl is-active frps
ss -tlnp | grep -E '(:7000|:2222|:2444)([[:space:]]|$)'
tail -n 80 /var/log/frps.log
```

From an operator machine:

```bash
curl -i http://60.205.213.254:2444/
```

Expected result:

- HTTP response is `200`.
- Login page contains `Hermes Agent 管理平台`.

## 13. Security Design

### 13.1 Secrets

Do not commit:

- FRP auth token.
- LLM API key.
- Chat platform tokens.
- SSH keys.
- Generated `frpc.toml`.
- Generated `frps.toml`.
- Runtime state database.
- Runtime env files such as
  `C:/ProgramData/CZ-CloudService/agent-platform/runtime/hermes-*.env`.

### 13.2 Secret Display

The web UI may show:

```text
OPENAI_API_KEY=<redacted>
```

It must not show the actual key.

Docker caveat:

- Passing `OPENAI_API_KEY` through environment variables means a trusted host
  administrator can still inspect it through Docker tooling.
- The MVP uses `--env-file` to avoid exposing the key in command text, process
  lists, and app logs.
- Stronger protection requires a future secret store or Docker secret mechanism.

### 13.3 Employee Isolation

Isolation boundaries:

- One container per employee.
- One Docker volume per employee.
- No shared writable profile directory between employees.
- No Docker socket exposed inside employee containers.
- Employees only access their own profile APIs.

### 13.4 Shared Resource Supply-Chain Risk

Company-visible skill/MCP resources create an internal supply-chain risk. A
compromised employee account could publish a malicious resource as
company-visible and another employee could bind it to a profile.

MVP policy:

- The product allows company sharing without admin approval for speed.
- The UI must clearly show resource owner, type, package reference, and
  visibility before binding.
- Admins can remove or edit any shared resource.
- Execution of arbitrary skill/MCP packages must be treated as code execution
  inside the employee container.
- Admin approval for company-wide sharing remains a future hardening item.

### 13.5 Public Exposure Risk

The web app will be reachable through public port `2444`. Because the MVP uses
HTTP and controls Docker, these protections are part of the MVP:

- Restricting cloud security group source IPs.
- Using strong admin password.
- Forcing bootstrap admin password change after first login.
- Supporting self-service password change.
- Enforcing CSRF token validation on mutating authenticated requests.
- Validating request `Origin` host when present.
- Applying login failure throttling and temporary lockout.
- Keeping sessions reasonably short.
- Avoiding secret display.

Future HTTPS support should be prioritized before wider company exposure.

### 13.6 CSRF Policy

The app uses cookie sessions, so CSRF protection is mandatory.

MVP policy:

- `POST /api/login` is exempt.
- `GET` requests do not mutate state.
- Every authenticated mutating request requires `X-CSRF-Token`.
- The token must match the current session token.
- The front-end stores the token in memory from `POST /api/login` or
  `GET /api/me`.
- If a browser refresh loses the in-memory token, the app calls `GET /api/me`
  to get a fresh token.
- Unexpected cross-origin mutating requests return `403`.
- The MVP does not enable CORS. It does not return
  `Access-Control-Allow-Origin` for API responses.
- API and web UI must stay same-origin. If a future deployment needs a separate
  frontend origin, CORS must be designed together with CSRF and credential
  policy rather than enabled broadly.

### 13.7 Password Policy

MVP password policy:

- Admin password minimum length: 12 characters.
- Employee password minimum length: 10 characters.
- Bootstrap admin starts with `mustChangePassword: true`.
- Admin password reset sets `mustChangePassword: true`.
- Users with `mustChangePassword: true` are blocked from all actions except
  password change, logout, and current-user lookup.

### 13.8 Login Lockout

MVP lockout policy:

- Track failures by username only.
- Do not use socket source IP for lockout in the MVP because FRP TCP makes all
  public requests appear to come from the local `frpc` connection.
- Lock after 5 failures in 15 minutes.
- Lock duration is 15 minutes.
- Return generic `Invalid username or password` for ordinary failures.
- Return `429` during lockout.
- Store lockout counters in memory, not in the main JSON store.
- It is acceptable for a process restart to clear lockout counters in the MVP.
  Avoiding write amplification during public login attacks is more important
  than preserving lockout state across restart.
- Clean expired failure and lockout records at least once per minute and on each
  login attempt.
- Bound the in-memory map, for example by dropping oldest expired entries and
  capping active usernames.

Execution/audit note:

- The app may record `remoteAddress` for local diagnostics, but under FRP TCP it
  will usually be `127.0.0.1` and must not be treated as the real public client
  IP.
- If future work needs real client IP inside the app, evaluate FRP
  `proxyProtocol = "v2"` and add explicit PROXY protocol parsing before relying
  on it.

## 14. Error Handling

### 14.1 Docker Failures

If Docker command fails:

- Store command result with redacted command, exit code, stdout, and stderr.
- Mark container/profile status as `error`.
- Show admin-friendly failure details.
- Do not retry destructive commands automatically.
- Preserve the last known good state where possible. For example, a failed
  `stop` should not mark the container `stopped`.
- Include execution record id in the API response.

### 14.2 Hermes Profile Command Failures

If `hermes-profilectl create` fails after the profile record is saved:

- Mark profile status as `error`.
- Keep the record so the user can inspect and retry.
- Provide a retry action.
- Store the stdin payload hash, not the raw payload, in the execution record.

If profile deletion fails:

- Keep the record.
- Mark status as `delete_failed`.
- Allow admin retry.

### 14.3 Container Readiness Failures

If container readiness times out:

- Mark container `error`.
- Store latest health output.
- Do not replay profiles.
- Return a response that says readiness failed before profile replay.
- Admin can retry readiness check or reset.

### 14.4 FRP Failures

If public web access fails:

Check in order:

1. Windows app is listening on `127.0.0.1:3080`.
2. `frpc` process is running.
3. Windows `frpc.log` shows login and proxy success.
4. Cloud `frps` listens on `2444`.
5. Cloud security group allows `2444`.
6. Local operator network can reach the public IP.

## 15. Testing Requirements

### 15.1 Unit Tests

Required tests:

- Password hash verifies correct password only.
- Admin can create employee account.
- Employee creation creates exactly one container record.
- Duplicate employee container creation is rejected.
- Employee sees only their own container.
- Employee cannot manage another employee container.
- Employee can create profile in own container.
- Employee cannot create profile in another container.
- Employee cannot update model config fields.
- Employee can bind company resource to own profile.
- Employee cannot edit another employee private resource.
- Docker create command injects private model settings.
- Docker command redaction hides API key.
- Profile create command uses `docker exec hermes-{username}`.
- Profile create command sends config through stdin, not `/tmp/profile.json`.
- JSON store serializes concurrent writes and preserves all records.
- JSON store writes are atomic temp-file then rename.
- Slow Docker/profile commands release the JSON write queue while retaining the
  target operation lock.
- Concurrent lifecycle actions for the same container/profile return `409`.
- Concurrent lifecycle actions for different employees do not block each other
  behind a long reset.
- Username slug collision is rejected.
- Username with no ASCII letters or digits returns a clear validation error.
- Session expiry is enforced during authentication.
- Login lockout triggers after configured failures.
- Login lockout uses bounded in-memory counters and cleans expired entries.
- Login lockout is keyed by username only under FRP TCP.
- CSRF token is required for mutating authenticated requests.
- API responses do not emit permissive CORS headers.
- Final admin cannot be deleted or downgraded.
- Reset replay uses idempotent profile create and handles existing profiles.
- Execution records redact secrets from command, stdout, and stderr.
- SecretResolver MVP returns unresolved metadata and never raw secrets.
- Env-file paths are absolute and env files are removed on successful container
  delete.
- Container readiness is checked through the app's `docker exec
  hermes-profilectl health --json` polling path.

### 15.2 API Tests

Required API scenarios:

- Login success and failure.
- `/api/me` requires authentication.
- `/api/me` returns CSRF token.
- Password change clears `mustChangePassword`.
- Password change revokes the user's other active sessions.
- Admin password reset revokes all sessions for the reset user.
- Forced password-change users cannot perform Docker/profile actions.
- Password change always requires `currentPassword`.
- Admin-only user CRUD rejects employee.
- Container action permissions.
- Container create/reset waits for readiness before replay.
- `GET /api/containers` reconciles Docker status and one health probe for
  visible containers.
- Container concurrent lifecycle action returns `409`.
- Profile CRUD permissions.
- Disabled profile cannot be started.
- Profile create rejects model provider fields.
- Profile start/stop/restart returns `409` when parent container is not
  `running` and `ready`.
- Same-profile concurrent lifecycle action returns `409`.
- Skill/MCP visibility rules.
- Static page and assets are served.

### 15.3 Script Tests

Required checks:

```bash
bash -n scripts/cloud/setup-frps.sh
bash scripts/cloud/setup-frps.sh --allow-ports 2222,2444,9000
```

The dry-run output must contain:

```text
{ start = 2444, end = 2444 }
{ start = 9000, end = 9000 }
```

PowerShell validation should be run on Windows if available:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -Command {
  $null = [System.Management.Automation.PSParser]::Tokenize(
    (Get-Content .\scripts\windows\setup-frpc.ps1 -Raw),
    [ref]$null
  )
}
```

### 15.4 Manual Smoke Tests

Manual smoke after deployment:

1. Open `http://127.0.0.1:3080/` on Windows.
2. Open `http://60.205.213.254:2444/` from an allowed external IP.
3. Login as admin.
4. Create employee.
5. Create employee container.
6. Login as employee.
7. Create profile.
8. Bind a sample skill.
9. Start profile.
10. Stop profile.
11. Confirm employee cannot see another employee profile.

## 16. Implementation Phases

### Phase 0: Hermes Image Contract Gate

- Verify or build the standard Hermes image contract.
- Confirm required private model env variables are read by the image.
- Confirm `hermes-profilectl` exists on `PATH`.
- Confirm `health --json` returns `ready`.
- Confirm `create --config-json -` accepts stdin.
- Confirm `create` and `delete` are idempotent.
- Confirm `list --json` returns the required schema.
- Confirm command outputs do not leak API keys.

### Phase 1: Design and Test Skeleton

- Create design docs.
- Add tests for RBAC, Docker command plans, profile ownership, CSRF, JSON
  store concurrency, target lifecycle locks, slug collisions, and static UI.
- Confirm tests fail for missing behavior before implementation.

### Phase 2: Backend MVP

- Implement auth/session.
- Implement CSRF, login lockout, and password change.
- Implement JSON store.
- Implement store write queue and atomic writes.
- Implement per-container and per-profile lifecycle operation locks.
- Implement the three-stage lifecycle command pattern so slow Docker commands
  do not hold the JSON write queue.
- Implement users, containers, profiles, resources.
- Implement Docker command planner and dry-run executor.
- Implement health wait and reset replay.
- Implement execution records.
- Add real Docker executor behind `DOCKER_MANAGER_MODE=real`.

### Phase 3: Web UI MVP

- Implement login screen.
- Implement admin dashboard.
- Implement employee dashboard.
- Implement profile forms.
- Implement resource library forms.
- Implement confirmation dialogs.

### Phase 4: Windows and FRP Deployment

- Add Windows setup script for management web app scheduled task.
- Extend Windows FRP setup script with web proxy support.
- Update cloud FRP docs for `2444`.
- Update ports and autostart inventory.

### Phase 5: Validation

- Run automated tests.
- Run script dry-runs.
- Validate local Windows web access.
- Validate public `2444` access.
- Record any deployment gaps.

## 17. Review Lanes

### Reuse

- Reuse existing FRP setup script instead of creating a separate web-only FRP
  script.
- Reuse existing AI stack documentation values for LLM endpoint and model name.
- Keep app under existing reserved `apps/ui` path.

### Quality

- Keep private model configuration centralized.
- Avoid exposing model fields to employee profile forms.
- Keep Docker command construction in one module.
- Keep policy checks in one module and test them directly.
- Keep generated runtime data out of Git.

### Efficiency

- Use one `frpc` process with multiple proxy blocks.
- Use deterministic container names for simple Docker operations.
- Use dry-run mode for most tests.
- Avoid polling Docker in hot UI paths for MVP; refresh on user action.
- Keep readiness authority in one place: app-managed
  `hermes-profilectl health --json` polling.

## 18. Open Decisions for Later

These are intentionally deferred:

- Which encrypted secret store will hold chat platform credentials.
- Whether HTTPS should terminate on ECS, Windows, or a reverse proxy container.
- Whether employee containers should have network egress restrictions.
- Whether profile usage metrics should be stored per employee or per profile.
- Whether company-wide skill sharing requires admin approval.
- Whether Hermes profile data should be backed up from Docker volumes.
- Whether login lockout should move from memory to a dedicated persistent
  security store.

## 19. Acceptance Criteria

The MVP is acceptable when:

- Phase 0 confirms the Hermes image contract or a wrapper image satisfies it.
- `hermes-profilectl health/create/list/start/stop/delete` contract tests pass.
- Admin can create an employee account.
- The employee has exactly one Docker container record.
- Admin can create/start/stop/restart/reset the employee container.
- Employee can start/stop/restart only their own container.
- Employee can create profiles through the web UI in their own container.
- Employee cannot create profiles for another employee.
- Profile config is delivered through `docker exec -i ... --config-json -`.
- Reset can replay profiles idempotently against a retained Docker volume.
- Profile creation uses the private LLM config automatically.
- Employee cannot configure public model providers.
- Username slug collisions are rejected.
- Usernames that cannot produce a Docker-safe slug are rejected with a clear
  validation message.
- JSON store writes are serialized and atomic.
- Same-target lifecycle actions are rejected with `409 Conflict` while one is
  in progress.
- Slow Docker/profile commands do not block unrelated state mutations while
  they run.
- Execution records are stored with redacted command/stdout/stderr.
- CSRF is required for authenticated mutating requests.
- CORS is not enabled for the MVP API.
- Login lockout works.
- Login lockout counters are bounded, in-memory, and cleaned when expired.
- Login lockout is keyed by username only because FRP TCP hides real client IP
  from the web app.
- Bootstrap admin must change password after first login.
- Password change always requires the current password.
- Password change invalidates other active sessions for that user.
- Final admin cannot be deleted or downgraded.
- Profile has an `enabled` flag separate from runtime `status`.
- Disabled profiles cannot be started.
- Skill/MCP resources can be private or company-shared.
- Chat binding metadata can be saved for WeChat, Feishu, WeCom, and QQ.
- `credentialRef` is validated as metadata and not resolved to raw secrets in
  the MVP.
- The app is reachable locally at `127.0.0.1:3080`.
- The app is reachable through FRP at `60.205.213.254:2444`.
- Tests cover RBAC, Docker command planning, private model enforcement, profile
  ownership, resource visibility, CSRF, session expiry, slug collisions,
  same-target lifecycle conflicts, operationId stale-result handling,
  concurrent state writes, reset replay, execution redaction, CORS disabled
  behavior, username-only login lockout, disabled profile start rejection,
  session revocation after password change, container reconciliation, and
  static page serving.
