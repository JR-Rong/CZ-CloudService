const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const crypto = require("node:crypto");
const { URL } = require("node:url");

const { verifyPassword } = require("./auth");
const { getConfig } = require("./config");
const {
  DockerManager,
  buildDockerPlan,
  buildProfileConfig,
  buildProfilePlan,
} = require("./docker");
const {
  canManageContainer,
  canManageProfile,
  canManageResource,
  canViewResource,
  filterContainersForActor,
  filterProfilesForActor,
  filterResourcesForActor,
  isAdmin,
} = require("./policy");
const { validateCredentialRef } = require("./secrets");
const { JsonStore, publicUser } = require("./store");

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

const FORBIDDEN_MODEL_FIELDS = new Set([
  "model",
  "provider",
  "baseUrl",
  "apiKey",
  "openaiBaseUrl",
  "openaiModel",
]);

const SUPPORTED_BINDING_PLATFORMS = new Set(["wechat", "feishu", "wecom", "qq"]);
const SUPPORTED_CONTAINER_ACTIONS = new Set(["create", "start", "stop", "restart", "reset", "delete"]);
const RESETTABLE_CONTAINER_STATES = new Set(["created", "running", "stopped", "error"]);
const EXISTING_CONTAINER_ACTIONS = new Set(["start", "stop", "restart", "delete"]);
const IN_PROGRESS_CONTAINER_STATES = new Set(["creating", "starting", "stopping", "resetting", "deleting"]);
const IN_PROGRESS_PROFILE_STATES = new Set(["applying", "starting", "stopping", "deleting"]);

function nowIso() {
  return new Date().toISOString();
}

function newId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function newOperationId() {
  return crypto.randomUUID();
}

function sendJson(res, status, payload, headers = {}) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    ...headers,
  });
  res.end(JSON.stringify(payload));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) {
        reject(Object.assign(new Error("Request body is too large."), { status: 413 }));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (!body) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(Object.assign(new Error("Invalid JSON body."), { status: 400 }));
      }
    });
  });
}

function getCookie(req, name) {
  const cookie = req.headers.cookie || "";
  for (const part of cookie.split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) {
      return value.join("=");
    }
  }
  return "";
}

function notFound() {
  throw Object.assign(new Error("Not found."), { status: 404 });
}

function requireAdmin(actor) {
  if (!isAdmin(actor)) {
    throw Object.assign(new Error("Administrator permission required."), { status: 403 });
  }
}

function routePattern(pattern, pathname) {
  const patternParts = pattern.split("/").filter(Boolean);
  const pathParts = pathname.split("/").filter(Boolean);
  if (patternParts.length !== pathParts.length) {
    return null;
  }
  const params = {};
  for (let index = 0; index < patternParts.length; index += 1) {
    const patternPart = patternParts[index];
    const pathPart = pathParts[index];
    if (patternPart.startsWith(":")) {
      params[patternPart.slice(1)] = decodeURIComponent(pathPart);
    } else if (patternPart !== pathPart) {
      return null;
    }
  }
  return params;
}

function serveStatic(req, res, config) {
  const requestedUrl = new URL(req.url, "http://localhost");
  const requestedPath = requestedUrl.pathname === "/" ? "/index.html" : requestedUrl.pathname;
  const relativePath = path.normalize(requestedPath).replace(/^(\.\.[/\\])+/, "");
  const filePath = path.join(config.publicDir, relativePath);

  if (!filePath.startsWith(config.publicDir) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    sendJson(res, 404, { error: "Not found." });
    return;
  }

  const ext = path.extname(filePath);
  res.writeHead(200, { "content-type": MIME_TYPES[ext] || "application/octet-stream" });
  fs.createReadStream(filePath).pipe(res);
}

function lifecycleConflict(message, details = {}) {
  return Object.assign(new Error(message), {
    status: 409,
    details: {
      ...details,
      reason: message,
    },
  });
}

function hasForbiddenModelField(value) {
  if (!value || typeof value !== "object") {
    return false;
  }
  for (const key of Object.keys(value)) {
    if (FORBIDDEN_MODEL_FIELDS.has(key)) {
      return true;
    }
  }
  return false;
}

function validateSlug(slug) {
  if (!/^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/.test(String(slug || ""))) {
    throw Object.assign(new Error("Profile slug must be lowercase letters, numbers, and dashes."), { status: 400 });
  }
}

function validateBindings(bindings) {
  return (Array.isArray(bindings) ? bindings : []).map((binding) => {
    if (!binding || typeof binding !== "object" || Array.isArray(binding)) {
      throw Object.assign(new Error("Chat binding must be an object."), { status: 400 });
    }
    if (!SUPPORTED_BINDING_PLATFORMS.has(binding.platform)) {
      throw Object.assign(new Error("Unsupported chat binding platform."), { status: 400 });
    }
    if (!validateCredentialRef(binding.credentialRef)) {
      throw Object.assign(new Error("credentialRef must match secret://<provider>/<name>."), { status: 400 });
    }
    return {
      id: binding.id || newId("bind"),
      platform: binding.platform,
      displayName: binding.displayName || binding.platform,
      externalRef: binding.externalRef || "",
      credentialRef: binding.credentialRef || "",
      enabled: binding.enabled !== false,
    };
  });
}

