const path = require("node:path");

function parseList(value, fallback) {
  if (!value) {
    return fallback;
  }
  return String(value)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function getConfig(overrides = {}) {
  const env = process.env;
  const appRoot = path.resolve(__dirname, "..");
  const llmApiKeyEnv = overrides.llmApiKeyEnv ?? env.LOCAL_LLM_API_KEY_ENV ?? "AI_API_KEY";
  const port = Number(overrides.port ?? env.PORT ?? 3080);
  const publicAccessTarget =
    overrides.publicAccessTarget ?? env.AGENT_PLATFORM_PUBLIC_TARGET ?? "60.205.213.254:2444";

  return {
    host: overrides.host ?? env.HOST ?? "127.0.0.1",
    port,
    appRoot,
    dataFile: overrides.dataFile ?? env.AGENT_PLATFORM_DATA ?? path.join(appRoot, "data", "state.json"),
    runtimeDir:
      overrides.runtimeDir ??
      env.AGENT_PLATFORM_RUNTIME_DIR ??
      path.join(appRoot, "runtime"),
    dockerMode: overrides.dockerMode ?? env.DOCKER_MANAGER_MODE ?? "dry-run",
    dockerBinary: overrides.dockerBinary ?? env.DOCKER_BINARY ?? "docker",
    hermesImage: overrides.hermesImage ?? env.HERMES_IMAGE ?? "hermes:latest",
    llmBaseUrl: overrides.llmBaseUrl ?? env.LOCAL_LLM_BASE_URL ?? "http://192.168.100.12:8000/v1",
    llmModel: overrides.llmModel ?? env.LOCAL_LLM_MODEL ?? "qwen3.6-35b-a3b",
    llmApiKeyEnv,
    llmApiKey: overrides.llmApiKey ?? env[llmApiKeyEnv] ?? "",
    bootstrapAdminUsername:
      overrides.bootstrapAdminUsername ?? env.BOOTSTRAP_ADMIN_USERNAME ?? "admin",
    bootstrapAdminPassword:
      overrides.bootstrapAdminPassword ?? env.BOOTSTRAP_ADMIN_PASSWORD ?? "change-me-admin",
    sessionTtlHours: Number(overrides.sessionTtlHours ?? env.SESSION_TTL_HOURS ?? 12),
    readinessTimeoutMs: Number(overrides.readinessTimeoutMs ?? env.HERMES_READINESS_TIMEOUT_MS ?? 120000),
    readinessPollMs: Number(overrides.readinessPollMs ?? env.HERMES_READINESS_POLL_MS ?? 2000),
    publicAccessTarget,
    allowedHosts: overrides.allowedHosts ?? parseList(env.AGENT_PLATFORM_ALLOWED_HOSTS, [
      `127.0.0.1:${port}`,
      `localhost:${port}`,
      publicAccessTarget,
    ]),
    publicDir: overrides.publicDir ?? path.join(appRoot, "public"),
  };
}

module.exports = {
  getConfig,
};
