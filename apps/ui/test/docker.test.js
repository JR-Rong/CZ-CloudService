const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  DockerManager,
  buildDockerPlan,
  buildProfileConfig,
  buildProfilePlan,
  redactSecrets,
} = require("../src/docker");

test("docker create plan uses env file and injects private model settings", () => {
  const container = {
    id: "ctr_123",
    ownerId: "usr_alice",
    containerName: "hermes-alice",
    image: "registry.internal/hermes:2026.06",
  };
  const owner = { id: "usr_alice", username: "alice", usernameSlug: "alice" };
  const config = {
    dockerBinary: "docker",
    runtimeDir: "/var/lib/cz-agent-platform",
    llmBaseUrl: "http://192.168.100.12:8000/v1",
    llmModel: "qwen3.6-35b-a3b",
    llmApiKeyEnv: "AI_API_KEY",
    llmApiKey: "super-secret",
  };

  const plan = buildDockerPlan("create", container, owner, config);

  assert.equal(plan.kind, "docker");
  assert.equal(plan.containerName, "hermes-alice");
  assert.deepEqual(plan.command.slice(0, 4), ["docker", "run", "-d", "--name"]);
  assert.equal(plan.command.includes("--env-file"), true);
  assert.equal(plan.command.includes("/var/lib/cz-agent-platform/hermes-alice.env"), true);
  assert.equal(plan.command.includes("registry.internal/hermes:2026.06"), true);
  assert.equal(plan.command.includes("OPENAI_API_KEY=super-secret"), false);
  assert.equal(plan.redactedCommand.includes("super-secret"), false);
  assert.equal(plan.redactedCommand.includes("--env-file <redacted-env-file>"), true);
  assert.match(plan.envFile.contents, /OPENAI_BASE_URL=http:\/\/192\.168\.100\.12:8000\/v1/);
  assert.match(plan.envFile.contents, /OPENAI_API_BASE=http:\/\/192\.168\.100\.12:8000\/v1/);
  assert.match(plan.envFile.contents, /OPENAI_MODEL=qwen3\.6-35b-a3b/);
  assert.match(plan.envFile.contents, /LOCAL_LLM_MODEL=qwen3\.6-35b-a3b/);
  assert.match(plan.envFile.contents, /HERMES_PRIVATE_MODEL_ONLY=1/);
  assert.match(plan.envFile.contents, /HERMES_OWNER_ID=usr_alice/);
  assert.match(plan.envFile.contents, /HERMES_EMPLOYEE_USERNAME=alice/);
  assert.match(plan.envFile.contents, /OPENAI_API_KEY=super-secret/);
});

test("reset plan removes and recreates the employee container without deleting volume", () => {
  const container = { id: "ctr_999", containerName: "hermes-bob", image: "hermes:latest" };
  const owner = { id: "usr_bob", username: "bob", usernameSlug: "bob" };
  const config = {
    dockerBinary: "docker",
    runtimeDir: "/var/lib/cz-agent-platform",
    llmBaseUrl: "http://192.168.100.12:8000/v1",
    llmModel: "qwen3.6-35b-a3b",
    llmApiKeyEnv: "AI_API_KEY",
    llmApiKey: "secret",
  };

  const plan = buildDockerPlan("reset", container, owner, config);

  assert.equal(plan.steps.length, 2);
  assert.deepEqual(plan.steps[0].command, ["docker", "rm", "-f", "hermes-bob"]);
  assert.equal(plan.steps[1].command[1], "run");
  assert.equal(plan.steps[1].command.includes("hermes-bob-data:/data"), true);
  assert.equal(plan.steps[1].redactedCommand.includes("secret"), false);
});