function validateVisibleResourceIds(actor, store, resourceIds = []) {
  const ids = Array.isArray(resourceIds) ? resourceIds : [];
  for (const id of ids) {
    const resource = store.getResource(id);
    if (!resource || !canViewResource(actor, resource)) {
      throw Object.assign(new Error("Resource is not visible to this user."), { status: 403 });
    }
  }
  return ids;
}

function rejectDeletedProfile(profile) {
  if (profile?.status === "deleted") {
    throw lifecycleConflict("Deleted profiles cannot be changed.", {
      status: profile.status,
    });
  }
}

function rejectDeleteFailedProfile(profile, allowDeleteRetry = false) {
  if (profile?.status === "delete_failed" && !allowDeleteRetry) {
    throw lifecycleConflict("Failed profile deletes must be retried before other changes.", {
      status: profile.status,
    });
  }
}

class OperationLocks {
  constructor() {
    this.locks = new Set();
  }

  acquire(key) {
    if (this.locks.has(key)) {
      throw Object.assign(new Error("A lifecycle action is already in progress."), {
        status: 409,
        details: { key },
      });
    }
    this.locks.add(key);
  }

  release(key) {
    this.locks.delete(key);
  }

  has(key) {
    return this.locks.has(key);
  }
}

class LoginThrottler {
  constructor(options = {}) {
    this.maxFailures = options.maxFailures || 5;
    this.windowMs = options.windowMs || 15 * 60 * 1000;
    this.lockMs = options.lockMs || 15 * 60 * 1000;
    this.maxEntries = options.maxEntries || 1000;
    this.cleanupIntervalMs = options.cleanupIntervalMs ?? 60 * 1000;
    this.entries = new Map();
    if (this.cleanupIntervalMs > 0) {
      this.cleanupTimer = setInterval(() => this.cleanup(), this.cleanupIntervalMs);
      this.cleanupTimer.unref?.();
    }
  }

  key(username) {
    return String(username || "").trim().toLowerCase();
  }

  cleanup(now = Date.now()) {
    for (const [key, entry] of this.entries) {
      const expiredWindow = entry.failures.every((time) => now - time > this.windowMs);
      const unlocked = !entry.lockedUntil || entry.lockedUntil <= now;
      if (expiredWindow && unlocked) {
        this.entries.delete(key);
      }
    }
    if (this.entries.size > this.maxEntries) {
      const keys = [...this.entries.keys()];
      for (const key of keys.slice(0, this.entries.size - this.maxEntries)) {
        this.entries.delete(key);
      }
    }
  }

  isLocked(username) {
    const now = Date.now();
    this.cleanup(now);
    const entry = this.entries.get(this.key(username));
    return Boolean(entry?.lockedUntil && entry.lockedUntil > now);
  }

  recordFailure(username) {
    const now = Date.now();
    const key = this.key(username);
    const entry = this.entries.get(key) || { failures: [], lockedUntil: 0 };
    entry.failures = entry.failures.filter((time) => now - time <= this.windowMs);
    entry.failures.push(now);
    if (entry.failures.length >= this.maxFailures) {
      entry.lockedUntil = now + this.lockMs;
    }
    this.entries.set(key, entry);
    this.cleanup(now);
  }

  recordSuccess(username) {
    this.entries.delete(this.key(username));
  }
}

async function getSessionContext(req, store) {
  const token = getCookie(req, "cz_agent_session");
  if (!token) {
    return null;
  }
  const session = await store.getSession(token);
  if (!session) {
    return null;
  }
  const actor = store.getUser(session.userId);
  if (!actor) {
    return null;
  }
  return { token, session, actor };
}

async function requireSessionContext(req, store) {
  const context = await getSessionContext(req, store);
  if (!context) {
    throw Object.assign(new Error("Authentication required."), { status: 401 });
  }
  return context;
}

function isMutating(method) {
  return ["POST", "PUT", "PATCH", "DELETE"].includes(method);
}

function validateOrigin(req, config) {
  const origin = req.headers.origin;
  if (!origin) {
    return;
  }
  let originHost = "";
  try {
    originHost = new URL(origin).host.toLowerCase();
  } catch {
    throw Object.assign(new Error("Invalid Origin header."), { status: 403 });
  }
  const requestHost = String(req.headers.host || "").toLowerCase();
  const allowedHosts = new Set(
    (config.allowedHosts || [])
      .map((host) => String(host).toLowerCase())
      .filter((host) => host.includes(":")),
  );
  if (originHost !== requestHost && !allowedHosts.has(originHost)) {
    throw Object.assign(new Error("Unexpected Origin host."), { status: 403 });
  }
}

function validateCsrf(req, session) {
  const submitted = req.headers["x-csrf-token"];
  if (!submitted || submitted !== session.csrfToken) {
    throw Object.assign(new Error("CSRF token required."), { status: 403 });
  }
}

