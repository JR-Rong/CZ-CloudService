# Agent Platform Operator Entry

The production web app lives in `apps/ui` as specified by
`docs/agent-platform/hermes-agent-platform-design.md`.

This folder holds operator-facing entrypoints for the Hermes Agent platform:

- `hermes-contract-smoke.sh` verifies the required `hermes-profilectl` image
  contract against the configured Docker image.
- `local-acceptance.sh` runs the repeatable local Phase 5 acceptance checks:
  Node tests, JavaScript syntax checks, Bash syntax checks, FRP config dry-run,
  optional public FRP smoke, and the local diff whitespace gate.
- `hermes-wrapper/` contains a small file-backed `hermes-profilectl` shim and
  Dockerfile for Phase 0 wrapper builds when the upstream image does not yet
  expose the required profile-control contract.
- `runtime/` is intentionally ignored and may be used for local generated
  env files, smoke payloads, and temporary operator artifacts.

Do not commit FRP tokens, LLM API keys, chat credentials, generated env files,
or Docker runtime state here.