test("profile create plan uses docker exec stdin config and no temp file", () => {
  const container = {
    id: "ctr_alice",
    ownerId: "usr_alice",
    containerName: "hermes-alice",
    llm: {
      baseUrl: "http://192.168.100.12:8000/v1",
      model: "qwen3.6-35b-a3b",
      privateOnly: true,
    },
  };
  const profile = {
    id: "pro_sales",
    slug: "sales-assistant",
    displayName: "Sales Assistant",
    description: "Helps with sales replies.",
    bindings: [
      {
        id: "bind_1",
        platform: "feishu",
        displayName: "Sales Bot",
        externalRef: "bot-sales",
        credentialRef: "secret://feishu/sales-01",
        enabled: true,
      },
    ],
    resourceIds: ["res_company"],
  };
  const resources = [
    {
      id: "res_company",
      type: "skill",
      name: "contract-review",
      packageRef: "skills/contract-review",
      visibility: "company",
      version: "0.1.0",
    },
  ];

  const configJson = buildProfileConfig(profile, container, resources);
  const plan = buildProfilePlan("create", profile, container, configJson, { dockerBinary: "docker" });

  assert.deepEqual(plan.command, [
    "docker",
    "exec",
    "-i",
    "hermes-alice",
    "hermes-profilectl",
    "create",
    "--slug",
    "sales-assistant",
    "--name",
    "Sales Assistant",
    "--config-json",
    "-",
  ]);
  assert.equal(plan.stdin.includes("/tmp/profile.json"), false);
  const payload = JSON.parse(plan.stdin);
  assert.equal(payload.version, 1);
  assert.equal(payload.model.privateOnly, true);
  assert.equal(payload.model.model, "qwen3.6-35b-a3b");
  assert.equal(payload.bindings[0].credentialRef, "secret://feishu/sales-01");
  assert.equal(payload.resources[0].packageRef, "skills/contract-review");
});

test("redaction hides runtime secrets from command output", () => {
  const redacted = redactSecrets(
    "docker run --env-file /var/lib/cz/hermes-alice.env super-secret secret://feishu/sales-01",
    ["super-secret", "secret://feishu/sales-01"],
  );

  assert.equal(redacted.includes("super-secret"), false);
  assert.equal(redacted.includes("secret://feishu/sales-01"), false);
  assert.match(redacted, /<redacted>/);
  assert.match(redacted, /<redacted-env-file>/);
});