function enforcePasswordChange(actor, pathname, method) {
  if (!actor.mustChangePassword) {
    return;
  }
  const allowed =
    (method === "GET" && pathname === "/api/me") ||
    (method === "POST" && pathname === "/api/me/password") ||
    (method === "POST" && pathname === "/api/logout");
  if (!allowed) {
    throw Object.assign(new Error("Password change required before continuing."), { status: 403 });
  }
}

function executionFromResult(result, actor, targetType, targetId, operation, ownerId, operationId = null) {
  return {
    operationId,
    actorId: actor.id,
    ownerId,
    targetType,
    targetId,
    operation,
    mode: result.mode,
    redactedCommand: result.redactedCommand,
    exitCode: result.exitCode,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
    stdinHash: result.stdinHash || null,
    startedAt: result.startedAt,
    finishedAt: result.finishedAt,
  };
}

function containerInProgressStatus(action) {
  return {
    create: "creating",
    start: "starting",
    stop: "stopping",
    restart: "starting",
    reset: "resetting",
    delete: "deleting",
  }[action];
}

function containerSuccessState(action) {
  if (action === "stop") {
    return { status: "stopped", health: "unknown" };
  }
  if (action === "delete") {
    return { status: "deleted", health: "unknown" };
  }
  return { status: "running", health: "ready" };
}

function profileInProgressStatus(action) {
  return {
    create: "applying",
    start: "starting",
    stop: "stopping",
    restart: "starting",
    delete: "deleting",
  }[action];
}

function profileSuccessState(action, previousStatus = "stopped") {
  if (action === "start" || action === "restart") {
    return "running";
  }
  if (action === "stop" || action === "create") {
    return previousStatus === "running" && action === "create" ? "running" : "stopped";
  }
  if (action === "delete") {
    return "deleted";
  }
  return "stopped";
}

function staleLifecycleResponse(error, target, execution) {
  if (!error?.stale) {
    throw error;
  }
  return {
    stale: true,
    reason: error.message,
    currentOperationId: error.currentOperationId || null,
    ...(target ? { [target.kind]: target.value } : {}),
    execution,
  };
}

async function waitForContainerReady(container, docker, config, onHealthResult = async () => {}) {
  const started = Date.now();
  let latest = null;
  do {
    latest = await docker.checkProfileHealth(container);
    if (latest.execution) {
      await onHealthResult(latest.execution);
    }
    if (latest.available && latest.status === "ready") {
      return latest;
    }
    if (config.readinessPollMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, config.readinessPollMs));
    }
  } while (Date.now() - started < config.readinessTimeoutMs);

  const error = new Error("Container readiness timed out before profile replay.");
  error.status = 500;
  error.latestHealth = latest;
  throw error;
}

async function reconcileContainersForActor(actor, store, docker) {
  const visible = filterContainersForActor(actor, store.listContainers());
  const warnings = [];
  const reconciled = [];

  for (const container of visible) {
    if (container.status === "deleted") {
      reconciled.push(container);
      continue;
    }
    const inspected = await docker.inspectContainer(container);
    if (inspected?.execution) {
      await store.appendExecution(
        executionFromResult(inspected.execution, actor, "container", container.id, "container.inspect", container.ownerId),
      );
    }
    if (!inspected?.available) {
      warnings.push({
        containerId: container.id,
        reason: inspected?.warning || inspected?.error || "Docker status unavailable.",
      });
      reconciled.push(container);
      continue;
    }

    let next = inspected.running
      ? { status: "running", health: container.health || "unknown" }
      : { status: "stopped", health: "unknown" };
    if (inspected.running) {
      const health = await docker.checkProfileHealth(container);
      if (health.execution) {
        await store.appendExecution(
          executionFromResult(health.execution, actor, "container", container.id, "profile.health", container.ownerId),
        );
      }
      if (health.available) {
        next.health = health.status || "error";
      } else {
        next.health = "error";
        warnings.push({
          containerId: container.id,
          reason: health.warning || health.error || "Hermes health unavailable.",
        });
      }
    }

    if (next.status !== container.status || next.health !== container.health) {
      reconciled.push(await store.updateContainerLifecycle(container.id, next));
    } else {
      reconciled.push(container);
    }
  }

  return { containers: reconciled, warnings };
}

