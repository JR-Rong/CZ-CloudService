const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const HERMES_HEALTH_STATUSES = new Set(["starting", "ready", "degraded", "error"]);

function shellQuote(value) {
  const text = String(value);
  if (/^[A-Za-z0-9_./:=@<>-]+$/.test(text)) {
    return text;
  }
  return `"${text.replace(/(["\\$`])/g, "\\$1")}"`;
}

function redactSecrets(text, secrets = []) {
  let output = String(text || "");
  for (const secret of secrets) {
    if (secret) {
      output = output.split(String(secret)).join("<redacted>");
    }
  }
  output = output.replace(/OPENAI_API_KEY=([^\s"']+)/g, "OPENAI_API_KEY=<redacted>");
  output = output.replace(/secret:\/\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+/g, "secret://<redacted>");
  output = output.replace(/--env-file\s+(\S+)/g, "--env-file <redacted-env-file>");
  return output;
}

function redactCommand(command, secrets = []) {
  const redactedParts = [];
  for (let index = 0; index < command.length; index += 1) {
    const part = command[index];
    if (part === "--env-file") {
      redactedParts.push("--env-file", "<redacted-env-file>");
      index += 1;
      continue;
    }
    redactedParts.push(redactSecrets(part, secrets));
  }
  return redactedParts.map(shellQuote).join(" ");
}

function envLine(key, value) {
  return `${key}=${String(value ?? "").replace(/\r?\n/g, " ")}`;
}

function buildEnvFile(container, owner, config) {
  const envPath = path.resolve(config.runtimeDir, `${container.containerName}.env`);
  const baseUrl = container.llm?.baseUrl || config.llmBaseUrl;
  const model = container.llm?.model || config.llmModel;
  const lines = [
    envLine("OPENAI_BASE_URL", baseUrl),
    envLine("OPENAI_API_BASE", baseUrl),
    envLine("OPENAI_MODEL", model),
    envLine("LOCAL_LLM_MODEL", model),
    envLine("HERMES_PRIVATE_MODEL_ONLY", "1"),
    envLine("HERMES_OWNER_ID", owner.id),
    envLine("HERMES_EMPLOYEE_USERNAME", owner.username),
  ];
  if (config.llmApiKey) {
    lines.push(envLine("OPENAI_API_KEY", config.llmApiKey));
  } else {
    lines.push(envLine("OPENAI_API_KEY", `$${config.llmApiKeyEnv}`));
  }
  return {
    path: envPath,
    contents: `${lines.join("\n")}\n`,
  };
}

function buildRunCommand(container, owner, config) {
  const image = container.image || config.hermesImage;
  const envFile = buildEnvFile(container, owner, config);
  const command = [
    config.dockerBinary,
    "run",
    "-d",
    "--name",
    container.containerName,
    "--restart",
    "unless-stopped",
    "--label",
    `cz.agent.owner=${owner.id}`,
    "--label",
    `cz.agent.username=${owner.usernameSlug || owner.username}`,
    "--env-file",
    envFile.path,
    "-v",
    `${container.containerName}-data:/data`,
    image,
  ];
  return { command, envFile };
}

function buildDockerPlan(action, container, owner, config) {
  const dockerBinary = config.dockerBinary;
  const containerName = container.containerName;
  const secrets = [config.llmApiKey].filter(Boolean);

  if (action === "create") {
    const run = buildRunCommand(container, owner, config);
    return {
      kind: "docker",
      action,
      containerName,
      command: run.command,
      envFile: run.envFile,
      redactedCommand: redactCommand(run.command, secrets),
    };
  }

  if (action === "reset") {
    const remove = [dockerBinary, "rm", "-f", containerName];
    const run = buildRunCommand(container, owner, config);
    return {
      kind: "docker",
      action,
      containerName,
      envFile: run.envFile,
      steps: [
        { command: remove, redactedCommand: redactCommand(remove, secrets), removeEnvFilePath: run.envFile.path },
        { command: run.command, redactedCommand: redactCommand(run.command, secrets), envFile: run.envFile },
      ],
    };
  }

  if (action === "delete") {
    const command = [dockerBinary, "rm", "-f", containerName];
    return {
      kind: "docker",
      action,
      containerName,
      envFilePath: path.resolve(config.runtimeDir, `${containerName}.env`),
      command,
      redactedCommand: redactCommand(command, secrets),
    };
  }

  const actionMap = {
    start: ["start", containerName],
    stop: ["stop", containerName],
    restart: ["restart", containerName],
  };

  if (!actionMap[action]) {
    throw Object.assign(new Error(`Unsupported container action: ${action}`), { status: 400 });
  }

  const command = [dockerBinary, ...actionMap[action]];
  return {
    kind: "docker",
    action,
    containerName,
    command,
    redactedCommand: redactCommand(command, secrets),
  };
}

function activeBindings(profile) {
  return (profile.bindings || []).filter((binding) => binding.enabled !== false);
}

function buildProfileConfig(profile, container, resources) {
  return {
    version: 1,
    slug: profile.slug,
    displayName: profile.displayName,
    description: profile.description || "",
    model: {
      provider: "openai-compatible",
      baseUrl: container.llm?.baseUrl,
      model: container.llm?.model,
      privateOnly: true,
    },
    bindings: activeBindings(profile).map((binding) => ({
      id: binding.id,
      platform: binding.platform,
      displayName: binding.displayName,
      externalRef: binding.externalRef || "",
      credentialRef: binding.credentialRef || "",
      enabled: binding.enabled !== false,
    })),
    resources: (resources || []).map((resource) => ({
      id: resource.id,
      type: resource.type,
      name: resource.name,
      description: resource.description || "",
      visibility: resource.visibility,
      packageRef: resource.packageRef || "",
      version: resource.version || "",
    })),
  };
}

function buildProfilePlan(action, profile, container, configJson, config) {
  const dockerBinary = config.dockerBinary;
  let command;
  let stdin = "";

  if (action === "create") {
    stdin = JSON.stringify(configJson);
    command = [
      dockerBinary,
      "exec",
      "-i",
      container.containerName,
      "hermes-profilectl",
      "create",
      "--slug",
      profile.slug,
      "--name",
      profile.displayName,
      "--config-json",
      "-",
    ];
  } else if (["start", "stop", "restart", "delete"].includes(action)) {
    command = [dockerBinary, "exec", container.containerName, "hermes-profilectl", action, profile.slug];
  } else if (action === "list") {
    command = [dockerBinary, "exec", container.containerName, "hermes-profilectl", "list", "--json"];
  } else if (action === "health") {
    command = [dockerBinary, "exec", container.containerName, "hermes-profilectl", "health", "--json"];
  } else {
    throw Object.assign(new Error(`Unsupported profile action: ${action}`), { status: 400 });
  }

  return {
    kind: "profilectl",
    action,
    containerName: container.containerName,
    profileSlug: profile.slug,
    command,
    stdin,
    stdinHash: stdin ? crypto.createHash("sha256").update(stdin).digest("hex") : null,
    redactedCommand: redactCommand(command),
  };
}

function runCommand(command, stdin = "") {
  return new Promise((resolve) => {
    const child = spawn(command[0], command.slice(1), {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      resolve({ ok: false, exitCode: null, stdout, stderr: error.message });
    });
    child.on("close", (code) => {
      resolve({ ok: code === 0, exitCode: code, stdout: stdout.trim(), stderr: stderr.trim() });
    });
    if (stdin) {
      child.stdin.end(stdin);
    } else {
      child.stdin.end();
    }
  });
}

async function runJsonCommand(command, stdin = "") {
  const result = await runCommand(command, stdin);
  if (!result.ok) {
    return { available: false, error: result.stderr || result.stdout || `exit ${result.exitCode}` };
  }
  try {
    return { available: true, json: JSON.parse(result.stdout || "{}"), stdout: result.stdout };
  } catch {
    return { available: false, error: "Command did not return JSON.", stdout: result.stdout };
  }
}

function writeEnvFile(envFile) {
  fs.mkdirSync(path.dirname(envFile.path), { recursive: true });
  fs.writeFileSync(envFile.path, envFile.contents, { mode: 0o600 });
  try {
    fs.chmodSync(envFile.path, 0o600);
  } catch {
    // Windows ACL hardening is handled by the deployment script.
  }
}

class DockerManager {
  constructor(config) {
    this.config = config;
  }

  async execute(plan) {
    const startedAt = new Date().toISOString();
    if (this.config.dockerMode !== "real") {
      return {
        ok: true,
        mode: "dry-run",
        dryRun: true,
        action: plan.action,
        containerName: plan.containerName,
        redactedCommand: plan.redactedCommand || plan.steps?.map((step) => step.redactedCommand).join(" && "),
        stdout: JSON.stringify({ dryRun: true, action: plan.action, containerName: plan.containerName }),
        stderr: "",
        exitCode: 0,
        stdinHash: plan.stdinHash || null,
        startedAt,
        finishedAt: new Date().toISOString(),
      };
    }

    if (this.requiresRuntimeApiKey(plan) && !this.config.llmApiKey) {
      return {
        ok: false,
        mode: "real",
        dryRun: false,
        action: plan.action,
        containerName: plan.containerName,
        redactedCommand: plan.redactedCommand || plan.steps?.map((step) => step.redactedCommand).join(" && ") || "",
        stdout: "",
        stderr: `${this.config.llmApiKeyEnv || "AI_API_KEY"} is required for real Docker container creation.`,
        exitCode: 20,
        stdinHash: plan.stdinHash || null,
        startedAt,
        finishedAt: new Date().toISOString(),
      };
    }

    if (plan.steps) {
      const outputs = [];
      for (const step of plan.steps) {
        if (step.envFile) {
          writeEnvFile(step.envFile);
        }
        const result = await runCommand(step.command, step.stdin || "");
        outputs.push({ ...result, redactedCommand: step.redactedCommand });
        if (!result.ok) {
          return this.finishResult(plan, startedAt, false, outputs);
        }
        if (step.removeEnvFilePath) {
          fs.rmSync(step.removeEnvFilePath, { force: true });
        }
      }
      return this.finishResult(plan, startedAt, true, outputs);
    }

    if (plan.envFile) {
      writeEnvFile(plan.envFile);
    }
    const result = await runCommand(plan.command, plan.stdin || "");
    if (result.ok && plan.action === "delete" && plan.envFilePath) {
      fs.rmSync(plan.envFilePath, { force: true });
    }
    return {
      ...result,
      ok: result.ok,
      mode: "real",
      dryRun: false,
      action: plan.action,
      containerName: plan.containerName,
      redactedCommand: plan.redactedCommand,
      stdout: redactSecrets(result.stdout, [this.config.llmApiKey]),
      stderr: redactSecrets(result.stderr, [this.config.llmApiKey]),
      stdinHash: plan.stdinHash || null,
      startedAt,
      finishedAt: new Date().toISOString(),
    };
  }

  requiresRuntimeApiKey(plan) {
    if (plan.envFile) {
      return true;
    }
    return Boolean(plan.steps?.some((step) => step.envFile));
  }

  async inspectContainer(container) {
    if (this.config.dockerMode !== "real") {
      return { available: false, warning: "Docker inspect skipped in dry-run mode." };
    }
    const startedAt = new Date().toISOString();
    const command = [
      this.config.dockerBinary,
      "inspect",
      "--format",
      "{{.State.Running}}",
      container.containerName,
    ];
    const result = await runCommand(command);
    const execution = {
      ...result,
      mode: "real",
      dryRun: false,
      action: "inspect",
      containerName: container.containerName,
      redactedCommand: redactCommand(command, [this.config.llmApiKey]),
      stdout: redactSecrets(result.stdout, [this.config.llmApiKey]),
      stderr: redactSecrets(result.stderr, [this.config.llmApiKey]),
      stdinHash: null,
      startedAt,
      finishedAt: new Date().toISOString(),
    };
    if (!result.ok) {
      return { available: false, warning: result.stderr || result.stdout || "Docker inspect failed.", execution };
    }
    return { available: true, running: result.stdout.trim() === "true", execution };
  }

  async checkProfileHealth(container) {
    const plan = buildProfilePlan("health", { slug: "" }, container, null, this.config);
    const startedAt = new Date().toISOString();
    if (this.config.dockerMode !== "real") {
      return {
        available: true,
        status: "ready",
        stdout: "{\"status\":\"ready\"}",
        execution: {
          ok: true,
          mode: "dry-run",
          dryRun: true,
          action: "health",
          containerName: container.containerName,
          redactedCommand: plan.redactedCommand,
          stdout: "{\"status\":\"ready\"}",
          stderr: "",
          exitCode: 0,
          stdinHash: null,
          startedAt,
          finishedAt: new Date().toISOString(),
        },
      };
    }
    const result = await runCommand(plan.command);
    const execution = {
      ...result,
      mode: "real",
      dryRun: false,
      action: "health",
      containerName: container.containerName,
      redactedCommand: plan.redactedCommand,
      stdout: redactSecrets(result.stdout, [this.config.llmApiKey]),
      stderr: redactSecrets(result.stderr, [this.config.llmApiKey]),
      stdinHash: null,
      startedAt,
      finishedAt: new Date().toISOString(),
    };
    if (!result.ok) {
      return {
        available: false,
        status: "error",
        warning: result.stderr || result.stdout || "Profile health failed.",
        stdout: result.stdout || "",
        execution,
      };
    }
    try {
      const payload = JSON.parse(result.stdout || "{}");
      const status = typeof payload.status === "string" ? payload.status : "";
      if (!HERMES_HEALTH_STATUSES.has(status)) {
        return {
          available: false,
          status: "error",
          warning: `Unsupported Hermes health status: ${status || "<missing>"}.`,
          stdout: result.stdout,
          execution,
        };
      }
      return {
        available: true,
        status,
        stdout: result.stdout,
        privateModel: payload.privateModel || null,
        execution,
      };
    } catch {
      return {
        available: false,
        status: "error",
        warning: "Command did not return JSON.",
        stdout: result.stdout,
        execution,
      };
    }
  }

  async listProfiles(container) {
    const plan = buildProfilePlan("list", { slug: "" }, container, null, this.config);
    const startedAt = new Date().toISOString();
    if (this.config.dockerMode !== "real") {
      return {
        available: true,
        profiles: [],
        execution: {
          ok: true,
          mode: "dry-run",
          dryRun: true,
          action: "list",
          containerName: container.containerName,
          redactedCommand: plan.redactedCommand,
          stdout: JSON.stringify({ profiles: [] }),
          stderr: "",
          exitCode: 0,
          stdinHash: null,
          startedAt,
          finishedAt: new Date().toISOString(),
        },
      };
    }
    const result = await runCommand(plan.command);
    const execution = {
      ...result,
      mode: "real",
      dryRun: false,
      action: "list",
      containerName: container.containerName,
      redactedCommand: plan.redactedCommand,
      stdout: redactSecrets(result.stdout, [this.config.llmApiKey]),
      stderr: redactSecrets(result.stderr, [this.config.llmApiKey]),
      stdinHash: null,
      startedAt,
      finishedAt: new Date().toISOString(),
    };
    if (!result.ok) {
      return {
        available: false,
        profiles: [],
        warning: result.stderr || result.stdout || "Profile list failed.",
        stdout: result.stdout || "",
        execution,
      };
    }
    try {
      const payload = JSON.parse(result.stdout || "{}");
      return {
        available: true,
        profiles: Array.isArray(payload.profiles) ? payload.profiles : [],
        execution,
      };
    } catch {
      return {
        available: false,
        profiles: [],
        warning: "Command did not return JSON.",
        stdout: result.stdout,
        execution,
      };
    }
  }

  finishResult(plan, startedAt, ok, outputs) {
    return {
      ok,
      mode: "real",
      dryRun: false,
      action: plan.action,
      containerName: plan.containerName,
      redactedCommand: outputs.map((output) => output.redactedCommand).join(" && "),
      stdout: redactSecrets(
        outputs.map((output) => output.stdout).filter(Boolean).join("\n"),
        [this.config.llmApiKey],
      ),
      stderr: redactSecrets(
        outputs.map((output) => output.stderr).filter(Boolean).join("\n"),
        [this.config.llmApiKey],
      ),
      exitCode: ok ? 0 : outputs.at(-1)?.exitCode ?? 1,
      stdinHash: plan.stdinHash || null,
      startedAt,
      finishedAt: new Date().toISOString(),
    };
  }
}

module.exports = {
  DockerManager,
  buildDockerPlan,
  buildProfileConfig,
  buildProfilePlan,
  redactCommand,
  redactSecrets,
};
