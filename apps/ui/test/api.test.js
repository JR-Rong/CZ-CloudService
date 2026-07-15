const assert = require("node:assert/strict");
const { once } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { LoginThrottler, createServer } = require("../src/server");
const { JsonStore } = require("../src/store");

const UUID_STYLE_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function request(baseUrl, method, route, body, options = {}) {
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(options.cookie ? { cookie: options.cookie } : {}),
      ...(options.csrfToken ? { "x-csrf-token": options.csrfToken } : {}),
      ...(options.origin ? { origin: options.origin } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: "manual",
  });
  const text = await response.text();
  const json = text ? JSON.parse(text) : null;
  return {
    status: response.status,
    json,
    cookie: response.headers.get("set-cookie"),
    headers: response.headers,
  };
}

async function withTestServer(fn, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-platform-"));
  const dataFile = path.join(dir, "state.json");
  const config = {
    dataFile,
    dockerMode: "dry-run",
    dockerBinary: "docker",
    runtimeDir: path.join(dir, "runtime"),
    hermesImage: "hermes:latest",
    llmBaseUrl: "http://192.168.100.12:8000/v1",
    llmModel: "qwen3.6-35b-a3b",
    llmApiKeyEnv: "AI_API_KEY",
    llmApiKey: "test-key",
    bootstrapAdminUsername: "admin",
    bootstrapAdminPassword: "admin-bootstrap-password",
    sessionTtlHours: 1,
    allowedHosts: ["127.0.0.1"],
    ...(options.config || {}),
  };
  const store = options.store || new JsonStore(dataFile, config);
  const app = createServer({
    config,
    store,
    docker: options.docker,
  });
  app.listen(0, "127.0.0.1");
  await once(app, "listening");
  const address = app.address();
  try {
    await fn(`http://127.0.0.1:${address.port}`, { store, dir, config });
  } finally {
    app.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

class RecordingDocker {
  constructor() {
    this.executed = [];
    this.inspectResult = { available: true, running: true };
    this.healthResult = { available: true, status: "ready", stdout: "{\"status\":\"ready\"}" };
    this.listResult = { available: true, profiles: [] };
  }

  async execute(plan) {
    this.executed.push(plan);
    return {
      ok: true,
      mode: "dry-run",
      dryRun: true,
      action: plan.action,
      containerName: plan.containerName,
      redactedCommand: plan.redactedCommand || plan.steps?.map((step) => step.redactedCommand).join(" && "),
      stdout: JSON.stringify({ ok: true, action: plan.action }),
      stderr: "",
      exitCode: 0,
      stdinHash: plan.stdinHash || null,
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
    };
  }

  async inspectContainer(container) {
    const result = typeof this.inspectResult === "function" ? this.inspectResult(container) : this.inspectResult;
    return {
      ...result,
      execution:
        result.execution ||
        {
          ok: result.available !== false,
          mode: "dry-run",
          dryRun: true,
          action: "inspect",
          containerName: container.containerName,
          redactedCommand: `docker inspect --format "{{.State.Running}}" ${container.containerName}`,
          stdout: result.running ? "true" : "false",
          stderr: result.warning || "",
          exitCode: result.available === false ? 1 : 0,
          stdinHash: null,
          startedAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(),
        },
    };
  }

  async checkProfileHealth(container) {
    const result = typeof this.healthResult === "function" ? this.healthResult(container) : this.healthResult;
    return {
      ...result,
      execution:
        result.execution ||
        {
          ok: result.available !== false,
          mode: "dry-run",
          dryRun: true,
          action: "health",
          containerName: container.containerName,
          redactedCommand: `docker exec ${container.containerName} hermes-profilectl health --json`,
          stdout: result.stdout || JSON.stringify({ status: result.status || "ready" }),
          stderr: result.warning || "",
          exitCode: result.available === false ? 1 : 0,
          stdinHash: null,
          startedAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(),
        },
    };
  }

  async listProfiles(container) {
    const result = typeof this.listResult === "function" ? this.listResult(container) : this.listResult;
    return {
      ...result,
      execution:
        result.execution ||
        {
          ok: result.available !== false,
          mode: "dry-run",
          dryRun: true,
          action: "list",
          containerName: container.containerName,
          redactedCommand: `docker exec ${container.containerName} hermes-profilectl list --json`,
          stdout: JSON.stringify({ profiles: result.profiles || [] }),
          stderr: result.warning || "",
          exitCode: result.available === false ? 1 : 0,
          stdinHash: null,
          startedAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(),
        },
    };
  }
}

async function loginAsChangedAdmin(baseUrl) {
  const login = await request(baseUrl, "POST", "/api/login", {
    username: "admin",
    password: "admin-bootstrap-password",
  });
  const adminCookie = login.cookie.split(";")[0];
  const changed = await request(
    baseUrl,
    "POST",
    "/api/me/password",
    {
      currentPassword: "admin-bootstrap-password",
      newPassword: "admin-new-password",
    },
    { cookie: adminCookie, csrfToken: login.json.csrfToken },
  );
  return { adminCookie, adminCsrf: changed.json.csrfToken };
}

test("auth, CSRF, user creation, and container ownership follow the MVP contract", async () => {
  await withTestServer(async (baseUrl) => {
    const login = await request(baseUrl, "POST", "/api/login", {
      username: "admin",
      password: "admin-bootstrap-password",
    });
    assert.equal(login.status, 200);
    const adminCookie = login.cookie.split(";")[0];
    assert.equal(login.json.user.mustChangePassword, true);
    assert.equal(typeof login.json.csrfToken, "string");

    const blockedBeforePasswordChange = await request(
      baseUrl,
      "POST",
      "/api/users",
      {
        username: "blocked",
        displayName: "Blocked",
        password: "employee-password",
        role: "employee",
      },
      { cookie: adminCookie, csrfToken: login.json.csrfToken },
    );
    assert.equal(blockedBeforePasswordChange.status, 403);

    const passwordChange = await request(
      baseUrl,
      "POST",
      "/api/me/password",
      {
        currentPassword: "admin-bootstrap-password",
        newPassword: "admin-new-password",
      },
      { cookie: adminCookie, csrfToken: login.json.csrfToken },
    );
    assert.equal(passwordChange.status, 200);
    const adminCsrf = passwordChange.json.csrfToken;

    const user = await request(
      baseUrl,
      "POST",
      "/api/users",
      {
        username: "alice",
        displayName: "Alice",
        password: "alice-password",
        role: "employee",
      },
      { cookie: adminCookie, csrfToken: adminCsrf },
    );
    assert.equal(user.status, 201);
    assert.equal(user.json.user.mustChangePassword, true);
    assert.equal(user.json.container.containerName, "hermes-alice");
    const createdContainer = await request(
      baseUrl,
      "POST",
      `/api/containers/${user.json.container.id}/actions`,
      { action: "create" },
      { cookie: adminCookie, csrfToken: adminCsrf },
    );
    assert.equal(createdContainer.status, 200);

    const missingCsrf = await request(
      baseUrl,
      "POST",
      "/api/users",
      {
        username: "mallory",
        displayName: "Mallory",
        password: "employee-password",
        role: "employee",
      },
      { cookie: adminCookie },
    );
    assert.equal(missingCsrf.status, 403);

    const employeeLogin = await request(baseUrl, "POST", "/api/login", {
      username: "alice",
      password: "alice-password",
    });
    const employeeCookie = employeeLogin.cookie.split(";")[0];
    const employeePasswordChange = await request(
      baseUrl,
      "POST",
      "/api/me/password",
      {
        currentPassword: "alice-password",
        newPassword: "alice-new-password",
      },
      { cookie: employeeCookie, csrfToken: employeeLogin.json.csrfToken },
    );
    assert.equal(employeePasswordChange.status, 200);
    const employeeCsrf = employeePasswordChange.json.csrfToken;

    const employeeUsers = await request(baseUrl, "GET", "/api/users", undefined, {
      cookie: employeeCookie,
    });
    assert.equal(employeeUsers.status, 403);

    const employeeContainers = await request(
      baseUrl,
      "GET",
      "/api/containers",
      undefined,
      { cookie: employeeCookie },
    );
    assert.equal(employeeContainers.status, 200);
    assert.deepEqual(
      employeeContainers.json.containers.map((item) => item.id),
      [user.json.container.id],
    );

    const stop = await request(
      baseUrl,
      "POST",
      `/api/containers/${user.json.container.id}/actions`,
      { action: "stop" },
      { cookie: employeeCookie, csrfToken: employeeCsrf },
    );
    assert.equal(stop.status, 200);
    assert.equal(stop.json.execution.mode, "dry-run");
    assert.equal(stop.json.container.status, "stopped");
  });
});

test("employee role changes preserve exactly one container and running users cannot be deleted", async () => {
  await withTestServer(async (baseUrl, { store }) => {
    const { adminCookie, adminCsrf } = await loginAsChangedAdmin(baseUrl);
    const manager = await request(
      baseUrl,
      "POST",
      "/api/users",
      {
        username: "manager",
        displayName: "Manager",
        password: "manager-admin-password",
        role: "admin",
      },
      { cookie: adminCookie, csrfToken: adminCsrf },
    );
    assert.equal(manager.status, 201);
    assert.equal(manager.json.container, null);

    const changedToEmployee = await request(
      baseUrl,
      "PUT",
      `/api/users/${manager.json.user.id}`,
      { role: "employee" },
      { cookie: adminCookie, csrfToken: adminCsrf },
    );
    assert.equal(changedToEmployee.status, 200);
    assert.equal(store.listContainers().filter((container) => container.ownerId === manager.json.user.id).length, 1);

    const changedAgain = await request(
      baseUrl,
      "PUT",
      `/api/users/${manager.json.user.id}`,
      { role: "employee" },
      { cookie: adminCookie, csrfToken: adminCsrf },
    );
    assert.equal(changedAgain.status, 200);
    assert.equal(store.listContainers().filter((container) => container.ownerId === manager.json.user.id).length, 1);

    const employee = await request(
      baseUrl,
      "POST",
      "/api/users",
      {
        username: "alice",
        displayName: "Alice",
        password: "alice-password",
        role: "employee",
      },
      { cookie: adminCookie, csrfToken: adminCsrf },
    );
    await request(
      baseUrl,
      "POST",
      `/api/containers/${employee.json.container.id}/actions`,
      { action: "create" },
      { cookie: adminCookie, csrfToken: adminCsrf },
    );

    const rejectedDelete = await request(baseUrl, "DELETE", `/api/users/${employee.json.user.id}`, undefined, {
      cookie: adminCookie,
      csrfToken: adminCsrf,
    });
    assert.equal(rejectedDelete.status, 409);
    assert.equal(store.getUser(employee.json.user.id).username, "alice");
    assert.equal(store.getContainer(employee.json.container.id).status, "running");
  });
});

test("users reject unsupported role values and immutable usernames", async () => {
  await withTestServer(async (baseUrl, { store }) => {
    const { adminCookie, adminCsrf } = await loginAsChangedAdmin(baseUrl);

    const rejectedCreate = await request(
      baseUrl,
      "POST",
      "/api/users",
      {
        username: "eve",
        displayName: "Eve",
        password: "eve-password",
        role: "manager",
      },
      { cookie: adminCookie, csrfToken: adminCsrf },
    );
    assert.equal(rejectedCreate.status, 400);
    assert.equal(store.findUserByUsername("eve"), undefined);

    const manager = await request(
      baseUrl,
      "POST",
      "/api/users",
      {
        username: "manager",
        displayName: "Manager",
        password: "manager-admin-password",
        role: "admin",
      },
      { cookie: adminCookie, csrfToken: adminCsrf },
    );
    assert.equal(manager.status, 201);

    const rejectedUpdate = await request(
      baseUrl,
      "PUT",
      `/api/users/${manager.json.user.id}`,
      { role: "manager" },
      { cookie: adminCookie, csrfToken: adminCsrf },
    );
    assert.equal(rejectedUpdate.status, 400);
    assert.equal(store.getUser(manager.json.user.id).role, "admin");

    const rejectedRename = await request(
      baseUrl,
      "PUT",
      `/api/users/${manager.json.user.id}`,
      { username: "renamed-manager" },
      { cookie: adminCookie, csrfToken: adminCsrf },
    );
    assert.equal(rejectedRename.status, 400);
    assert.equal(store.getUser(manager.json.user.id).username, "manager");
  });
});

test("profiles reject model fields, use private model config, and enforce resource visibility", async () => {
  await withTestServer(async (baseUrl) => {
    const login = await request(baseUrl, "POST", "/api/login", {
      username: "admin",
      password: "admin-bootstrap-password",
    });
    const adminCookie = login.cookie.split(";")[0];
    const changed = await request(
      baseUrl,
      "POST",
      "/api/me/password",
      {
        currentPassword: "admin-bootstrap-password",
        newPassword: "admin-new-password",
      },
      { cookie: adminCookie, csrfToken: login.json.csrfToken },
    );
    const adminCsrf = changed.json.csrfToken;
    const user = await request(
      baseUrl,
      "POST",
      "/api/users",
      {
        username: "alice",
        displayName: "Alice",
        password: "alice-password",
        role: "employee",
      },
      { cookie: adminCookie, csrfToken: adminCsrf },
    );
    const containerId = user.json.container.id;
    await request(
      baseUrl,
      "POST",
      `/api/containers/${containerId}/actions`,
      { action: "create" },
      { cookie: adminCookie, csrfToken: adminCsrf },
    );

    const resource = await request(
      baseUrl,
      "POST",
      "/api/resources",
      {
        type: "skill",
        name: "contract-review",
        visibility: "company",
        packageRef: "skills/contract-review",
      },
      { cookie: adminCookie, csrfToken: adminCsrf },
    );
    assert.equal(resource.status, 201);

    const rejected = await request(
      baseUrl,
      "POST",
      `/api/containers/${containerId}/profiles`,
      {
        slug: "sales-assistant",
        displayName: "Sales Assistant",
        model: { provider: "public" },
      },
      { cookie: adminCookie, csrfToken: adminCsrf },
    );
    assert.equal(rejected.status, 400);

    const malformedBinding = await request(
      baseUrl,
      "POST",
      `/api/containers/${containerId}/profiles`,
      {
        slug: "bad-binding",
        displayName: "Bad Binding",
        bindings: [null],
        resourceIds: [],
      },
      { cookie: adminCookie, csrfToken: adminCsrf },
    );
    assert.equal(malformedBinding.status, 400);

    const emptyCredentialRef = await request(
      baseUrl,
      "POST",
      `/api/containers/${containerId}/profiles`,
      {
        slug: "empty-secret-ref",
        displayName: "Empty Secret Ref",
        bindings: [
          {
            platform: "feishu",
            displayName: "Sales Bot",
            externalRef: "bot-sales",
            credentialRef: "",
          },
        ],
        resourceIds: [],
      },
      { cookie: adminCookie, csrfToken: adminCsrf },
    );
    assert.equal(emptyCredentialRef.status, 400);

    const profile = await request(
      baseUrl,
      "POST",
      `/api/containers/${containerId}/profiles`,
      {
        slug: "sales-assistant",
        displayName: "Sales Assistant",
        description: "Helps with sales replies.",
        bindings: [
          {
            platform: "feishu",
            displayName: "Sales Bot",
            externalRef: "bot-sales",
            credentialRef: "secret://feishu/sales-01",
            enabled: true,
          },
        ],
        resourceIds: [resource.json.resource.id],
      },
      { cookie: adminCookie, csrfToken: adminCsrf },
    );

    assert.equal(profile.status, 201);
    assert.equal(profile.json.profile.status, "stopped");
    assert.equal(profile.json.execution.redactedCommand.includes("docker exec -i hermes-alice"), true);
    assert.equal(profile.json.execution.stdout.includes("test-key"), false);
    assert.equal(profile.json.profile.llm, undefined);

    const disabled = await request(
      baseUrl,
      "PUT",
      `/api/profiles/${profile.json.profile.id}`,
      { enabled: false },
      { cookie: adminCookie, csrfToken: adminCsrf },
    );
    assert.equal(disabled.status, 200);

    const startDisabled = await request(
      baseUrl,
      "POST",
      `/api/profiles/${profile.json.profile.id}/actions`,
      { action: "start" },
      { cookie: adminCookie, csrfToken: adminCsrf },
    );
    assert.equal(startDisabled.status, 409);

    const restartDisabled = await request(
      baseUrl,
      "POST",
      `/api/profiles/${profile.json.profile.id}/actions`,
      { action: "restart" },
      { cookie: adminCookie, csrfToken: adminCsrf },
    );
    assert.equal(restartDisabled.status, 409);
    assert.equal(restartDisabled.json.details.reason, "Disabled profiles cannot be started.");
  });
});

test("employees can create profiles only in their own container", async () => {
  await withTestServer(async (baseUrl, { store }) => {
    const { adminCookie, adminCsrf } = await loginAsChangedAdmin(baseUrl);
    const alice = await request(
      baseUrl,
      "POST",
      "/api/users",
      {
        username: "alice",
        displayName: "Alice",
        password: "alice-password",
        role: "employee",
      },
      { cookie: adminCookie, csrfToken: adminCsrf },
    );
    const bob = await request(
      baseUrl,
      "POST",
      "/api/users",
      {
        username: "bob",
        displayName: "Bob",
        password: "bob-password",
        role: "employee",
      },
      { cookie: adminCookie, csrfToken: adminCsrf },
    );
    await request(
      baseUrl,
      "POST",
      `/api/containers/${alice.json.container.id}/actions`,
      { action: "create" },
      { cookie: adminCookie, csrfToken: adminCsrf },
    );
    await request(
      baseUrl,
      "POST",
      `/api/containers/${bob.json.container.id}/actions`,
      { action: "create" },
      { cookie: adminCookie, csrfToken: adminCsrf },
    );

    const aliceLogin = await request(baseUrl, "POST", "/api/login", {
      username: "alice",
      password: "alice-password",
    });
    const aliceCookie = aliceLogin.cookie.split(";")[0];
    const alicePassword = await request(
      baseUrl,
      "POST",
      "/api/me/password",
      {
        currentPassword: "alice-password",
        newPassword: "alice-new-password",
      },
      { cookie: aliceCookie, csrfToken: aliceLogin.json.csrfToken },
    );
    const aliceCsrf = alicePassword.json.csrfToken;

    const ownProfile = await request(
      baseUrl,
      "POST",
      `/api/containers/${alice.json.container.id}/profiles`,
      {
        slug: "alice-helper",
        displayName: "Alice Helper",
        bindings: [],
        resourceIds: [],
      },
      { cookie: aliceCookie, csrfToken: aliceCsrf },
    );
    const otherProfile = await request(
      baseUrl,
      "POST",
      `/api/containers/${bob.json.container.id}/profiles`,
      {
        slug: "bob-helper-from-alice",
        displayName: "Bob Helper From Alice",
        bindings: [],
        resourceIds: [],
      },
      { cookie: aliceCookie, csrfToken: aliceCsrf },
    );

    assert.equal(ownProfile.status, 201);
    assert.equal(ownProfile.json.profile.ownerId, alice.json.user.id);
    assert.equal(otherProfile.status, 403);
    assert.equal(
      store
        .listProfilesForContainer(bob.json.container.id)
        .some((profile) => profile.slug === "bob-helper-from-alice"),
      false,
    );
  });
});

test("resources reject unsupported type and visibility values", async () => {
  await withTestServer(async (baseUrl, { store }) => {
    const { adminCookie, adminCsrf } = await loginAsChangedAdmin(baseUrl);

    const invalidType = await request(
      baseUrl,
      "POST",
      "/api/resources",
      {
        type: "tool",
        name: "bad-resource",
        visibility: "company",
      },
      { cookie: adminCookie, csrfToken: adminCsrf },
    );
    assert.equal(invalidType.status, 400);
    assert.equal(store.listResources().some((resource) => resource.name === "bad-resource"), false);

    const invalidOwner = await request(
      baseUrl,
      "POST",
      "/api/resources",
      {
        type: "skill",
        name: "orphan-resource",
        visibility: "private",
        ownerId: "usr_missing",
      },
      { cookie: adminCookie, csrfToken: adminCsrf },
    );
    assert.equal(invalidOwner.status, 400);
    assert.equal(store.listResources().some((resource) => resource.name === "orphan-resource"), false);

    const resource = await request(
      baseUrl,
      "POST",
      "/api/resources",
      {
        type: "skill",
        name: "contract-review",
        visibility: "private",
      },
      { cookie: adminCookie, csrfToken: adminCsrf },
    );
    assert.equal(resource.status, 201);
    assert.equal(resource.json.resource.ownerId, store.findUserByUsername("admin").id);

    const invalidVisibility = await request(
      baseUrl,
      "PUT",
      `/api/resources/${resource.json.resource.id}`,
      { visibility: "public" },
      { cookie: adminCookie, csrfToken: adminCsrf },
    );
    assert.equal(invalidVisibility.status, 400);
    assert.equal(store.getResource(resource.json.resource.id).visibility, "private");
  });
});

test("deleting a user removes their shared resources from remaining profiles", async () => {
  await withTestServer(async (baseUrl, { store }) => {
    const { adminCookie, adminCsrf } = await loginAsChangedAdmin(baseUrl);
    const alice = await request(
      baseUrl,
      "POST",
      "/api/users",
      {
        username: "alice",
        displayName: "Alice",
        password: "alice-password",
        role: "employee",
      },
      { cookie: adminCookie, csrfToken: adminCsrf },
    );
    const bob = await request(
      baseUrl,
      "POST",
      "/api/users",
      {
        username: "bob",
        displayName: "Bob",
        password: "bob-password",
        role: "employee",
      },
      { cookie: adminCookie, csrfToken: adminCsrf },
    );
    const resource = await request(
      baseUrl,
      "POST",
      "/api/resources",
      {
        ownerId: bob.json.user.id,
        type: "skill",
        name: "shared-review",
        visibility: "company",
      },
      { cookie: adminCookie, csrfToken: adminCsrf },
    );
    await request(
      baseUrl,
      "POST",
      `/api/containers/${alice.json.container.id}/actions`,
      { action: "create" },
      { cookie: adminCookie, csrfToken: adminCsrf },
    );
    const profile = await request(
      baseUrl,
      "POST",
      `/api/containers/${alice.json.container.id}/profiles`,
      {
        slug: "sales-assistant",
        displayName: "Sales Assistant",
        bindings: [],
        resourceIds: [resource.json.resource.id],
      },
      { cookie: adminCookie, csrfToken: adminCsrf },
    );
    assert.equal(profile.status, 201);

    const deleted = await request(baseUrl, "DELETE", `/api/users/${bob.json.user.id}`, undefined, {
      cookie: adminCookie,
      csrfToken: adminCsrf,
    });

    assert.equal(deleted.status, 200);
    assert.equal(store.getResource(resource.json.resource.id), null);
    assert.deepEqual(store.getProfile(profile.json.profile.id).resourceIds, []);
  });
});

test("deleting a resource removes it from profile bindings", async () => {
  await withTestServer(async (baseUrl, { store }) => {
    const { adminCookie, adminCsrf } = await loginAsChangedAdmin(baseUrl);
    const alice = await request(
      baseUrl,
      "POST",
      "/api/users",
      {
        username: "alice",
        displayName: "Alice",
        password: "alice-password",
        role: "employee",
      },
      { cookie: adminCookie, csrfToken: adminCsrf },
    );
    const resource = await request(
      baseUrl,
      "POST",
      "/api/resources",
      {
        type: "mcp",
        name: "shared-helper",
        visibility: "company",
      },
      { cookie: adminCookie, csrfToken: adminCsrf },
    );
    await request(
      baseUrl,
      "POST",
      `/api/containers/${alice.json.container.id}/actions`,
      { action: "create" },
      { cookie: adminCookie, csrfToken: adminCsrf },
    );
    const profile = await request(
      baseUrl,
      "POST",
      `/api/containers/${alice.json.container.id}/profiles`,
      {
        slug: "sales-assistant",
        displayName: "Sales Assistant",
        bindings: [],
        resourceIds: [resource.json.resource.id],
      },
      { cookie: adminCookie, csrfToken: adminCsrf },
    );
    assert.equal(profile.status, 201);

    const deleted = await request(baseUrl, "DELETE", `/api/resources/${resource.json.resource.id}`, undefined, {
      cookie: adminCookie,
      csrfToken: adminCsrf,
    });

    assert.equal(deleted.status, 200);
    assert.equal(deleted.json.deleted, true);
    assert.equal(store.getResource(resource.json.resource.id), null);
    assert.deepEqual(store.getProfile(profile.json.profile.id).resourceIds, []);
  });
});

test("making a company resource private removes it from other employees profiles", async () => {
  await withTestServer(async (baseUrl, { store }) => {
    const { adminCookie, adminCsrf } = await loginAsChangedAdmin(baseUrl);
    const alice = await request(
      baseUrl,
      "POST",
      "/api/users",
      {
        username: "alice",
        displayName: "Alice",
        password: "alice-password",
        role: "employee",
      },
      { cookie: adminCookie, csrfToken: adminCsrf },
    );
    const bob = await request(
      baseUrl,
      "POST",
      "/api/users",
      {
        username: "bob",
        displayName: "Bob",
        password: "bob-password",
        role: "employee",
      },
      { cookie: adminCookie, csrfToken: adminCsrf },
    );
    const resource = await request(
      baseUrl,
      "POST",
      "/api/resources",
      {
        ownerId: bob.json.user.id,
        type: "skill",
        name: "shared-review",
        visibility: "company",
      },
      { cookie: adminCookie, csrfToken: adminCsrf },
    );
    await request(
      baseUrl,
      "POST",
      `/api/containers/${alice.json.container.id}/actions`,
      { action: "create" },
      { cookie: adminCookie, csrfToken: adminCsrf },
    );
    const profile = await request(
      baseUrl,
      "POST",
      `/api/containers/${alice.json.container.id}/profiles`,
      {
        slug: "sales-assistant",
        displayName: "Sales Assistant",
        bindings: [],
        resourceIds: [resource.json.resource.id],
      },
      { cookie: adminCookie, csrfToken: adminCsrf },
    );
    assert.equal(profile.status, 201);

    const privatized = await request(
      baseUrl,
      "PUT",
      `/api/resources/${resource.json.resource.id}`,
      { visibility: "private" },
      { cookie: adminCookie, csrfToken: adminCsrf },
    );

    assert.equal(privatized.status, 200);
    assert.equal(store.getResource(resource.json.resource.id).visibility, "private");
    assert.deepEqual(store.getProfile(profile.json.profile.id).resourceIds, []);
  });
});

test("login lockout is keyed by username and returns 429 after repeated failures", async () => {
  await withTestServer(async (baseUrl) => {
    for (let index = 0; index < 5; index += 1) {
      const failed = await request(baseUrl, "POST", "/api/login", {
        username: "admin",
        password: "wrong-password",
      });
      assert.equal(failed.status, 401);
    }

    const locked = await request(baseUrl, "POST", "/api/login", {
      username: "admin",
      password: "admin-bootstrap-password",
    });
    assert.equal(locked.status, 429);
  });
});

test("login lockout cleanup runs periodically without new login attempts", async () => {
  const throttler = new LoginThrottler({
    maxFailures: 1,
    windowMs: 5,
    lockMs: 5,
    cleanupIntervalMs: 5,
  });
  throttler.recordFailure("alice");
  assert.equal(throttler.entries.size, 1);

  await new Promise((resolve) => setTimeout(resolve, 30));

  assert.equal(throttler.entries.size, 0);
});

test("login lockout caps the in-memory username map", () => {
  const throttler = new LoginThrottler({
    maxEntries: 3,
    cleanupIntervalMs: 0,
  });

  for (const username of ["alice", "bob", "charlie", "dana"]) {
    throttler.recordFailure(username);
  }

  assert.equal(throttler.entries.size, 3);
  assert.equal(throttler.entries.has("alice"), false);
  assert.deepEqual([...throttler.entries.keys()], ["bob", "charlie", "dana"]);
});

test("sessions, CSRF, Origin checks, and CORS policy are enforced", async () => {
  await withTestServer(async (baseUrl) => {
    const unauthenticated = await request(baseUrl, "GET", "/api/me");
    assert.equal(unauthenticated.status, 401);
    assert.equal(unauthenticated.headers.get("access-control-allow-origin"), null);

    const loginOne = await request(baseUrl, "POST", "/api/login", {
      username: "admin",
      password: "admin-bootstrap-password",
    });
    const loginTwo = await request(baseUrl, "POST", "/api/login", {
      username: "admin",
      password: "admin-bootstrap-password",
    });
    const cookieOne = loginOne.cookie.split(";")[0];
    const cookieTwo = loginTwo.cookie.split(";")[0];

    const badOrigin = await request(
      baseUrl,
      "POST",
      "/api/me/password",
      {
        currentPassword: "admin-bootstrap-password",
        newPassword: "admin-new-password",
      },
      {
        cookie: cookieOne,
        csrfToken: loginOne.json.csrfToken,
        origin: "http://evil.example",
      },
    );
    assert.equal(badOrigin.status, 403);

    const sameHostDifferentPort = await request(
      baseUrl,
      "POST",
      "/api/me/password",
      {
        currentPassword: "admin-bootstrap-password",
        newPassword: "admin-new-password",
      },
      {
        cookie: cookieOne,
        csrfToken: loginOne.json.csrfToken,
        origin: "http://127.0.0.1:1",
      },
    );
    assert.equal(sameHostDifferentPort.status, 403);

    const changed = await request(
      baseUrl,
      "POST",
      "/api/me/password",
      {
        currentPassword: "admin-bootstrap-password",
        newPassword: "admin-new-password",
      },
      { cookie: cookieOne, csrfToken: loginOne.json.csrfToken },
    );
    assert.equal(changed.status, 200);

    const oldSession = await request(baseUrl, "GET", "/api/me", undefined, { cookie: cookieTwo });
    assert.equal(oldSession.status, 401);
  });
});

test("admin password reset rejects empty passwords without revoking active sessions", async () => {
  await withTestServer(async (baseUrl, { store }) => {
    const { adminCookie, adminCsrf } = await loginAsChangedAdmin(baseUrl);
    const user = await request(
      baseUrl,
      "POST",
      "/api/users",
      {
        username: "alice",
        displayName: "Alice",
        password: "alice-password",
        role: "employee",
      },
      { cookie: adminCookie, csrfToken: adminCsrf },
    );
    const employeeLogin = await request(baseUrl, "POST", "/api/login", {
      username: "alice",
      password: "alice-password",
    });
    const employeeCookie = employeeLogin.cookie.split(";")[0];
    const employeePasswordChange = await request(
      baseUrl,
      "POST",
      "/api/me/password",
      {
        currentPassword: "alice-password",
        newPassword: "alice-new-password",
      },
      { cookie: employeeCookie, csrfToken: employeeLogin.json.csrfToken },
    );
    assert.equal(employeePasswordChange.status, 200);

    const rejectedReset = await request(
      baseUrl,
      "PUT",
      `/api/users/${user.json.user.id}`,
      { password: "" },
      { cookie: adminCookie, csrfToken: adminCsrf },
    );
    const currentSession = await request(baseUrl, "GET", "/api/me", undefined, { cookie: employeeCookie });

    assert.equal(rejectedReset.status, 400);
    assert.equal(store.getUser(user.json.user.id).mustChangePassword, false);
    assert.equal(currentSession.status, 200);
  });
});

test("admin password reset revokes all sessions for the reset user", async () => {
  await withTestServer(async (baseUrl, { store }) => {
    const { adminCookie, adminCsrf } = await loginAsChangedAdmin(baseUrl);
    const user = await request(
      baseUrl,
      "POST",
      "/api/users",
      {
        username: "alice",
        displayName: "Alice",
        password: "alice-password",
        role: "employee",
      },
      { cookie: adminCookie, csrfToken: adminCsrf },
    );
    const loginOne = await request(baseUrl, "POST", "/api/login", {
      username: "alice",
      password: "alice-password",
    });
    const loginTwo = await request(baseUrl, "POST", "/api/login", {
      username: "alice",
      password: "alice-password",
    });
    const cookieOne = loginOne.cookie.split(";")[0];
    const cookieTwo = loginTwo.cookie.split(";")[0];

    const reset = await request(
      baseUrl,
      "PUT",
      `/api/users/${user.json.user.id}`,
      { password: "alice-reset-password" },
      { cookie: adminCookie, csrfToken: adminCsrf },
    );
    const oldSessionOne = await request(baseUrl, "GET", "/api/me", undefined, { cookie: cookieOne });
    const oldSessionTwo = await request(baseUrl, "GET", "/api/me", undefined, { cookie: cookieTwo });

    assert.equal(reset.status, 200);
    assert.equal(store.getUser(user.json.user.id).mustChangePassword, true);
    assert.equal(oldSessionOne.status, 401);
    assert.equal(oldSessionTwo.status, 401);
  });
});

test("GET /api/containers reconciles visible Docker status and health", async () => {
  const docker = new RecordingDocker();
  await withTestServer(
    async (baseUrl, { store }) => {
      const login = await request(baseUrl, "POST", "/api/login", {
        username: "admin",
        password: "admin-bootstrap-password",
      });
      const adminCookie = login.cookie.split(";")[0];
      const changed = await request(
        baseUrl,
        "POST",
        "/api/me/password",
        {
          currentPassword: "admin-bootstrap-password",
          newPassword: "admin-new-password",
        },
        { cookie: adminCookie, csrfToken: login.json.csrfToken },
      );
      const adminCsrf = changed.json.csrfToken;
      const user = await request(
        baseUrl,
        "POST",
        "/api/users",
        {
          username: "alice",
          displayName: "Alice",
          password: "alice-password",
          role: "employee",
        },
        { cookie: adminCookie, csrfToken: adminCsrf },
      );

      const containers = await request(baseUrl, "GET", "/api/containers", undefined, {
        cookie: adminCookie,
      });
      assert.equal(containers.status, 200);
      assert.equal(containers.json.containers[0].id, user.json.container.id);
      assert.equal(containers.json.containers[0].status, "running");
      assert.equal(containers.json.containers[0].health, "ready");
      assert.equal(containers.json.warnings, undefined);
    },
    { docker },
  );
});

test("container reconciliation records docker inspect in execution history", async () => {
  const docker = new RecordingDocker();
  await withTestServer(
    async (baseUrl, { store }) => {
      const { adminCookie, adminCsrf } = await loginAsChangedAdmin(baseUrl);
      await request(
        baseUrl,
        "POST",
        "/api/users",
        {
          username: "alice",
          displayName: "Alice",
          password: "alice-password",
          role: "employee",
        },
        { cookie: adminCookie, csrfToken: adminCsrf },
      );

      const containers = await request(baseUrl, "GET", "/api/containers", undefined, {
        cookie: adminCookie,
        csrfToken: adminCsrf,
      });
      assert.equal(containers.status, 200);

      const executions = await request(baseUrl, "GET", "/api/executions", undefined, {
        cookie: adminCookie,
        csrfToken: adminCsrf,
      });
      const inspectExecution = executions.json.executions.find(
        (execution) => execution.operation === "container.inspect",
      );
      assert.ok(inspectExecution);
      assert.match(inspectExecution.redactedCommand, /docker inspect/);
    },
    { docker },
  );
});

test("unsupported container actions are rejected before lifecycle state changes", async () => {
  await withTestServer(async (baseUrl, { store }) => {
    const { adminCookie, adminCsrf } = await loginAsChangedAdmin(baseUrl);
    const user = await request(
      baseUrl,
      "POST",
      "/api/users",
      {
        username: "alice",
        displayName: "Alice",
        password: "alice-password",
        role: "employee",
      },
      { cookie: adminCookie, csrfToken: adminCsrf },
    );

    const rejected = await request(
      baseUrl,
      "POST",
      `/api/containers/${user.json.container.id}/actions`,
      { action: "explode" },
      { cookie: adminCookie, csrfToken: adminCsrf },
    );

    const container = store.getContainer(user.json.container.id);
    assert.equal(rejected.status, 400);
    assert.equal(container.status, "defined");
    assert.equal(container.operationId, null);
  });
});

test("admins can recreate an employee container after delete", async () => {
  await withTestServer(async (baseUrl, { store }) => {
    const { adminCookie, adminCsrf } = await loginAsChangedAdmin(baseUrl);
    const user = await request(
      baseUrl,
      "POST",
      "/api/users",
      {
        username: "alice",
        displayName: "Alice",
        password: "alice-password",
        role: "employee",
      },
      { cookie: adminCookie, csrfToken: adminCsrf },
    );
    const containerId = user.json.container.id;
    const created = await request(
      baseUrl,
      "POST",
      `/api/containers/${containerId}/actions`,
      { action: "create" },
      { cookie: adminCookie, csrfToken: adminCsrf },
    );
    assert.equal(created.status, 200);

    const deleted = await request(
      baseUrl,
      "POST",
      `/api/containers/${containerId}/actions`,
      { action: "delete" },
      { cookie: adminCookie, csrfToken: adminCsrf },
    );
    assert.equal(deleted.status, 200);
    assert.equal(store.getContainer(containerId).status, "deleted");

    const recreated = await request(
      baseUrl,
      "POST",
      `/api/containers/${containerId}/actions`,
      { action: "create" },
      { cookie: adminCookie, csrfToken: adminCsrf },
    );
    assert.equal(recreated.status, 200);
    assert.equal(recreated.json.container.status, "running");
    assert.equal(recreated.json.container.health, "ready");
    assert.equal(store.getContainer(containerId).status, "running");
  });
});

test("container create is rejected when the Docker container already exists", async () => {
  const docker = new RecordingDocker();
  await withTestServer(
    async (baseUrl, { store }) => {
      const { adminCookie, adminCsrf } = await loginAsChangedAdmin(baseUrl);
      const user = await request(
        baseUrl,
        "POST",
        "/api/users",
        {
          username: "alice",
          displayName: "Alice",
          password: "alice-password",
          role: "employee",
        },
        { cookie: adminCookie, csrfToken: adminCsrf },
      );
      const containerId = user.json.container.id;
      const created = await request(
        baseUrl,
        "POST",
        `/api/containers/${containerId}/actions`,
        { action: "create" },
        { cookie: adminCookie, csrfToken: adminCsrf },
      );
      docker.executed = [];

      const duplicateCreate = await request(
        baseUrl,
        "POST",
        `/api/containers/${containerId}/actions`,
        { action: "create" },
        { cookie: adminCookie, csrfToken: adminCsrf },
      );

      assert.equal(created.status, 200);
      assert.equal(duplicateCreate.status, 409);
      assert.equal(store.getContainer(containerId).status, "running");
      assert.deepEqual(docker.executed, []);
    },
    { docker },
  );
});

test("container reset is rejected before Docker when the container is only defined", async () => {
  const docker = new RecordingDocker();
  await withTestServer(
    async (baseUrl, { store }) => {
      const { adminCookie, adminCsrf } = await loginAsChangedAdmin(baseUrl);
      const user = await request(
        baseUrl,
        "POST",
        "/api/users",
        {
          username: "alice",
          displayName: "Alice",
          password: "alice-password",
          role: "employee",
        },
        { cookie: adminCookie, csrfToken: adminCsrf },
      );

      const reset = await request(
        baseUrl,
        "POST",
        `/api/containers/${user.json.container.id}/actions`,
        { action: "reset" },
        { cookie: adminCookie, csrfToken: adminCsrf },
      );

      const container = store.getContainer(user.json.container.id);
      assert.equal(reset.status, 409);
      assert.equal(reset.json.details.status, "defined");
      assert.equal(reset.json.details.reason, "Container reset requires an existing container.");
      assert.equal(container.status, "defined");
      assert.equal(container.operationId, null);
      assert.equal(docker.executed.length, 0);
    },
    { docker },
  );
});

test("container readiness health checks are recorded in execution history", async () => {
  const docker = new RecordingDocker();
  await withTestServer(
    async (baseUrl, { store }) => {
      const { adminCookie, adminCsrf } = await loginAsChangedAdmin(baseUrl);
      const user = await request(
        baseUrl,
        "POST",
        "/api/users",
        {
          username: "alice",
          displayName: "Alice",
          password: "alice-password",
          role: "employee",
        },
        { cookie: adminCookie, csrfToken: adminCsrf },
      );

      const created = await request(
        baseUrl,
        "POST",
        `/api/containers/${user.json.container.id}/actions`,
        { action: "create" },
        { cookie: adminCookie, csrfToken: adminCsrf },
      );
      assert.equal(created.status, 200);

      const executions = await request(baseUrl, "GET", "/api/executions", undefined, {
        cookie: adminCookie,
        csrfToken: adminCsrf,
      });
      const healthExecution = executions.json.executions.find((execution) => execution.operation === "profile.health");
      assert.ok(healthExecution);
      assert.match(healthExecution.redactedCommand, /hermes-profilectl health --json/);
    },
    { docker },
  );
});

test("container start is rejected before Docker when the container is only defined", async () => {
  const docker = new RecordingDocker();
  await withTestServer(
    async (baseUrl, { store }) => {
      const { adminCookie, adminCsrf } = await loginAsChangedAdmin(baseUrl);
      const user = await request(
        baseUrl,
        "POST",
        "/api/users",
        {
          username: "alice",
          displayName: "Alice",
          password: "alice-password",
          role: "employee",
        },
        { cookie: adminCookie, csrfToken: adminCsrf },
      );

      const start = await request(
        baseUrl,
        "POST",
        `/api/containers/${user.json.container.id}/actions`,
        { action: "start" },
        { cookie: adminCookie, csrfToken: adminCsrf },
      );

      const container = store.getContainer(user.json.container.id);
      assert.equal(start.status, 409);
      assert.equal(start.json.details.status, "defined");
      assert.equal(start.json.details.reason, "Container action requires an existing Docker container.");
      assert.equal(container.status, "defined");
      assert.equal(container.operationId, null);
      assert.equal(docker.executed.length, 0);
    },
    { docker },
  );
});

test("container reset replays stored profiles idempotently and restarts previously running profiles", async () => {
  const docker = new RecordingDocker();
  await withTestServer(
    async (baseUrl) => {
      const login = await request(baseUrl, "POST", "/api/login", {
        username: "admin",
        password: "admin-bootstrap-password",
      });
      const adminCookie = login.cookie.split(";")[0];
      const changed = await request(
        baseUrl,
        "POST",
        "/api/me/password",
        {
          currentPassword: "admin-bootstrap-password",
          newPassword: "admin-new-password",
        },
        { cookie: adminCookie, csrfToken: login.json.csrfToken },
      );
      const adminCsrf = changed.json.csrfToken;
      const user = await request(
        baseUrl,
        "POST",
        "/api/users",
        {
          username: "alice",
          displayName: "Alice",
          password: "alice-password",
          role: "employee",
        },
        { cookie: adminCookie, csrfToken: adminCsrf },
      );
      const containerId = user.json.container.id;
      await request(
        baseUrl,
        "POST",
        `/api/containers/${containerId}/actions`,
        { action: "create" },
        { cookie: adminCookie, csrfToken: adminCsrf },
      );
      const profile = await request(
        baseUrl,
        "POST",
        `/api/containers/${containerId}/profiles`,
        {
          slug: "sales-assistant",
          displayName: "Sales Assistant",
          bindings: [],
          resourceIds: [],
        },
        { cookie: adminCookie, csrfToken: adminCsrf },
      );
      await request(
        baseUrl,
        "POST",
        `/api/profiles/${profile.json.profile.id}/actions`,
        { action: "start" },
        { cookie: adminCookie, csrfToken: adminCsrf },
      );

      docker.executed = [];
      docker.listResult = {
        available: true,
        profiles: [{ slug: "sales-assistant", displayName: "Sales Assistant", status: "running" }],
      };
      const reset = await request(
        baseUrl,
        "POST",
        `/api/containers/${containerId}/actions`,
        { action: "reset" },
        { cookie: adminCookie, csrfToken: adminCsrf },
      );

      assert.equal(reset.status, 200);
      assert.equal(reset.json.replay.failedCount, 0);
      const commands = docker.executed.map((plan) => plan.command?.join(" ") || plan.steps?.map((step) => step.command.join(" ")).join(" && "));
      assert.equal(commands.some((command) => command.includes("hermes-profilectl create --slug sales-assistant")), true);
      assert.equal(commands.some((command) => command.includes("hermes-profilectl start sales-assistant")), true);
      const executions = await request(baseUrl, "GET", "/api/executions", undefined, {
        cookie: adminCookie,
        csrfToken: adminCsrf,
      });
      const operations = executions.json.executions.map((execution) => execution.operation);
      assert.equal(operations.includes("profile.list"), true);
    },
    { docker },
  );
});

test("container readiness timeout stores latest health output and skips reset replay", async () => {
  const docker = new RecordingDocker();
  await withTestServer(
    async (baseUrl, { store }) => {
      const { adminCookie, adminCsrf } = await loginAsChangedAdmin(baseUrl);
      const user = await request(
        baseUrl,
        "POST",
        "/api/users",
        {
          username: "alice",
          displayName: "Alice",
          password: "alice-password",
          role: "employee",
        },
        { cookie: adminCookie, csrfToken: adminCsrf },
      );
      const containerId = user.json.container.id;
      await request(
        baseUrl,
        "POST",
        `/api/containers/${containerId}/actions`,
        { action: "create" },
        { cookie: adminCookie, csrfToken: adminCsrf },
      );
      const profile = await request(
        baseUrl,
        "POST",
        `/api/containers/${containerId}/profiles`,
        {
          slug: "sales-assistant",
          displayName: "Sales Assistant",
          bindings: [],
          resourceIds: [],
        },
        { cookie: adminCookie, csrfToken: adminCsrf },
      );
      assert.equal(profile.status, 201);

      docker.executed = [];
      docker.healthResult = {
        available: true,
        status: "degraded",
        stdout: "{\"status\":\"degraded\",\"reason\":\"warming\"}",
      };
      const reset = await request(
        baseUrl,
        "POST",
        `/api/containers/${containerId}/actions`,
        { action: "reset" },
        { cookie: adminCookie, csrfToken: adminCsrf },
      );

      const container = store.getContainer(containerId);
      const executedActions = docker.executed.map((plan) => `${plan.kind}:${plan.action}`);
      assert.equal(reset.status, 500);
      assert.equal(container.status, "error");
      assert.equal(container.health, "degraded");
      assert.equal(container.lastAction.readiness.stdout, "{\"status\":\"degraded\",\"reason\":\"warming\"}");
      assert.equal(reset.json.replay, undefined);
      assert.deepEqual(executedActions, ["docker:reset"]);
    },
    {
      docker,
      config: {
        readinessTimeoutMs: 0,
        readinessPollMs: 0,
      },
    },
  );
});

test("slow container lifecycle locks only the target and does not block unrelated mutations", async () => {
  const docker = new RecordingDocker();
  let resetStarted;
  let releaseReset;
  const resetStartedPromise = new Promise((resolve) => {
    resetStarted = resolve;
  });
  const releaseResetPromise = new Promise((resolve) => {
    releaseReset = resolve;
  });
  docker.execute = async (plan) => {
    docker.executed.push(plan);
    if (plan.containerName === "hermes-alice" && plan.action === "reset") {
      resetStarted();
      await releaseResetPromise;
    }
    return {
      ok: true,
      mode: "dry-run",
      dryRun: true,
      action: plan.action,
      containerName: plan.containerName,
      redactedCommand: plan.redactedCommand || plan.steps?.map((step) => step.redactedCommand).join(" && "),
      stdout: JSON.stringify({ ok: true, action: plan.action }),
      stderr: "",
      exitCode: 0,
      stdinHash: plan.stdinHash || null,
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
    };
  };

  await withTestServer(
    async (baseUrl, { store }) => {
      const { adminCookie, adminCsrf } = await loginAsChangedAdmin(baseUrl);
      const alice = await request(
        baseUrl,
        "POST",
        "/api/users",
        {
          username: "alice",
          displayName: "Alice",
          password: "alice-password",
          role: "employee",
        },
        { cookie: adminCookie, csrfToken: adminCsrf },
      );
      const bob = await request(
        baseUrl,
        "POST",
        "/api/users",
        {
          username: "bob",
          displayName: "Bob",
          password: "bob-password",
          role: "employee",
        },
        { cookie: adminCookie, csrfToken: adminCsrf },
      );
      const createdAlice = await request(
        baseUrl,
        "POST",
        `/api/containers/${alice.json.container.id}/actions`,
        { action: "create" },
        { cookie: adminCookie, csrfToken: adminCsrf },
      );
      assert.equal(createdAlice.status, 200);

      const resetPromise = request(
        baseUrl,
        "POST",
        `/api/containers/${alice.json.container.id}/actions`,
        { action: "reset" },
        { cookie: adminCookie, csrfToken: adminCsrf },
      );
      await resetStartedPromise;
      let sameTarget;
      let reset;
      try {
        assert.match(store.getContainer(alice.json.container.id).operationId, UUID_STYLE_PATTERN);

        sameTarget = await request(
          baseUrl,
          "POST",
          `/api/containers/${alice.json.container.id}/actions`,
          { action: "start" },
          { cookie: adminCookie, csrfToken: adminCsrf },
        );

        const otherTarget = await request(
          baseUrl,
          "POST",
          `/api/containers/${bob.json.container.id}/actions`,
          { action: "create" },
          { cookie: adminCookie, csrfToken: adminCsrf },
        );
        assert.equal(otherTarget.status, 200);

        const resource = await request(
          baseUrl,
          "POST",
          "/api/resources",
          {
            type: "skill",
            name: "reset-safe-resource",
            visibility: "private",
          },
          { cookie: adminCookie, csrfToken: adminCsrf },
        );
        assert.equal(resource.status, 201);
      } finally {
        releaseReset();
        reset = await resetPromise;
      }
      assert.equal(sameTarget.status, 409);
      assert.equal(sameTarget.json.details.status, "resetting");
      assert.equal(sameTarget.json.details.reason, "Container lifecycle action is already in progress.");
      assert.equal(reset.status, 200);
    },
    { docker },
  );
});

test("slow profile lifecycle conflicts include the current profile status", async () => {
  const docker = new RecordingDocker();
  let startStarted;
  let releaseStart;
  const startStartedPromise = new Promise((resolve) => {
    startStarted = resolve;
  });
  const releaseStartPromise = new Promise((resolve) => {
    releaseStart = resolve;
  });
  docker.execute = async (plan) => {
    docker.executed.push(plan);
    if (plan.kind === "profilectl" && plan.action === "start" && plan.profileSlug === "sales-assistant") {
      startStarted();
      await releaseStartPromise;
    }
    return {
      ok: true,
      mode: "dry-run",
      dryRun: true,
      action: plan.action,
      containerName: plan.containerName,
      redactedCommand: plan.redactedCommand || "",
      stdout: JSON.stringify({ ok: true, action: plan.action }),
      stderr: "",
      exitCode: 0,
      stdinHash: plan.stdinHash || null,
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
    };
  };

  await withTestServer(
    async (baseUrl) => {
      const { adminCookie, adminCsrf } = await loginAsChangedAdmin(baseUrl);
      const user = await request(
        baseUrl,
        "POST",
        "/api/users",
        {
          username: "alice",
          displayName: "Alice",
          password: "alice-password",
          role: "employee",
        },
        { cookie: adminCookie, csrfToken: adminCsrf },
      );
      await request(
        baseUrl,
        "POST",
        `/api/containers/${user.json.container.id}/actions`,
        { action: "create" },
        { cookie: adminCookie, csrfToken: adminCsrf },
      );
      const profile = await request(
        baseUrl,
        "POST",
        `/api/containers/${user.json.container.id}/profiles`,
        {
          slug: "sales-assistant",
          displayName: "Sales Assistant",
          bindings: [],
          resourceIds: [],
        },
        { cookie: adminCookie, csrfToken: adminCsrf },
      );

      const startPromise = request(
        baseUrl,
        "POST",
        `/api/profiles/${profile.json.profile.id}/actions`,
        { action: "start" },
        { cookie: adminCookie, csrfToken: adminCsrf },
      );
      await startStartedPromise;

      const sameTarget = await request(
        baseUrl,
        "POST",
        `/api/profiles/${profile.json.profile.id}/actions`,
        { action: "restart" },
        { cookie: adminCookie, csrfToken: adminCsrf },
      );

      releaseStart();
      const start = await startPromise;
      assert.equal(sameTarget.status, 409);
      assert.equal(sameTarget.json.details.status, "starting");
      assert.equal(sameTarget.json.details.reason, "Profile lifecycle action is already in progress.");
      assert.equal(start.status, 200);
    },
    { docker },
  );
});

test("profile update reapplies config through idempotent create and restores running status", async () => {
  const docker = new RecordingDocker();
  await withTestServer(
    async (baseUrl) => {
      const login = await request(baseUrl, "POST", "/api/login", {
        username: "admin",
        password: "admin-bootstrap-password",
      });
      const adminCookie = login.cookie.split(";")[0];
      const changed = await request(
        baseUrl,
        "POST",
        "/api/me/password",
        {
          currentPassword: "admin-bootstrap-password",
          newPassword: "admin-new-password",
        },
        { cookie: adminCookie, csrfToken: login.json.csrfToken },
      );
      const adminCsrf = changed.json.csrfToken;
      const user = await request(
        baseUrl,
        "POST",
        "/api/users",
        {
          username: "alice",
          displayName: "Alice",
          password: "alice-password",
          role: "employee",
        },
        { cookie: adminCookie, csrfToken: adminCsrf },
      );
      const containerId = user.json.container.id;
      await request(
        baseUrl,
        "POST",
        `/api/containers/${containerId}/actions`,
        { action: "create" },
        { cookie: adminCookie, csrfToken: adminCsrf },
      );
      const profile = await request(
        baseUrl,
        "POST",
        `/api/containers/${containerId}/profiles`,
        {
          slug: "sales-assistant",
          displayName: "Sales Assistant",
          bindings: [],
          resourceIds: [],
        },
        { cookie: adminCookie, csrfToken: adminCsrf },
      );
      await request(
        baseUrl,
        "POST",
        `/api/profiles/${profile.json.profile.id}/actions`,
        { action: "start" },
        { cookie: adminCookie, csrfToken: adminCsrf },
      );

      docker.executed = [];
      const update = await request(
        baseUrl,
        "PUT",
        `/api/profiles/${profile.json.profile.id}`,
        { description: "Updated sales helper." },
        { cookie: adminCookie, csrfToken: adminCsrf },
      );

      assert.equal(update.status, 200);
      assert.equal(update.json.profile.description, "Updated sales helper.");
      assert.equal(update.json.profile.status, "running");
      assert.equal(update.json.execution.operation, "profile.update");
      const commands = docker.executed.map((plan) => plan.command.join(" "));
      assert.equal(commands.some((command) => command.includes("hermes-profilectl create --slug sales-assistant")), true);
      assert.equal(commands.some((command) => command.includes("hermes-profilectl start sales-assistant")), true);
    },
    { docker },
  );
});

test("failed profile create can be retried with the create action", async () => {
  const docker = new RecordingDocker();
  let failedCreate = false;
  docker.execute = async (plan) => {
    docker.executed.push(plan);
    if (plan.kind === "profilectl" && plan.action === "create" && !failedCreate) {
      failedCreate = true;
      return {
        ok: false,
        mode: "dry-run",
        dryRun: true,
        action: plan.action,
        containerName: plan.containerName,
        redactedCommand: plan.redactedCommand || "",
        stdout: "",
        stderr: "profile create failed",
        exitCode: 8,
        stdinHash: plan.stdinHash || null,
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
      };
    }
    return {
      ok: true,
      mode: "dry-run",
      dryRun: true,
      action: plan.action,
      containerName: plan.containerName,
      redactedCommand: plan.redactedCommand || plan.steps?.map((step) => step.redactedCommand).join(" && "),
      stdout: JSON.stringify({ ok: true, action: plan.action }),
      stderr: "",
      exitCode: 0,
      stdinHash: plan.stdinHash || null,
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
    };
  };

  await withTestServer(
    async (baseUrl, { store }) => {
      const { adminCookie, adminCsrf } = await loginAsChangedAdmin(baseUrl);
      const user = await request(
        baseUrl,
        "POST",
        "/api/users",
        {
          username: "alice",
          displayName: "Alice",
          password: "alice-password",
          role: "employee",
        },
        { cookie: adminCookie, csrfToken: adminCsrf },
      );
      const containerId = user.json.container.id;
      await request(
        baseUrl,
        "POST",
        `/api/containers/${containerId}/actions`,
        { action: "create" },
        { cookie: adminCookie, csrfToken: adminCsrf },
      );
      const failed = await request(
        baseUrl,
        "POST",
        `/api/containers/${containerId}/profiles`,
        {
          slug: "sales-assistant",
          displayName: "Sales Assistant",
          bindings: [],
          resourceIds: [],
        },
        { cookie: adminCookie, csrfToken: adminCsrf },
      );
      const profileId = failed.json.profile.id;

      const retry = await request(
        baseUrl,
        "POST",
        `/api/profiles/${profileId}/actions`,
        { action: "create" },
        { cookie: adminCookie, csrfToken: adminCsrf },
      );

      assert.equal(failed.status, 500);
      assert.equal(failed.json.profile.status, "error");
      assert.match(failed.json.execution.stdinHash, /^[a-f0-9]{64}$/);
      assert.equal(retry.status, 200);
      assert.equal(retry.json.profile.status, "stopped");
      assert.equal(retry.json.execution.operation, "profile.create");
      assert.equal(store.getProfile(profileId).status, "stopped");
      assert.equal(
        docker.executed.filter((plan) => plan.kind === "profilectl" && plan.action === "create").length,
        2,
      );
    },
    { docker },
  );
});

test("deleted profiles reject lifecycle actions without being resurrected", async () => {
  await withTestServer(async (baseUrl, { store }) => {
    const { adminCookie, adminCsrf } = await loginAsChangedAdmin(baseUrl);
    const user = await request(
      baseUrl,
      "POST",
      "/api/users",
      {
        username: "alice",
        displayName: "Alice",
        password: "alice-password",
        role: "employee",
      },
      { cookie: adminCookie, csrfToken: adminCsrf },
    );
    const containerId = user.json.container.id;
    await request(
      baseUrl,
      "POST",
      `/api/containers/${containerId}/actions`,
      { action: "create" },
      { cookie: adminCookie, csrfToken: adminCsrf },
    );
    const profile = await request(
      baseUrl,
      "POST",
      `/api/containers/${containerId}/profiles`,
      {
        slug: "sales-assistant",
        displayName: "Sales Assistant",
        bindings: [],
        resourceIds: [],
      },
      { cookie: adminCookie, csrfToken: adminCsrf },
    );
    const profileId = profile.json.profile.id;

    const deleted = await request(baseUrl, "DELETE", `/api/profiles/${profileId}`, undefined, {
      cookie: adminCookie,
      csrfToken: adminCsrf,
    });
    const restarted = await request(
      baseUrl,
      "POST",
      `/api/profiles/${profileId}/actions`,
      { action: "start" },
      { cookie: adminCookie, csrfToken: adminCsrf },
    );

    assert.equal(deleted.status, 200);
    assert.equal(store.getProfile(profileId).status, "deleted");
    assert.equal(restarted.status, 409);
    assert.equal(store.getProfile(profileId).status, "deleted");
  });
});

test("delete-failed profiles only allow delete retry and cannot be started", async () => {
  const docker = new RecordingDocker();
  docker.execute = async (plan) => {
    docker.executed.push(plan);
    if (plan.kind === "profilectl" && plan.action === "delete") {
      return {
        ok: false,
        mode: "dry-run",
        dryRun: true,
        action: plan.action,
        containerName: plan.containerName,
        redactedCommand: plan.redactedCommand || "",
        stdout: "",
        stderr: "delete failed",
        exitCode: 10,
        stdinHash: plan.stdinHash || null,
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
      };
    }
    return {
      ok: true,
      mode: "dry-run",
      dryRun: true,
      action: plan.action,
      containerName: plan.containerName,
      redactedCommand: plan.redactedCommand || "",
      stdout: "{}",
      stderr: "",
      exitCode: 0,
      stdinHash: plan.stdinHash || null,
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
    };
  };

  await withTestServer(
    async (baseUrl, { store }) => {
      const { adminCookie, adminCsrf } = await loginAsChangedAdmin(baseUrl);
      const user = await request(
        baseUrl,
        "POST",
        "/api/users",
        {
          username: "alice",
          displayName: "Alice",
          password: "alice-password",
          role: "employee",
        },
        { cookie: adminCookie, csrfToken: adminCsrf },
      );
      const containerId = user.json.container.id;
      await request(
        baseUrl,
        "POST",
        `/api/containers/${containerId}/actions`,
        { action: "create" },
        { cookie: adminCookie, csrfToken: adminCsrf },
      );
      const profile = await request(
        baseUrl,
        "POST",
        `/api/containers/${containerId}/profiles`,
        {
          slug: "sales-assistant",
          displayName: "Sales Assistant",
          bindings: [],
          resourceIds: [],
        },
        { cookie: adminCookie, csrfToken: adminCsrf },
      );
      const profileId = profile.json.profile.id;

      const failedDelete = await request(baseUrl, "DELETE", `/api/profiles/${profileId}`, undefined, {
        cookie: adminCookie,
        csrfToken: adminCsrf,
      });
      const started = await request(
        baseUrl,
        "POST",
        `/api/profiles/${profileId}/actions`,
        { action: "start" },
        { cookie: adminCookie, csrfToken: adminCsrf },
      );
      docker.executed = [];
      const reset = await request(
        baseUrl,
        "POST",
        `/api/containers/${containerId}/actions`,
        { action: "reset" },
        { cookie: adminCookie, csrfToken: adminCsrf },
      );

      assert.equal(failedDelete.status, 500);
      assert.equal(store.getProfile(profileId).status, "delete_failed");
      assert.equal(started.status, 409);
      assert.equal(reset.status, 200);
      assert.equal(
        docker.executed.some((plan) => plan.kind === "profilectl" && plan.action === "create"),
        false,
      );
      assert.equal(store.getProfile(profileId).status, "delete_failed");
    },
    { docker },
  );
});

test("disabling a running profile does not mask a failed stop command", async () => {
  const docker = new RecordingDocker();
  docker.execute = async (plan) => {
    docker.executed.push(plan);
    if (plan.kind === "profilectl" && plan.action === "stop") {
      return {
        ok: false,
        mode: "dry-run",
        dryRun: true,
        action: plan.action,
        containerName: plan.containerName,
        redactedCommand: plan.redactedCommand || "",
        stdout: "",
        stderr: "stop failed",
        exitCode: 10,
        stdinHash: plan.stdinHash || null,
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
      };
    }
    return {
      ok: true,
      mode: "dry-run",
      dryRun: true,
      action: plan.action,
      containerName: plan.containerName,
      redactedCommand: plan.redactedCommand || "",
      stdout: "{}",
      stderr: "",
      exitCode: 0,
      stdinHash: plan.stdinHash || null,
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
    };
  };

  await withTestServer(
    async (baseUrl, { store }) => {
      const { adminCookie, adminCsrf } = await loginAsChangedAdmin(baseUrl);
      const user = await request(
        baseUrl,
        "POST",
        "/api/users",
        {
          username: "alice",
          displayName: "Alice",
          password: "alice-password",
          role: "employee",
        },
        { cookie: adminCookie, csrfToken: adminCsrf },
      );
      const containerId = user.json.container.id;
      await request(
        baseUrl,
        "POST",
        `/api/containers/${containerId}/actions`,
        { action: "create" },
        { cookie: adminCookie, csrfToken: adminCsrf },
      );
      const profile = await request(
        baseUrl,
        "POST",
        `/api/containers/${containerId}/profiles`,
        {
          slug: "sales-assistant",
          displayName: "Sales Assistant",
          bindings: [],
          resourceIds: [],
        },
        { cookie: adminCookie, csrfToken: adminCsrf },
      );
      await request(
        baseUrl,
        "POST",
        `/api/profiles/${profile.json.profile.id}/actions`,
        { action: "start" },
        { cookie: adminCookie, csrfToken: adminCsrf },
      );

      const disabled = await request(
        baseUrl,
        "PUT",
        `/api/profiles/${profile.json.profile.id}`,
        { enabled: false },
        { cookie: adminCookie, csrfToken: adminCsrf },
      );

      const current = store.getProfile(profile.json.profile.id);
      assert.equal(disabled.status, 500);
      assert.equal(current.status, "error");
      assert.equal(current.enabled, true);
      assert.equal(disabled.json.execution.operation, "profile.stop");
      assert.equal(disabled.json.execution.stderr, "stop failed");
    },
    { docker },
  );
});

test("execution history is visible to admins and scoped to the employee owner", async () => {
  await withTestServer(async (baseUrl) => {
    const login = await request(baseUrl, "POST", "/api/login", {
      username: "admin",
      password: "admin-bootstrap-password",
    });
    const adminCookie = login.cookie.split(";")[0];
    const changed = await request(
      baseUrl,
      "POST",
      "/api/me/password",
      {
        currentPassword: "admin-bootstrap-password",
        newPassword: "admin-new-password",
      },
      { cookie: adminCookie, csrfToken: login.json.csrfToken },
    );
    const adminCsrf = changed.json.csrfToken;
    const alice = await request(
      baseUrl,
      "POST",
      "/api/users",
      {
        username: "alice",
        displayName: "Alice",
        password: "alice-password",
        role: "employee",
      },
      { cookie: adminCookie, csrfToken: adminCsrf },
    );
    const bob = await request(
      baseUrl,
      "POST",
      "/api/users",
      {
        username: "bob",
        displayName: "Bob",
        password: "bob-password",
        role: "employee",
      },
      { cookie: adminCookie, csrfToken: adminCsrf },
    );
    await request(
      baseUrl,
      "POST",
      `/api/containers/${alice.json.container.id}/actions`,
      { action: "create" },
      { cookie: adminCookie, csrfToken: adminCsrf },
    );
    await request(
      baseUrl,
      "POST",
      `/api/containers/${bob.json.container.id}/actions`,
      { action: "create" },
      { cookie: adminCookie, csrfToken: adminCsrf },
    );

    const employeeLogin = await request(baseUrl, "POST", "/api/login", {
      username: "alice",
      password: "alice-password",
    });
    const employeeCookie = employeeLogin.cookie.split(";")[0];
    const employeeChanged = await request(
      baseUrl,
      "POST",
      "/api/me/password",
      {
        currentPassword: "alice-password",
        newPassword: "alice-new-password",
      },
      { cookie: employeeCookie, csrfToken: employeeLogin.json.csrfToken },
    );

    const adminExecutions = await request(baseUrl, "GET", "/api/executions", undefined, {
      cookie: adminCookie,
    });
    const employeeExecutions = await request(baseUrl, "GET", "/api/executions", undefined, {
      cookie: employeeCookie,
    });

    assert.equal(adminExecutions.status, 200);
    assert.equal(adminExecutions.json.executions.length >= 2, true);
    assert.equal(employeeExecutions.status, 200);
    assert.deepEqual(
      [...new Set(employeeExecutions.json.executions.map((execution) => execution.ownerId))],
      [alice.json.user.id],
    );
    assert.equal(employeeChanged.status, 200);
  });
});

test("system summary is admin-only and does not leak API keys", async () => {
  await withTestServer(async (baseUrl) => {
    const login = await request(baseUrl, "POST", "/api/login", {
      username: "admin",
      password: "admin-bootstrap-password",
    });
    const adminCookie = login.cookie.split(";")[0];
    const changedAdmin = await request(
      baseUrl,
      "POST",
      "/api/me/password",
      {
        currentPassword: "admin-bootstrap-password",
        newPassword: "admin-new-password",
      },
      { cookie: adminCookie, csrfToken: login.json.csrfToken },
    );
    const adminCsrf = changedAdmin.json.csrfToken;

    const system = await request(baseUrl, "GET", "/api/system", undefined, {
      cookie: adminCookie,
    });

    assert.equal(system.status, 200);
    assert.equal(system.json.dockerMode, "dry-run");
    assert.equal(system.json.privateModel.baseUrl, "http://192.168.100.12:8000/v1");
    assert.equal(system.json.privateModel.model, "qwen3.6-35b-a3b");
    assert.equal(system.json.privateModel.apiKey, "<redacted>");
    assert.equal(system.json.publicAccess, "60.205.213.254:2444");
    assert.equal(JSON.stringify(system.json).includes("test-key"), false);

    const employee = await request(
      baseUrl,
      "POST",
      "/api/users",
      {
        username: "alice",
        displayName: "Alice",
        password: "alice-password",
        role: "employee",
      },
      { cookie: adminCookie, csrfToken: adminCsrf },
    );
    assert.equal(employee.status, 201);
    const employeeLogin = await request(baseUrl, "POST", "/api/login", {
      username: "alice",
      password: "alice-password",
    });
    const employeeCookie = employeeLogin.cookie.split(";")[0];
    const changedEmployee = await request(
      baseUrl,
      "POST",
      "/api/me/password",
      {
        currentPassword: "alice-password",
        newPassword: "alice-new-password",
      },
      { cookie: employeeCookie, csrfToken: employeeLogin.json.csrfToken },
    );
    assert.equal(changedEmployee.status, 200);
    const employeeSystem = await request(baseUrl, "GET", "/api/system", undefined, {
      cookie: employeeCookie,
    });

    assert.equal(employeeSystem.status, 403);
  });
});

test("stale container lifecycle results do not overwrite a changed operationId", async () => {
  const docker = new RecordingDocker();
  let staleContainerId = "";
  docker.execute = async (plan) => {
    docker.executed.push(plan);
    if (staleContainerId && plan.action === "create") {
      await docker.store.updateContainerLifecycle(staleContainerId, {
        status: "deleted",
        operationId: "op_external_change",
      });
    }
    return {
      ok: true,
      mode: "dry-run",
      dryRun: true,
      action: plan.action,
      containerName: plan.containerName,
      redactedCommand: plan.redactedCommand || "",
      stdout: "{}",
      stderr: "",
      exitCode: 0,
      stdinHash: null,
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
    };
  };

  await withTestServer(
    async (baseUrl, { store }) => {
      docker.store = store;
      const { adminCookie, adminCsrf } = await loginAsChangedAdmin(baseUrl);
      const user = await request(
        baseUrl,
        "POST",
        "/api/users",
        {
          username: "alice",
          displayName: "Alice",
          password: "alice-password",
          role: "employee",
        },
        { cookie: adminCookie, csrfToken: adminCsrf },
      );
      staleContainerId = user.json.container.id;

      const create = await request(
        baseUrl,
        "POST",
        `/api/containers/${staleContainerId}/actions`,
        { action: "create" },
        { cookie: adminCookie, csrfToken: adminCsrf },
      );

      const container = store.getContainer(staleContainerId);
      assert.equal(create.status, 409);
      assert.equal(create.json.stale, true);
      assert.equal(container.status, "deleted");
      assert.equal(container.operationId, "op_external_change");
    },
    { docker },
  );
});

test("stale profile update results do not overwrite a changed operationId", async () => {
  const docker = new RecordingDocker();
  let staleProfileId = "";
  docker.execute = async (plan) => {
    docker.executed.push(plan);
    if (staleProfileId && plan.action === "create" && plan.kind === "profilectl") {
      await docker.store.updateProfile(staleProfileId, {
        status: "deleted",
        operationId: "op_profile_external_change",
      });
    }
    return {
      ok: true,
      mode: "dry-run",
      dryRun: true,
      action: plan.action,
      containerName: plan.containerName,
      redactedCommand: plan.redactedCommand || "",
      stdout: "{}",
      stderr: "",
      exitCode: 0,
      stdinHash: plan.stdinHash || null,
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
    };
  };

  await withTestServer(
    async (baseUrl, { store }) => {
      docker.store = store;
      const { adminCookie, adminCsrf } = await loginAsChangedAdmin(baseUrl);
      const user = await request(
        baseUrl,
        "POST",
        "/api/users",
        {
          username: "alice",
          displayName: "Alice",
          password: "alice-password",
          role: "employee",
        },
        { cookie: adminCookie, csrfToken: adminCsrf },
      );
      await request(
        baseUrl,
        "POST",
        `/api/containers/${user.json.container.id}/actions`,
        { action: "create" },
        { cookie: adminCookie, csrfToken: adminCsrf },
      );
      const profile = await request(
        baseUrl,
        "POST",
        `/api/containers/${user.json.container.id}/profiles`,
        {
          slug: "sales-assistant",
          displayName: "Sales Assistant",
          bindings: [],
          resourceIds: [],
        },
        { cookie: adminCookie, csrfToken: adminCsrf },
      );
      staleProfileId = profile.json.profile.id;

      const update = await request(
        baseUrl,
        "PUT",
        `/api/profiles/${staleProfileId}`,
        { description: "Updated after external change." },
        { cookie: adminCookie, csrfToken: adminCsrf },
      );

      const current = store.getProfile(staleProfileId);
      assert.equal(update.status, 409);
      assert.equal(update.json.stale, true);
      assert.equal(current.status, "deleted");
      assert.equal(current.operationId, "op_profile_external_change");
    },
    { docker },
  );
});

test("stale reset replay profile results do not overwrite a changed operationId", async () => {
  const docker = new RecordingDocker();
  let staleProfileId = "";
  let storeRef = null;
  let injected = false;
  docker.execute = async (plan) => {
    docker.executed.push(plan);
    if (
      staleProfileId &&
      !injected &&
      plan.kind === "profilectl" &&
      plan.action === "create" &&
      plan.profileSlug === "sales-assistant"
    ) {
      injected = true;
      await storeRef.updateProfile(staleProfileId, {
        status: "deleted",
        operationId: "op_replay_external_change",
      });
    }
    return {
      ok: true,
      mode: "dry-run",
      dryRun: true,
      action: plan.action,
      containerName: plan.containerName,
      redactedCommand: plan.redactedCommand || "",
      stdout: "{}",
      stderr: "",
      exitCode: 0,
      stdinHash: plan.stdinHash || null,
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
    };
  };

  await withTestServer(
    async (baseUrl, { store }) => {
      storeRef = store;
      const { adminCookie, adminCsrf } = await loginAsChangedAdmin(baseUrl);
      const user = await request(
        baseUrl,
        "POST",
        "/api/users",
        {
          username: "alice",
          displayName: "Alice",
          password: "alice-password",
          role: "employee",
        },
        { cookie: adminCookie, csrfToken: adminCsrf },
      );
      await request(
        baseUrl,
        "POST",
        `/api/containers/${user.json.container.id}/actions`,
        { action: "create" },
        { cookie: adminCookie, csrfToken: adminCsrf },
      );
      const profile = await request(
        baseUrl,
        "POST",
        `/api/containers/${user.json.container.id}/profiles`,
        {
          slug: "sales-assistant",
          displayName: "Sales Assistant",
          bindings: [],
          resourceIds: [],
        },
        { cookie: adminCookie, csrfToken: adminCsrf },
      );
      staleProfileId = profile.json.profile.id;

      const reset = await request(
        baseUrl,
        "POST",
        `/api/containers/${user.json.container.id}/actions`,
        { action: "reset" },
        { cookie: adminCookie, csrfToken: adminCsrf },
      );

      const current = store.getProfile(staleProfileId);
      assert.equal(reset.status, 200);
      assert.equal(reset.json.replay.failedCount, 1);
      assert.equal(reset.json.replay.results[0].stale, true);
      assert.equal(current.status, "deleted");
      assert.equal(current.operationId, "op_replay_external_change");
    },
    { docker },
  );
});