async function replayProfilesAfterReset({ actor, container, store, docker, config }) {
  const storedProfiles = store
    .listProfilesForContainer(container.id, true)
    .filter((profile) => !["deleted", "delete_failed"].includes(profile.status));
  const existing = await docker.listProfiles(container);
  if (existing.execution) {
    await store.appendExecution(
      executionFromResult(existing.execution, actor, "container", container.id, "profile.list", container.ownerId),
    );
  }
  const existingSlugs = new Set((existing.profiles || []).map((profile) => profile.slug));
  const results = [];
  let failedCount = 0;

  function staleReplayResult(error, profile, execution = null) {
    if (!error?.stale) {
      throw error;
    }
    return {
      profileId: profile.id,
      slug: profile.slug,
      existed: existingSlugs.has(profile.slug),
      ok: false,
      stale: true,
      error: error.message,
      currentOperationId: error.currentOperationId || null,
      ...(execution ? { executionId: execution.id } : {}),
    };
  }

  for (const profile of storedProfiles) {
    const previousStatus = profile.status;
    const operationId = newOperationId();
    try {
      await store.updateProfile(profile.id, { status: "applying", operationId });
      const resources = store
        .listResources()
        .filter((resource) => (profile.resourceIds || []).includes(resource.id));
      const profileConfig = buildProfileConfig(profile, container, resources);
      const createPlan = buildProfilePlan("create", profile, container, profileConfig, config);
      const createResult = await docker.execute(createPlan);
      const createExecution = await store.appendExecution(
        executionFromResult(
          createResult,
          actor,
          "profile",
          profile.id,
          "profile.replay.create",
          profile.ownerId,
          operationId,
        ),
      );

      if (!createResult.ok) {
        failedCount += 1;
        try {
          await store.updateProfile(
            profile.id,
            { status: "error", operationId: null },
            { expectedOperationId: operationId },
          );
        } catch (error) {
          results.push(staleReplayResult(error, profile, createExecution));
          continue;
        }
        results.push({
          profileId: profile.id,
          slug: profile.slug,
          existed: existingSlugs.has(profile.slug),
          ok: false,
          executionId: createExecution.id,
        });
        continue;
      }

      let finalStatus = "stopped";
      const profileResult = {
        profileId: profile.id,
        slug: profile.slug,
        existed: existingSlugs.has(profile.slug),
        ok: true,
        executionId: createExecution.id,
        restarted: false,
      };

      if (previousStatus === "running") {
        const startPlan = buildProfilePlan("start", profile, container, null, config);
        const startResult = await docker.execute(startPlan);
        const startExecution = await store.appendExecution(
          executionFromResult(
            startResult,
            actor,
            "profile",
            profile.id,
            "profile.replay.start",
            profile.ownerId,
            operationId,
          ),
        );
        profileResult.startExecutionId = startExecution.id;
        if (startResult.ok) {
          finalStatus = "running";
          profileResult.restarted = true;
        } else {
          failedCount += 1;
          profileResult.ok = false;
          finalStatus = "error";
        }
      }

      try {
        await store.updateProfile(
          profile.id,
          { status: finalStatus, operationId: null },
          { expectedOperationId: operationId },
        );
      } catch (error) {
        if (!error?.stale) {
          throw error;
        }
        if (profileResult.ok) {
          failedCount += 1;
        }
        results.push({
          ...profileResult,
          ok: false,
          stale: true,
          error: error.message,
          currentOperationId: error.currentOperationId || null,
        });
        continue;
      }
      results.push(profileResult);
    } catch (error) {
      failedCount += 1;
      try {
        await store.updateProfile(
          profile.id,
          { status: "error", operationId: null },
          { expectedOperationId: operationId },
        );
      } catch (staleError) {
        results.push(staleReplayResult(staleError, profile));
        continue;
      }
      results.push({
        profileId: profile.id,
        slug: profile.slug,
        ok: false,
        error: error.message,
      });
    }
  }

  return {
    listed: existing.available !== false,
    existingCount: existing.profiles?.length || 0,
    results,
    failedCount,
  };
}

