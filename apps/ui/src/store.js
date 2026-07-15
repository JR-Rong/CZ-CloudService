const fs = require("node:fs");
const path = require("node:path");

const { createSessionToken, hashPassword } = require("./auth");

function nowIso() {
  return new Date().toISOString();
}

function newId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizeUsernameSlug(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

function publicUser(user) {
  if (!user) {
    return null;
  }
  const { passwordHash, ...safe } = user;
  return clone(safe);
}

function ensureArray(value) {
  return Array.isArray(value) ? value : [];
}

function validateResourceType(type) {
  if (!["skill", "mcp"].includes(type)) {
    throw Object.assign(new Error("Resource type must be skill or mcp."), { status: 400 });
  }
  return type;
}

function validateResourceVisibility(visibility) {
  if (!["private", "company"].includes(visibility)) {
    throw Object.assign(new Error("Resource visibility must be private or company."), { status: 400 });
  }
  return visibility;
}

function normalizeRole(role, defaultRole = "employee") {
  if (role === undefined) {
    return defaultRole;
  }
  if (!["admin", "employee"].includes(role)) {
    throw Object.assign(new Error("User role must be admin or employee."), { status: 400 });
  }
  return role;
}

function trimExecutions(executions, perOwnerRetain = 200, globalRetain = 2000) {
  if (executions.length <= globalRetain) {
    return executions;
  }

  const protectedIndexes = new Set();
  const ownerCounts = new Map();
  for (let index = executions.length - 1; index >= 0; index -= 1) {
    const ownerKey = executions[index].ownerId || "<unowned>";
    const count = ownerCounts.get(ownerKey) || 0;
    if (count < perOwnerRetain) {
      protectedIndexes.add(index);
      ownerCounts.set(ownerKey, count + 1);
    }
  }

  const keep = [];
  let extraSlots = Math.max(0, globalRetain - protectedIndexes.size);
  for (let index = executions.length - 1; index >= 0; index -= 1) {
    if (protectedIndexes.has(index)) {
      keep.push(executions[index]);
    } else if (extraSlots > 0) {
      keep.push(executions[index]);
      extraSlots -= 1;
    }
  }
  return keep.reverse();
}

const IN_PROGRESS_CONTAINER_STATES = new Set(["creating", "starting", "stopping", "resetting", "deleting"]);
const IN_PROGRESS_PROFILE_STATES = new Set(["applying", "starting", "stopping", "deleting"]);

class JsonStore {
  constructor(filePath, config) {
    this.filePath = filePath;
    this.config = config;
    this.writeQueue = Promise.resolve();
    this.state = this.migrateState(this.load());
    this.recoverInProgressTargets();
    this.ensureBootstrapAdmin();
  }

  load() {
    if (!fs.existsSync(this.filePath)) {
      return {
        version: 1,
        users: [],
        containers: [],
        profiles: [],
        resources: [],
        sessions: [],
        executions: [],
        audit: [],
      };
    }
    return JSON.parse(fs.readFileSync(this.filePath, "utf8"));
  }

  migrateState(raw) {
    const state = {
      version: 1,
      users: ensureArray(raw.users),
      containers: ensureArray(raw.containers),
      profiles: ensureArray(raw.profiles),
      resources: ensureArray(raw.resources),
      sessions: ensureArray(raw.sessions),
      executions: ensureArray(raw.executions),
      audit: ensureArray(raw.audit),
    };

    if (state.containers.length === 0 && Array.isArray(raw.instances)) {
      state.containers = raw.instances.map((instance) => {
        const owner = state.users.find((user) => user.id === instance.ownerId);
        const usernameSlug = owner?.usernameSlug || normalizeUsernameSlug(owner?.username || instance.ownerId);
        return {
          id: instance.id.replace(/^ins_/, "ctr_"),
          ownerId: instance.ownerId,
          name: instance.name || "Hermes Container",
          containerName: `hermes-${usernameSlug}`,
          image: instance.image || this.config.hermesImage,
          status: instance.status === "created" ? "defined" : instance.status || "defined",
          health: "unknown",
          llm: {
            baseUrl: instance.llmBaseUrl || this.config.llmBaseUrl,
            model: instance.llmModel || this.config.llmModel,
            privateOnly: true,
          },
          lastAction: instance.lastAction || null,
          operationId: null,
          createdAt: instance.createdAt || nowIso(),
          updatedAt: instance.updatedAt || nowIso(),
        };
      });
    }

    for (const user of state.users) {
      if (!user.usernameSlug) {
        user.usernameSlug = normalizeUsernameSlug(user.username);
      }
      if (user.mustChangePassword === undefined) {
        user.mustChangePassword = false;
      }
    }

    return state;
  }

  saveSync() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.tmp`;
    fs.writeFileSync(tempPath, `${JSON.stringify(this.state, null, 2)}\n`);
    fs.renameSync(tempPath, this.filePath);
  }

  async mutate(mutator, options = {}) {
    const run = this.writeQueue.then(async () => {
      this.cleanupSessionsInMemory();
      const result = await mutator(this.state);
      if (options.save !== false) {
        this.cleanupSessionsInMemory();
        this.saveSync();
      }
      return clone(result);
    });
    this.writeQueue = run.catch(() => {});
    return run;
  }

  recoverInProgressTargets() {
    let changed = false;
    const recoveredAt = nowIso();
    for (const container of this.state.containers) {
      if (IN_PROGRESS_CONTAINER_STATES.has(container.status)) {
        container.status = "error";
        container.operationId = null;
        container.recoveryNote = `Recovered stale in-progress state at ${recoveredAt}`;
        changed = true;
      }
    }
    for (const profile of this.state.profiles) {
      if (IN_PROGRESS_PROFILE_STATES.has(profile.status)) {
        profile.status = "error";
        profile.operationId = null;
        profile.recoveryNote = `Recovered stale in-progress state at ${recoveredAt}`;
        changed = true;
      }
    }
    if (changed) {
      this.saveSync();
    }
  }

  ensureBootstrapAdmin() {
    const username = this.config.bootstrapAdminUsername;
    if (this.state.users.some((user) => user.username === username)) {
      return;
    }

    this.validatePasswordForRole(this.config.bootstrapAdminPassword, "admin");
    this.state.users.push({
      id: "usr_admin",
      username,
      usernameSlug: normalizeUsernameSlug(username),
      displayName: "Administrator",
      role: "admin",
      mustChangePassword: true,
      passwordHash: hashPassword(this.config.bootstrapAdminPassword),
      createdAt: nowIso(),
      updatedAt: nowIso(),
    });
    this.saveSync();
  }

  cleanupSessionsInMemory() {
    const now = Date.now();
    this.state.sessions = this.state.sessions.filter((session) => Date.parse(session.expiresAt) > now);
  }

  findUserByUsername(username) {
    const normalized = String(username || "").toLowerCase();
    return this.state.users.find((user) => user.username.toLowerCase() === normalized);
  }

  getUser(id) {
    return this.state.users.find((user) => user.id === id) || null;
  }

  listUsers() {
    return this.state.users.map(publicUser);
  }

  countAdmins(excludingUserId = "") {
    return this.state.users.filter((user) => user.role === "admin" && user.id !== excludingUserId).length;
  }

  validatePasswordForRole(password, role) {
    const minimum = role === "admin" ? 12 : 10;
    if (typeof password !== "string" || password.length < minimum) {
      throw Object.assign(new Error(`${role} password must be at least ${minimum} characters.`), { status: 400 });
    }
  }

  async createUser(input) {
    return this.mutate((state) => {
      const username = String(input.username || "").trim();
      const usernameSlug = normalizeUsernameSlug(username);
      if (!usernameSlug) {
        throw Object.assign(new Error("username must include at least one ASCII letter or digit"), { status: 400 });
      }
      if (state.users.some((user) => user.username.toLowerCase() === username.toLowerCase())) {
        throw Object.assign(new Error("Username already exists."), { status: 409 });
      }
      if (state.users.some((user) => user.usernameSlug === usernameSlug)) {
        throw Object.assign(new Error("username slug already exists"), { status: 409 });
      }

      const role = normalizeRole(input.role);
      this.validatePasswordForRole(input.password, role);
      const createdAt = nowIso();
      const user = {
        id: newId("usr"),
        username,
        usernameSlug,
        displayName: input.displayName || username,
        role,
        mustChangePassword: true,
        passwordHash: hashPassword(input.password),
        createdAt,
        updatedAt: createdAt,
      };
      state.users.push(user);

      if (role === "employee") {
        state.containers.push(this.buildContainerForUser(user, createdAt));
      }

      return publicUser(user);
    });
  }

  buildContainerForUser(user, createdAt = nowIso()) {
    return {
      id: newId("ctr"),
      ownerId: user.id,
      name: `${user.displayName || user.username} Hermes Container`,
      containerName: `hermes-${user.usernameSlug}`,
      image: this.config.hermesImage,
      status: "defined",
      health: "unknown",
      llm: {
        baseUrl: this.config.llmBaseUrl,
        model: this.config.llmModel,
        privateOnly: true,
      },
      lastAction: null,
      operationId: null,
      createdAt,
      updatedAt: createdAt,
    };
  }

  async updateUser(id, input) {
    return this.mutate((state) => {
      const user = state.users.find((item) => item.id === id);
      if (!user) {
        throw Object.assign(new Error("User not found."), { status: 404 });
      }
      if (input.username !== undefined || input.usernameSlug !== undefined) {
        throw Object.assign(new Error("Username and username slug are immutable."), { status: 400 });
      }
      const nextRole = normalizeRole(input.role, user.role);
      if (input.role !== undefined) {
        if (user.role === "admin" && nextRole !== "admin" && this.countAdmins(user.id) === 0) {
          throw Object.assign(new Error("Cannot downgrade the final admin."), { status: 400 });
        }
      }
      if (input.displayName !== undefined) {
        user.displayName = input.displayName || user.username;
      }
      user.role = nextRole;
      if (
        user.role === "employee" &&
        !state.containers.some((container) => container.ownerId === user.id && container.status !== "deleted")
      ) {
        state.containers.push(this.buildContainerForUser(user));
      }
      if (input.password !== undefined) {
        this.validatePasswordForRole(input.password, user.role);
        user.passwordHash = hashPassword(input.password);
        user.mustChangePassword = true;
        state.sessions = state.sessions.filter((session) => session.userId !== user.id);
      }
      user.updatedAt = nowIso();
      return publicUser(user);
    });
  }

  async changePassword(userId, currentSessionToken, newPassword) {
    return this.mutate((state) => {
      const user = state.users.find((item) => item.id === userId);
      if (!user) {
        throw Object.assign(new Error("User not found."), { status: 404 });
      }
      this.validatePasswordForRole(newPassword, user.role);
      user.passwordHash = hashPassword(newPassword);
      user.mustChangePassword = false;
      user.updatedAt = nowIso();
      state.sessions = state.sessions.filter(
        (session) => session.userId !== userId || session.token === currentSessionToken,
      );
      return publicUser(user);
    });
  }

  async deleteUser(id) {
    return this.mutate((state) => {
      const user = state.users.find((item) => item.id === id);
      if (!user) {
        return false;
      }
      if (user.role === "admin" && this.countAdmins(user.id) === 0) {
        throw Object.assign(new Error("Cannot delete the final admin."), { status: 400 });
      }
      const runningContainer = state.containers.find(
        (container) => container.ownerId === id && ["running", ...IN_PROGRESS_CONTAINER_STATES].includes(container.status),
      );
      if (runningContainer) {
        throw Object.assign(new Error("Cannot delete a user with a running or in-progress container."), { status: 409 });
      }
      const removedResourceIds = new Set(
        state.resources.filter((resource) => resource.ownerId === id).map((resource) => resource.id),
      );
      state.users = state.users.filter((item) => item.id !== id);
      state.containers = state.containers.filter((container) => container.ownerId !== id);
      state.profiles = state.profiles.filter((profile) => profile.ownerId !== id);
      state.resources = state.resources.filter((resource) => resource.ownerId !== id);
      if (removedResourceIds.size > 0) {
        for (const profile of state.profiles) {
          const nextResourceIds = ensureArray(profile.resourceIds).filter(
            (resourceId) => !removedResourceIds.has(resourceId),
          );
          if (nextResourceIds.length !== ensureArray(profile.resourceIds).length) {
            profile.resourceIds = nextResourceIds;
            profile.updatedAt = nowIso();
          }
        }
      }
      state.sessions = state.sessions.filter((session) => session.userId !== id);
      return true;
    });
  }

  async createSession(userId) {
    return this.mutate((state) => {
      const token = createSessionToken();
      const csrfToken = createSessionToken();
      const expiresAt = new Date(Date.now() + this.config.sessionTtlHours * 60 * 60 * 1000).toISOString();
      const session = { token, userId, csrfToken, expiresAt, createdAt: nowIso() };
      state.sessions.push(session);
      return session;
    });
  }

  async getSession(token) {
    await this.writeQueue;
    this.cleanupSessionsInMemory();
    const session = this.state.sessions.find((item) => item.token === token);
    return session ? clone(session) : null;
  }

  async deleteSession(token) {
    return this.mutate((state) => {
      const before = state.sessions.length;
      state.sessions = state.sessions.filter((session) => session.token !== token);
      return state.sessions.length !== before;
    });
  }

  listContainers() {
    return clone(this.state.containers);
  }

  getContainer(id) {
    return this.state.containers.find((container) => container.id === id) || null;
  }

  getContainerByOwner(ownerId) {
    return this.state.containers.find((container) => container.ownerId === ownerId && container.status !== "deleted") || null;
  }

  async updateContainerLifecycle(id, fields, options = {}) {
    return this.mutate((state) => {
      const container = state.containers.find((item) => item.id === id);
      if (!container) {
        throw Object.assign(new Error("Container not found."), { status: 404 });
      }
      if (
        options.expectedOperationId !== undefined &&
        container.operationId !== options.expectedOperationId
      ) {
        throw Object.assign(new Error("Stale container lifecycle result ignored."), {
          status: 409,
          stale: true,
          currentOperationId: container.operationId || null,
        });
      }
      Object.assign(container, fields, { updatedAt: nowIso() });
      return container;
    });
  }

  listProfiles() {
    return clone(this.state.profiles);
  }

  listProfilesForContainer(containerId, includeDeleted = false) {
    return clone(
      this.state.profiles.filter(
        (profile) => profile.containerId === containerId && (includeDeleted || profile.status !== "deleted"),
      ),
    );
  }

  getProfile(id) {
    return this.state.profiles.find((profile) => profile.id === id) || null;
  }

  async createProfile(input) {
    return this.mutate((state) => {
      const container = state.containers.find((item) => item.id === input.containerId);
      if (!container) {
        throw Object.assign(new Error("Container not found."), { status: 404 });
      }
      if (
        state.profiles.some(
          (profile) =>
            profile.containerId === input.containerId &&
            profile.status !== "deleted" &&
            profile.slug === input.slug,
        )
      ) {
        throw Object.assign(new Error("Profile slug already exists in this container."), { status: 409 });
      }
      const createdAt = nowIso();
      const profile = {
        id: newId("pro"),
        containerId: input.containerId,
        ownerId: container.ownerId,
        slug: input.slug,
        displayName: input.displayName,
        description: input.description || "",
        enabled: input.enabled !== false,
        status: input.status || "defined",
        bindings: ensureArray(input.bindings),
        resourceIds: ensureArray(input.resourceIds),
        operationId: input.operationId || null,
        createdAt,
        updatedAt: createdAt,
      };
      state.profiles.push(profile);
      return profile;
    });
  }

  async updateProfile(id, input, options = {}) {
    return this.mutate((state) => {
      const profile = state.profiles.find((item) => item.id === id);
      if (!profile) {
        throw Object.assign(new Error("Profile not found."), { status: 404 });
      }
      if (
        options.expectedOperationId !== undefined &&
        profile.operationId !== options.expectedOperationId
      ) {
        throw Object.assign(new Error("Stale profile lifecycle result ignored."), {
          status: 409,
          stale: true,
          currentOperationId: profile.operationId || null,
        });
      }
      for (const field of ["displayName", "description", "enabled", "bindings", "resourceIds", "status", "operationId"]) {
        if (input[field] !== undefined) {
          profile[field] = input[field];
        }
      }
      profile.updatedAt = nowIso();
      return profile;
    });
  }

  async softDeleteProfile(id) {
    return this.updateProfile(id, { status: "deleted", operationId: null });
  }

  listResources() {
    return clone(this.state.resources);
  }

  getResource(id) {
    return this.state.resources.find((resource) => resource.id === id) || null;
  }

  async createResource(input, ownerId) {
    return this.mutate((state) => {
      if (!input.name) {
        throw Object.assign(new Error("Resource name is required."), { status: 400 });
      }
      const createdAt = nowIso();
      const resource = {
        id: newId("res"),
        ownerId: input.ownerId || ownerId,
        type: validateResourceType(input.type || "skill"),
        name: String(input.name),
        description: input.description || "",
        visibility: validateResourceVisibility(input.visibility || "private"),
        packageRef: input.packageRef || "",
        version: input.version || "",
        createdAt,
        updatedAt: createdAt,
      };
      state.resources.push(resource);
      return resource;
    });
  }

  async updateResource(id, input) {
    return this.mutate((state) => {
      const resource = state.resources.find((item) => item.id === id);
      if (!resource) {
        throw Object.assign(new Error("Resource not found."), { status: 404 });
      }
      const nextResource = { ...resource };
      for (const field of ["type", "name", "description", "visibility", "packageRef", "version"]) {
        if (input[field] !== undefined) {
          nextResource[field] = input[field];
        }
      }
      nextResource.type = validateResourceType(nextResource.type);
      nextResource.visibility = validateResourceVisibility(nextResource.visibility);
      Object.assign(resource, nextResource);
      resource.updatedAt = nowIso();
      if (resource.visibility === "private") {
        for (const profile of state.profiles) {
          if (profile.ownerId === resource.ownerId) {
            continue;
          }
          const currentResourceIds = ensureArray(profile.resourceIds);
          const nextResourceIds = currentResourceIds.filter((resourceId) => resourceId !== resource.id);
          if (nextResourceIds.length !== currentResourceIds.length) {
            profile.resourceIds = nextResourceIds;
            profile.updatedAt = nowIso();
          }
        }
      }
      return resource;
    });
  }

  async deleteResource(id) {
    return this.mutate((state) => {
      const before = state.resources.length;
      state.resources = state.resources.filter((resource) => resource.id !== id);
      for (const profile of state.profiles) {
        profile.resourceIds = ensureArray(profile.resourceIds).filter((resourceId) => resourceId !== id);
      }
      return state.resources.length !== before;
    });
  }

  listExecutions() {
    return clone(this.state.executions);
  }

  async appendExecution(record) {
    return this.mutate((state) => {
      const execution = {
        id: record.id || newId("exec"),
        operationId: record.operationId || null,
        actorId: record.actorId,
        ownerId: record.ownerId || null,
        targetType: record.targetType,
        targetId: record.targetId,
        operation: record.operation,
        mode: record.mode,
        redactedCommand: record.redactedCommand || "",
        exitCode: record.exitCode ?? 0,
        stdout: record.stdout || "",
        stderr: record.stderr || "",
        stdinHash: record.stdinHash || null,
        startedAt: record.startedAt || nowIso(),
        finishedAt: record.finishedAt || nowIso(),
      };
      state.executions.push(execution);
      state.executions = trimExecutions(state.executions);
      return execution;
    });
  }
}

module.exports = {
  IN_PROGRESS_CONTAINER_STATES,
  IN_PROGRESS_PROFILE_STATES,
  JsonStore,
  normalizeUsernameSlug,
  publicUser,
};