test("real multi-step docker results redact secrets from stdout and stderr", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-platform-docker-"));
  const fakeDocker = path.join(dir, "fake-docker.sh");
  fs.writeFileSync(
    fakeDocker,
    "#!/bin/sh\nprintf 'stdout super-secret\\n'\nprintf 'stderr super-secret\\n' >&2\n",
    { mode: 0o700 },
  );
  try {
    const container = { id: "ctr_999", containerName: "hermes-bob", image: "hermes:latest" };
    const owner = { id: "usr_bob", username: "bob", usernameSlug: "bob" };
    const config = {
      dockerMode: "real",
      dockerBinary: fakeDocker,
      runtimeDir: dir,
      llmBaseUrl: "http://192.168.100.12:8000/v1",
      llmModel: "qwen3.6-35b-a3b",
      llmApiKeyEnv: "AI_API_KEY",
      llmApiKey: "super-secret",
    };
    const plan = buildDockerPlan("reset", container, owner, config);
    const result = await new DockerManager(config).execute(plan);

    assert.equal(result.ok, true);
    assert.equal(result.stdout.includes("super-secret"), false);
    assert.equal(result.stderr.includes("super-secret"), false);
    assert.match(result.stdout, /<redacted>/);
    assert.match(result.stderr, /<redacted>/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("real reset removes a stale env file before writing a fresh one", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-platform-docker-"));
  const fakeDocker = path.join(dir, "fake-docker.sh");
  fs.writeFileSync(fakeDocker, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  try {
    const container = { id: "ctr_alice", containerName: "hermes-alice", image: "hermes:latest" };
    const owner = { id: "usr_alice", username: "alice", usernameSlug: "alice" };
    const config = {
      dockerMode: "real",
      dockerBinary: fakeDocker,
      runtimeDir: dir,
      llmBaseUrl: "http://192.168.100.12:8000/v1",
      llmModel: "qwen3.6-35b-a3b",
      llmApiKeyEnv: "AI_API_KEY",
      llmApiKey: "fresh-secret",
    };
    const staleEnvPath = path.join(dir, "hermes-alice.env");
    fs.writeFileSync(staleEnvPath, "OPENAI_API_KEY=stale-secret\n", { mode: 0o400 });

    const plan = buildDockerPlan("reset", container, owner, config);
    const result = await new DockerManager(config).execute(plan);

    assert.equal(result.ok, true);
    const contents = fs.readFileSync(staleEnvPath, "utf8");
    assert.match(contents, /OPENAI_API_KEY=fresh-secret/);
    assert.equal(contents.includes("stale-secret"), false);
  } finally {
    fs.chmodSync(path.join(dir, "hermes-alice.env"), 0o600);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("real container delete removes the runtime env file after Docker succeeds", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-platform-docker-"));
  const fakeDocker = path.join(dir, "fake-docker.sh");
  fs.writeFileSync(fakeDocker, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  try {
    const container = { id: "ctr_alice", containerName: "hermes-alice", image: "hermes:latest" };
    const owner = { id: "usr_alice", username: "alice", usernameSlug: "alice" };
    const config = {
      dockerMode: "real",
      dockerBinary: fakeDocker,
      runtimeDir: dir,
      llmBaseUrl: "http://192.168.100.12:8000/v1",
      llmModel: "qwen3.6-35b-a3b",
      llmApiKeyEnv: "AI_API_KEY",
      llmApiKey: "secret",
    };
    const envPath = path.join(dir, "hermes-alice.env");
    fs.writeFileSync(envPath, "OPENAI_API_KEY=secret\n", { mode: 0o600 });

    const plan = buildDockerPlan("delete", container, owner, config);
    const result = await new DockerManager(config).execute(plan);

    assert.equal(result.ok, true);
    assert.equal(fs.existsSync(envPath), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("real container create requires a resolved runtime LLM API key", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-platform-docker-"));
  const fakeDocker = path.join(dir, "fake-docker.sh");
  fs.writeFileSync(fakeDocker, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  try {
    const container = { id: "ctr_alice", containerName: "hermes-alice", image: "hermes:latest" };
    const owner = { id: "usr_alice", username: "alice", usernameSlug: "alice" };
    const config = {
      dockerMode: "real",
      dockerBinary: fakeDocker,
      runtimeDir: dir,
      llmBaseUrl: "http://192.168.100.12:8000/v1",
      llmModel: "qwen3.6-35b-a3b",
      llmApiKeyEnv: "AI_API_KEY",
      llmApiKey: "",
    };
    const plan = buildDockerPlan("create", container, owner, config);
    const result = await new DockerManager(config).execute(plan);

    assert.equal(result.ok, false);
    assert.equal(result.exitCode, 20);
    assert.match(result.stderr, /AI_API_KEY/);
    assert.equal(fs.existsSync(plan.envFile.path), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("real profile health rejects unsupported Hermes status values", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-platform-docker-"));
  const fakeDocker = path.join(dir, "fake-docker.sh");
  fs.writeFileSync(fakeDocker, "#!/bin/sh\nprintf '{\"status\":\"warming\",\"privateModel\":{\"privateOnly\":true}}\\n'\n", {
    mode: 0o700,
  });
  try {
    const result = await new DockerManager({
      dockerMode: "real",
      dockerBinary: fakeDocker,
      llmApiKey: "secret",
    }).checkProfileHealth({ containerName: "hermes-alice" });

    assert.equal(result.available, false);
    assert.equal(result.status, "error");
    assert.equal(result.stdout, "{\"status\":\"warming\",\"privateModel\":{\"privateOnly\":true}}");
    assert.match(result.warning, /Unsupported Hermes health status: warming/);
    assert.match(result.execution.redactedCommand, /hermes-profilectl health --json/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