async function runContainerAction({ action, actor, container, owner, store, docker, config, locks }) {
  if (!SUPPORTED_CONTAINER_ACTIONS.has(action)) {
    throw Object.assign(new Error("Unsupported container action."), { status: 400 });
  }
  const allowedForEmployee = new Set(["start", "stop", "restart"]);
  if (!isAdmin(actor) && !allowedForEmployee.has(action)) {
    throw Object.assign(new Error("This container action is admin-only."), { status: 403 });
  }
  if (["create", "reset", "delete"].includes(action) && !isAdmin(actor)) {
    throw Object.assign(new Error("This container action is admin-only."), { status: 403 });
  }

  const lockKey = `container:${container.id}`;
  if (locks.has(lockKey)) {
    const current = store.getContainer(container.id) || container;
    throw lifecycleConflict("Container lifecycle action is already in progress.", {
      status: current.status,
      health: current.health,
    });
  }
  locks.acquire(lockKey);
  const operationId = newOperationId();
  try {
    const fresh = store.getContainer(container.id);
    if (!fresh || (fresh.status === "deleted" && action !== "create")) {
      notFound();
    }
    if (IN_PROGRESS_CONTAINER_STATES.has(fresh.status)) {
      throw lifecycleConflict("Container lifecycle action is already in progress.", {
        status: fresh.status,
      });
    }
    if (action === "create" && !["defined", "deleted"].includes(fresh.status)) {
      throw lifecycleConflict("Container create requires a defined or deleted container.", {
        status: fresh.status,
      });
    }
    if (EXISTING_CONTAINER_ACTIONS.has(action) && fresh.status === "defined") {
      throw lifecycleConflict("Container action requires an existing Docker container.", {
        status: fresh.status,
      });
    }
    if (action === "reset" && !RESETTABLE_CONTAINER_STATES.has(fresh.status)) {
      throw lifecycleConflict("Container reset requires an existing container.", {
        status: fresh.status,
      });
    }
    await store.updateContainerLifecycle(container.id, {
      status: containerInProgressStatus(action),
      operationId,
    });
    const plan = buildDockerPlan(action, fresh, owner, config);
    const result = await docker.execute(plan);
    const execution = await store.appendExecution(
      executionFromResult(result, actor, "container", container.id, `container.${action}`, owner.id, operationId),
    );

    if (!result.ok) {
      try {
        const updated = await store.updateContainerLifecycle(
          container.id,
          {
            status: "error",
            operationId: null,
            lastAction: { action, executionId: execution.id, at: nowIso() },
          },
          { expectedOperationId: operationId },
        );
        return { container: updated, execution };
      } catch (error) {
        return staleLifecycleResponse(error, { kind: "container", value: store.getContainer(container.id) }, execution);
      }
    }

    let replay = null;
    let nextState = containerSuccessState(action);
    if (["create", "start", "restart", "reset"].includes(action)) {
      try {
        const health = await waitForContainerReady(fresh, docker, config, (healthExecution) =>
          store.appendExecution(
            executionFromResult(
              healthExecution,
              actor,
              "container",
              container.id,
              "profile.health",
              owner.id,
              operationId,
            ),
          ),
        );
        nextState = { status: "running", health: health.status };
      } catch (error) {
        let updated;
        try {
          updated = await store.updateContainerLifecycle(
            container.id,
            {
              status: "error",
              health: error.latestHealth?.status || "error",
              operationId: null,
              lastAction: {
                action,
                executionId: execution.id,
                at: nowIso(),
                readiness: error.latestHealth || null,
              },
            },
            { expectedOperationId: operationId },
          );
        } catch (staleError) {
          return staleLifecycleResponse(
            staleError,
            { kind: "container", value: store.getContainer(container.id) },
            execution,
          );
        }
        return {
          container: updated,
          execution,
          readiness: { ok: false, latestHealth: error.latestHealth || null },
        };
      }
    }

    let updated;
    try {
      updated = await store.updateContainerLifecycle(
        container.id,
        {
          ...nextState,
          operationId: null,
          lastAction: { action, executionId: execution.id, at: nowIso() },
        },
        { expectedOperationId: operationId },
      );
    } catch (error) {
      return staleLifecycleResponse(error, { kind: "container", value: store.getContainer(container.id) }, execution);
    }

    if (action === "reset") {
      replay = await replayProfilesAfterReset({
        actor,
        container: updated,
        store,
        docker,
        config,
      });
    }

    return { container: updated, execution, ...(replay ? { replay } : {}) };
  } finally {
    locks.release(lockKey);
  }
}

async function runProfileAction({ action, actor, profile, container, store, docker, config, locks }) {
  rejectDeletedProfile(profile);
  rejectDeleteFailedProfile(profile, action === "delete");
  if (locks.has(`container:${container.id}`)) {
    throw lifecycleConflict("Parent container lifecycle action is already in progress.", {
      status: container.status,
      health: container.health,
    });
  }
  if (!["running"].includes(container.status) || container.health !== "ready") {
    throw lifecycleConflict("Parent container must be running and ready.", {
      status: container.status,
      health: container.health,
    });
  }
  if (["start", "restart"].includes(action) && profile.enabled === false) {
    throw lifecycleConflict("Disabled profiles cannot be started.", {
      status: profile.status,
    });
  }

  const lockKey = `profile:${profile.id}`;
  if (locks.has(lockKey)) {
    const current = store.getProfile(profile.id) || profile;
    throw lifecycleConflict("Profile lifecycle action is already in progress.", {
      status: current.status,
    });
  }
  locks.acquire(lockKey);
  const operationId = newOperationId();
  const previousStatus = profile.status;
  try {
    const fresh = store.getProfile(profile.id);
    if (fresh && IN_PROGRESS_PROFILE_STATES.has(fresh.status) && fresh.operationId) {
      throw lifecycleConflict("Profile lifecycle action is already in progress.", {
        status: fresh.status,
      });
    }
    await store.updateProfile(profile.id, { status: profileInProgressStatus(action), operationId });
    const resources = store
      .listResources()
      .filter((resource) => (profile.resourceIds || []).includes(resource.id));
    const profileConfig = action === "create" ? buildProfileConfig(profile, container, resources) : null;
    const plan = buildProfilePlan(action, profile, container, profileConfig, config);
    const result = await docker.execute(plan);
    const execution = await store.appendExecution(
      executionFromResult(result, actor, "profile", profile.id, `profile.${action}`, profile.ownerId, operationId),
    );

    if (!result.ok) {
      const failedStatus = action === "delete" ? "delete_failed" : "error";
      try {
        const updated = await store.updateProfile(
          profile.id,
          { status: failedStatus, operationId: null },
          { expectedOperationId: operationId },
        );
        return { profile: updated, execution };
      } catch (error) {
        return staleLifecycleResponse(error, { kind: "profile", value: store.getProfile(profile.id) }, execution);
      }
    }

    const nextStatus = profileSuccessState(action, previousStatus);
    let updated;
    try {
      updated =
        nextStatus === "deleted"
          ? await store.updateProfile(
              profile.id,
              { status: "deleted", operationId: null },
              { expectedOperationId: operationId },
            )
          : await store.updateProfile(
              profile.id,
              { status: nextStatus, operationId: null },
              { expectedOperationId: operationId },
            );
    } catch (error) {
      return staleLifecycleResponse(error, { kind: "profile", value: store.getProfile(profile.id) }, execution);
    }
    return { profile: updated, execution };
  } finally {
    locks.release(lockKey);
  }
}

async function handleApi(req, res, context) {
  const { store, docker, config, locks, loginThrottler } = context;
  const url = new URL(req.url, "http://localhost");
  const pathname = url.pathname;

  if (req.method === "POST" && pathname === "/api/login") {
    const body = await readJson(req);
    if (loginThrottler.isLocked(body.username)) {
      throw Object.assign(new Error("Invalid username or password."), { status: 429 });
    }
    const user = store.findUserByUsername(body.username);
    if (!user || !verifyPassword(body.password || "", user.passwordHash)) {
      loginThrottler.recordFailure(body.username);
      throw Object.assign(new Error("Invalid username or password."), { status: 401 });
    }
    loginThrottler.recordSuccess(body.username);
    const session = await store.createSession(user.id);
    sendJson(
      res,
      200,
      { user: publicUser(user), csrfToken: session.csrfToken, expiresAt: session.expiresAt },
      {
        "set-cookie": `cz_agent_session=${session.token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${
          config.sessionTtlHours * 60 * 60
        }`,
      },
    );
    return;
  }

  const sessionContext = await requireSessionContext(req, store);
  const { actor, session, token } = sessionContext;
  if (isMutating(req.method)) {
    validateOrigin(req, config);
    validateCsrf(req, session);
  }
  enforcePasswordChange(actor, pathname, req.method);

  if (req.method === "POST" && pathname === "/api/logout") {
    await store.deleteSession(token);
    sendJson(res, 200, { ok: true }, { "set-cookie": "cz_agent_session=; Path=/; Max-Age=0" });
    return;
  }

  if (req.method === "GET" && pathname === "/api/me") {
    sendJson(res, 200, { user: publicUser(actor), csrfToken: session.csrfToken });
    return;
  }

  if (req.method === "GET" && pathname === "/api/system") {
    requireAdmin(actor);
    sendJson(res, 200, {
      dockerMode: config.dockerMode,
      privateModel: {
        baseUrl: config.llmBaseUrl,
        model: config.llmModel,
        apiKey: "<redacted>",
      },
      publicAccess: config.publicAccessTarget,
    });
    return;
  }

  if (req.method === "POST" && pathname === "/api/me/password") {
    const body = await readJson(req);
    const freshActor = store.getUser(actor.id);
    if (!verifyPassword(body.currentPassword || "", freshActor.passwordHash)) {
      throw Object.assign(new Error("Current password is incorrect."), { status: 400 });
    }
    const user = await store.changePassword(actor.id, token, body.newPassword);
    sendJson(res, 200, { user, csrfToken: session.csrfToken });
    return;
  }

  if (pathname === "/api/users") {
    requireAdmin(actor);
    if (req.method === "GET") {
      sendJson(res, 200, { users: store.listUsers() });
      return;
    }
    if (req.method === "POST") {
      const body = await readJson(req);
      const user = await store.createUser(body);
      sendJson(res, 201, { user, container: store.getContainerByOwner(user.id) });
      return;
    }
  }

  const userParams = routePattern("/api/users/:id", pathname);
  if (userParams) {
    requireAdmin(actor);
    if (req.method === "PUT") {
      const body = await readJson(req);
      const user = await store.updateUser(userParams.id, body);
      sendJson(res, 200, { user });
      return;
    }
    if (req.method === "DELETE") {
      if (userParams.id === actor.id) {
        throw Object.assign(new Error("Admin users cannot delete themselves."), { status: 400 });
      }
      sendJson(res, 200, { deleted: await store.deleteUser(userParams.id) });
      return;
    }
  }

  if (pathname === "/api/containers" && req.method === "GET") {
    const reconciled = await reconcileContainersForActor(actor, store, docker);
    sendJson(res, 200, {
      containers: reconciled.containers,
      ...(reconciled.warnings.length ? { warnings: reconciled.warnings } : {}),
    });
    return;
  }

  if (pathname === "/api/executions" && req.method === "GET") {
    const executions = store
      .listExecutions()
      .filter((execution) => isAdmin(actor) || execution.ownerId === actor.id)
      .slice(-200)
      .reverse();
    sendJson(res, 200, { executions });
    return;
  }

  const containerActionParams = routePattern("/api/containers/:id/actions", pathname);
  if (containerActionParams && req.method === "POST") {
    const container = store.getContainer(containerActionParams.id);
    if (!container) {
      notFound();
    }
    if (!canManageContainer(actor, container)) {
      throw Object.assign(new Error("You can only manage your own container."), { status: 403 });
    }
    const owner = store.getUser(container.ownerId);
    const body = await readJson(req);
    const result = await runContainerAction({
      action: body.action,
      actor,
      container,
      owner,
      store,
      docker,
      config,
      locks,
    });
    sendJson(res, result.stale ? 409 : result.readiness?.ok === false ? 500 : result.execution.exitCode === 0 ? 200 : 500, result);
    return;
  }

  const containerProfilesParams = routePattern("/api/containers/:id/profiles", pathname);
  if (containerProfilesParams) {
    const container = store.getContainer(containerProfilesParams.id);
    if (!container) {
      notFound();
    }
    if (!canManageContainer(actor, container)) {
      throw Object.assign(new Error("You can only access your own container."), { status: 403 });
    }
    if (req.method === "GET") {
      sendJson(res, 200, {
        profiles: filterProfilesForActor(actor, store.listProfilesForContainer(container.id)),
      });
      return;
    }
    if (req.method === "POST") {
      const body = await readJson(req);
      if (hasForbiddenModelField(body)) {
        throw Object.assign(new Error("Profile requests must not include model provider fields."), { status: 400 });
      }
      if (container.status !== "running" || container.health !== "ready") {
        throw Object.assign(new Error("Container must be running and ready before creating profiles."), {
          status: 409,
        });
      }
      validateSlug(body.slug);
      const bindings = validateBindings(body.bindings);
      const resourceIds = validateVisibleResourceIds(actor, store, body.resourceIds);
      const profile = await store.createProfile({
        containerId: container.id,
        slug: body.slug,
        displayName: body.displayName || body.slug,
        description: body.description || "",
        bindings,
        resourceIds,
        status: "applying",
      });
      const result = await runProfileAction({
        action: "create",
        actor,
        profile,
        container,
        store,
        docker,
        config,
        locks,
      });
      sendJson(res, result.stale ? 409 : result.execution.exitCode === 0 ? 201 : 500, result);
      return;
    }
  }

  const profileParams = routePattern("/api/profiles/:id", pathname);
  if (profileParams) {
    const profile = store.getProfile(profileParams.id);
    if (!profile) {
      notFound();
    }
    if (!canManageProfile(actor, profile)) {
      throw Object.assign(new Error("You can only manage your own profile."), { status: 403 });
    }
    rejectDeletedProfile(profile);
    rejectDeleteFailedProfile(profile, req.method === "DELETE");
    const container = store.getContainer(profile.containerId);
    if (req.method === "PUT") {
      const body = await readJson(req);
      if (hasForbiddenModelField(body)) {
        throw Object.assign(new Error("Profile requests must not include model provider fields."), { status: 400 });
      }
      const previousStatus = profile.status;
      const update = {};
      for (const field of ["displayName", "description", "enabled"]) {
        if (body[field] !== undefined) {
          update[field] = body[field];
        }
      }
      if (body.bindings !== undefined) {
        update.bindings = validateBindings(body.bindings);
      }
      if (body.resourceIds !== undefined) {
        update.resourceIds = validateVisibleResourceIds(actor, store, body.resourceIds);
      }
      if (body.enabled === false && profile.status === "running") {
        const stopResult = await runProfileAction({ action: "stop", actor, profile, container, store, docker, config, locks });
        if (stopResult.stale) {
          sendJson(res, 409, stopResult);
          return;
        }
        if (stopResult.execution.exitCode !== 0) {
          sendJson(res, 500, stopResult);
          return;
        }
        update.status = "stopped";
      }
      const updatedProfile = await store.updateProfile(profile.id, update);
      if (container.status !== "running" || container.health !== "ready") {
        sendJson(res, 200, { profile: updatedProfile });
        return;
      }

      const operationId = newOperationId();
      await store.updateProfile(profile.id, { status: "applying", operationId });
      const resources = store
        .listResources()
        .filter((resource) => (updatedProfile.resourceIds || []).includes(resource.id));
      const profileConfig = buildProfileConfig(updatedProfile, container, resources);
      const plan = buildProfilePlan("create", updatedProfile, container, profileConfig, config);
      const result = await docker.execute(plan);
      const execution = await store.appendExecution(
        executionFromResult(result, actor, "profile", profile.id, "profile.update", profile.ownerId, operationId),
      );

      if (!result.ok) {
        let failed;
        try {
          failed = await store.updateProfile(
            profile.id,
            { status: "error", operationId: null },
            { expectedOperationId: operationId },
          );
        } catch (error) {
          const stale = staleLifecycleResponse(error, { kind: "profile", value: store.getProfile(profile.id) }, execution);
          sendJson(res, 409, stale);
          return;
        }
        sendJson(res, 500, { profile: failed, execution });
        return;
      }

      const shouldRestoreRunning = previousStatus === "running" && updatedProfile.enabled !== false;
      let finalProfile;
      try {
        finalProfile = await store.updateProfile(
          profile.id,
          {
            status: "stopped",
            operationId: shouldRestoreRunning ? operationId : null,
          },
          { expectedOperationId: operationId },
        );
      } catch (error) {
        const stale = staleLifecycleResponse(error, { kind: "profile", value: store.getProfile(profile.id) }, execution);
        sendJson(res, 409, stale);
        return;
      }
      let startExecution = null;
      if (shouldRestoreRunning) {
        const startPlan = buildProfilePlan("start", updatedProfile, container, null, config);
        const startResult = await docker.execute(startPlan);
        startExecution = await store.appendExecution(
          executionFromResult(
            startResult,
            actor,
            "profile",
            profile.id,
            "profile.update.start",
            profile.ownerId,
            operationId,
          ),
        );
        try {
          finalProfile = await store.updateProfile(
            profile.id,
            {
              status: startResult.ok ? "running" : "error",
              operationId: null,
            },
            { expectedOperationId: operationId },
          );
        } catch (error) {
          const stale = staleLifecycleResponse(error, { kind: "profile", value: store.getProfile(profile.id) }, startExecution);
          stale.execution = execution;
          stale.startExecution = startExecution;
          sendJson(res, 409, stale);
          return;
        }
      }

      sendJson(res, startExecution && startExecution.exitCode !== 0 ? 500 : 200, {
        profile: finalProfile,
        execution,
        ...(startExecution ? { startExecution } : {}),
      });
      return;
    }
    if (req.method === "DELETE") {
      const result = await runProfileAction({
        action: "delete",
        actor,
        profile,
        container,
        store,
        docker,
        config,
        locks,
      });
      sendJson(res, result.stale ? 409 : result.execution.exitCode === 0 ? 200 : 500, result);
      return;
    }
  }

  const profileActionParams = routePattern("/api/profiles/:id/actions", pathname);
  if (profileActionParams && req.method === "POST") {
    const profile = store.getProfile(profileActionParams.id);
    if (!profile) {
      notFound();
    }
    if (!canManageProfile(actor, profile)) {
      throw Object.assign(new Error("You can only manage your own profile."), { status: 403 });
    }
    rejectDeletedProfile(profile);
    rejectDeleteFailedProfile(profile);
    const container = store.getContainer(profile.containerId);
    const body = await readJson(req);
    const action = body.action;
    if (!["create", "start", "stop", "restart"].includes(action)) {
      throw Object.assign(new Error("Unsupported profile action."), { status: 400 });
    }
    const result = await runProfileAction({ action, actor, profile, container, store, docker, config, locks });
    sendJson(res, result.stale ? 409 : result.execution.exitCode === 0 ? 200 : 500, result);
    return;
  }

  if (pathname === "/api/resources") {
    if (req.method === "GET") {
      sendJson(res, 200, { resources: filterResourcesForActor(actor, store.listResources()) });
      return;
    }
    if (req.method === "POST") {
      const body = await readJson(req);
      const ownerId = isAdmin(actor) && body.ownerId ? body.ownerId : actor.id;
      if (!store.getUser(ownerId)) {
        throw Object.assign(new Error("Resource owner must be an existing user."), { status: 400 });
      }
      const resource = await store.createResource(
        {
          ...body,
          ownerId,
        },
        actor.id,
      );
      sendJson(res, 201, { resource });
      return;
    }
  }

  const resourceParams = routePattern("/api/resources/:id", pathname);
  if (resourceParams) {
    const resource = store.getResource(resourceParams.id);
    if (!resource) {
      notFound();
    }
    if (!canManageResource(actor, resource)) {
      throw Object.assign(new Error("You can only edit your own resources."), { status: 403 });
    }
    if (req.method === "PUT") {
      const body = await readJson(req);
      sendJson(res, 200, { resource: await store.updateResource(resource.id, body) });
      return;
    }
    if (req.method === "DELETE") {
      sendJson(res, 200, { deleted: await store.deleteResource(resource.id) });
      return;
    }
  }

  notFound();
}

function createServer(options = {}) {
  const config = getConfig(options.config || {});
  const store = options.store || new JsonStore(config.dataFile, config);
  const docker = options.docker || new DockerManager(config);
  const context = {
    config,
    docker,
    store,
    locks: options.locks || new OperationLocks(),
    loginThrottler: options.loginThrottler || new LoginThrottler(options.loginThrottlerOptions),
  };

  return http.createServer((req, res) => {
    if (!req.url.startsWith("/api/")) {
      serveStatic(req, res, config);
      return;
    }

    handleApi(req, res, context).catch((error) => {
      sendJson(res, error.status || 500, {
        error: error.status ? error.message : "Internal server error.",
        ...(error.details ? { details: error.details } : {}),
      });
    });
  });
}

if (require.main === module) {
  const config = getConfig();
  const server = createServer({ config });
  server.listen(config.port, config.host, () => {
    console.log(`Agent platform listening on http://${config.host}:${config.port}`);
    console.log(`Docker manager mode: ${config.dockerMode}`);
  });
}

module.exports = {
  LoginThrottler,
  OperationLocks,
  createServer,
};
