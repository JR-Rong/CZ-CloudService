const assert = require("node:assert/strict");
const { once } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const { createServer } = require("../src/server");

async function withStaticServer(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-platform-static-"));
  const app = createServer({
    config: {
      dataFile: path.join(dir, "state.json"),
      dockerMode: "dry-run",
      bootstrapAdminUsername: "admin",
      bootstrapAdminPassword: "admin-password",
      sessionTtlHours: 1,
    },
  });
  app.listen(0, "127.0.0.1");
  await once(app, "listening");
  try {
    const address = app.address();
    await fn(`http://127.0.0.1:${address.port}`);
  } finally {
    app.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function createElementStub(tag) {
  return {
    tag,
    attrs: {},
    children: [],
    className: "",
    textContent: "",
    setAttribute(key, value) {
      this.attrs[key] = String(value);
    },
    append(child) {
      this.children.push(child);
    },
    addEventListener() {},
  };
}

function renderResourcesFor(user, resources) {
  const script = fs.readFileSync(path.join(__dirname, "../public/app.js"), "utf8");
  const context = {
    document: {
      createElement: createElementStub,
      createTextNode: (text) => ({ tag: "#text", textContent: String(text), children: [] }),
      addEventListener() {},
    },
    window: {
      confirm: () => false,
      prompt: () => null,
    },
  };
  vm.runInNewContext(
    `${script}
state.user = ${JSON.stringify(user)};
state.resources = ${JSON.stringify(resources)};
globalThis.__resourceTable = renderResources();
`,
    context,
  );
  return context.__resourceTable;
}

function resourceOptionLabelFor(resource) {
  const script = fs.readFileSync(path.join(__dirname, "../public/app.js"), "utf8");
  const context = {
    document: {
      createElement: createElementStub,
      createTextNode: (text) => ({ tag: "#text", textContent: String(text), children: [] }),
      addEventListener() {},
    },
    window: {
      confirm: () => false,
      prompt: () => null,
    },
  };
  vm.runInNewContext(
    `${script}
globalThis.__resourceOptionLabel = resourceOptionLabel(${JSON.stringify(resource)});
`,
    context,
  );
  return context.__resourceOptionLabel;
}

function collectChatBindingsFor(values, existingBindings = []) {
  const script = fs.readFileSync(path.join(__dirname, "../public/app.js"), "utf8");
  const context = {
    document: {
      createElement: createElementStub,
      createTextNode: (text) => ({ tag: "#text", textContent: String(text), children: [] }),
      addEventListener() {},
    },
    window: {
      confirm: () => false,
      prompt: () => null,
    },
    __bindingValues: values,
  };
  vm.runInNewContext(
    `${script}
const formDataLike = {
  get(name) {
    return globalThis.__bindingValues[name] || "";
  }
};
globalThis.__chatBindings = collectChatBindingsFromFormData(formDataLike, ${JSON.stringify(existingBindings)});
`,
    context,
  );
  return Array.from(context.__chatBindings, (binding) => ({ ...binding }));
}

function renderProfilesFor(user, containers, profiles) {
  const script = fs.readFileSync(path.join(__dirname, "../public/app.js"), "utf8");
  const context = {
    document: {
      createElement: createElementStub,
      createTextNode: (text) => ({ tag: "#text", textContent: String(text), children: [] }),
      addEventListener() {},
    },
    window: {
      confirm: () => false,
      prompt: () => null,
    },
  };
  vm.runInNewContext(
    `${script}
state.user = ${JSON.stringify(user)};
state.containers = ${JSON.stringify(containers)};
state.profiles = ${JSON.stringify(profiles)};
globalThis.__profileTable = renderProfiles();
`,
    context,
  );
  return context.__profileTable;
}

async function renderDashboardFor(user, overrides = {}) {
  const script = fs.readFileSync(path.join(__dirname, "../public/app.js"), "utf8");
  const appRoot = createElementStub("main");
  appRoot.replaceChildren = (...children) => {
    appRoot.children = children;
  };
  const containers = overrides.containers || [
    {
      id: "ctr_alice",
      containerName: "hermes-alice",
      ownerId: user.id,
      status: "running",
      health: "ready",
      llm: { model: "qwen3.6-35b-a3b" },
    },
  ];
  const responses = {
    "/api/me": { user, csrfToken: "csrf-test" },
    "/api/containers": { containers, warnings: overrides.containerWarnings || [] },
    "/api/resources": { resources: [] },
    "/api/system": {
      dockerMode: "dry-run",
      privateModel: { baseUrl: "http://192.168.100.12:8000/v1", model: "qwen3.6-35b-a3b", apiKey: "<redacted>" },
      publicAccess: "60.205.213.254:2444",
    },
    "/api/executions": { executions: [] },
    "/api/users": { users: [user] },
  };
  for (const container of containers) {
    responses[`/api/containers/${container.id}/profiles`] = { profiles: [] };
  }
  const context = {
    document: {
      createElement: createElementStub,
      createTextNode: (text) => ({ tag: "#text", textContent: String(text), children: [] }),
      addEventListener() {},
      querySelector: (selector) => (selector === "#app" ? appRoot : null),
    },
    window: {
      confirm: () => false,
      prompt: () => null,
    },
  };
  const renderPromise = vm.runInNewContext(
    `${script}
api = async (path) => {
  const payload = globalThis.__responses[path];
  if (!payload) throw new Error("Unexpected API path " + path);
  return payload;
};
globalThis.__renderPromise = loadDashboard();
`,
    { ...context, __responses: responses },
  );
  await renderPromise;
  return appRoot;
}

async function runDashboardActionFailure(actionExpression) {
  const script = fs.readFileSync(path.join(__dirname, "../public/app.js"), "utf8");
  const errorNode = createElementStub("p");
  const context = {
    document: {
      createElement: createElementStub,
      createTextNode: (text) => ({ tag: "#text", textContent: String(text), children: [] }),
      addEventListener() {},
      querySelector: (selector) => (selector === "#dashboard-error" ? errorNode : null),
    },
    window: {
      confirm: () => false,
      prompt: () => null,
    },
    __errorNode: errorNode,
  };
  vm.runInNewContext(
    `${script}
api = async () => {
  throw new Error("Docker failed safely");
};
loadDashboard = async () => {
  globalThis.__loadCalled = true;
};
globalThis.__actionPromise = ${actionExpression}.then(
  () => {
    globalThis.__resolved = true;
  },
  (error) => {
    globalThis.__rejected = error.message;
  },
);
`,
    context,
  );
  await context.__actionPromise;
  return context;
}

function collectText(node) {
  if (!node) return "";
  if (typeof node === "string") return node;
  return [node.textContent || "", ...(node.children || []).map(collectText)].join(" ").trim();
}

test("serves the management page and frontend assets", async () => {
  await withStaticServer(async (baseUrl) => {
    const index = await fetch(`${baseUrl}/`);
    const script = await fetch(`${baseUrl}/app.js`);
    const styles = await fetch(`${baseUrl}/styles.css`);

    assert.equal(index.status, 200);
    assert.equal(script.status, 200);
    assert.equal(styles.status, 200);
    const indexText = await index.text();
    assert.match(indexText, /Hermes Agent 管理平台/);
    assert.match(indexText, /rel="icon"/);
    assert.match(indexText, /data:image\/svg\+xml/);
    const scriptText = await script.text();
    assert.match(scriptText, /loadDashboard/);
    assert.match(scriptText, /\/api\/system/);
    assert.match(scriptText, /Execution history/);
    assert.match(scriptText, /credentialRef/);
    assert.match(scriptText, /Delete resource/);
    assert.match(scriptText, /state\.users/);
    assert.match(scriptText, /\/api\/users/);
    assert.match(scriptText, /renderUsers/);
    assert.match(scriptText, /editUser/);
    assert.match(scriptText, /data-user-editor/);
    assert.match(scriptText, /deleteUser/);
    assert.match(scriptText, /statusSummary/);
    assert.match(scriptText, /Container statuses/);
    assert.match(scriptText, /Container health summary/);
    assert.match(scriptText, /statusSummary\(state\.containers, "health"\)/);
    assert.match(scriptText, /Profile statuses/);
    assert.match(scriptText, /editProfile/);
    assert.match(scriptText, /updateProfile/);
    assert.match(scriptText, /Chat bindings/);
    assert.match(scriptText, /CHAT_BINDING_PLATFORMS/);
    assert.match(scriptText, /renderChatBindingFields/);
    assert.match(scriptText, /collectChatBindingsFromFormData/);
    assert.match(scriptText, /Resource IDs/);
    assert.match(scriptText, /bindings:/);
    assert.match(scriptText, /resourceIds:/);
    assert.match(scriptText, /editResource/);
    assert.match(scriptText, /data-resource-editor/);
    assert.match(scriptText, /updateResource/);
    assert.match(scriptText, /Promise\.all\(state\.containers\.map/);
    assert.doesNotMatch(scriptText, /state\.containers\[0\]\.id\}\/profiles/);
    assert.match(scriptText, /ownerId/);
    assert.match(scriptText, /Resource owner/);
    assert.match(await styles.text(), /--accent/);
  });
});

test("employee resource table hides management controls for resources they do not own", () => {
  const table = renderResourcesFor(
    { id: "usr_alice", role: "employee" },
    [
      {
        id: "res_own",
        name: "Own helper",
        type: "skill",
        ownerId: "usr_alice",
        visibility: "private",
        packageRef: "skills/own-helper",
        version: "0.2.0",
      },
      {
        id: "res_shared",
        name: "Shared helper",
        type: "mcp",
        ownerId: "usr_bob",
        visibility: "company",
        packageRef: "mcp/shared-helper",
        version: "1.4.0",
      },
    ],
  );
  const rows = table.children[1].children.map(collectText);
  const ownRow = rows.find((row) => row.includes("Own helper"));
  const sharedRow = rows.find((row) => row.includes("Shared helper"));

  assert.match(ownRow, /Edit resource/);
  assert.match(ownRow, /0\.2\.0/);
  assert.match(ownRow, /Share company/);
  assert.match(ownRow, /Delete resource/);
  assert.match(sharedRow, /1\.4\.0/);
  assert.doesNotMatch(sharedRow, /Edit resource/);
  assert.doesNotMatch(sharedRow, /Make private/);
  assert.doesNotMatch(sharedRow, /Delete resource/);
});

test("resource binding option labels include resource version", () => {
  const label = resourceOptionLabelFor({
    id: "res_shared",
    name: "Shared helper",
    type: "mcp",
    ownerId: "usr_bob",
    visibility: "company",
    packageRef: "mcp/shared-helper",
    version: "1.4.0",
  });

  assert.match(label, /Shared helper/);
  assert.match(label, /mcp/);
  assert.match(label, /company/);
  assert.match(label, /owner usr_bob/);
  assert.match(label, /mcp\/shared-helper/);
  assert.match(label, /version 1\.4\.0/);
});

test("chat binding form collection supports multiple platforms", () => {
  const bindings = collectChatBindingsFor(
    {
      feishuDisplayName: "Sales Feishu Bot",
      feishuExternalRef: "bot-sales",
      feishuCredentialRef: "secret://feishu/sales-01",
      qqDisplayName: "QQ Helper",
      qqExternalRef: "qq-helper",
      qqCredentialRef: "secret://qq/internal-helper",
    },
    [{ id: "bind_existing", platform: "feishu", enabled: true }],
  );

  assert.deepEqual(bindings, [
    {
      id: "bind_existing",
      platform: "feishu",
      displayName: "Sales Feishu Bot",
      externalRef: "bot-sales",
      credentialRef: "secret://feishu/sales-01",
      enabled: true,
    },
    {
      id: undefined,
      platform: "qq",
      displayName: "QQ Helper",
      externalRef: "qq-helper",
      credentialRef: "secret://qq/internal-helper",
      enabled: true,
    },
  ]);
});

test("profile rows show the disabled action reason when container is not ready", () => {
  const table = renderProfilesFor(
    { id: "usr_alice", role: "employee" },
    [
      {
        id: "ctr_alice",
        containerName: "hermes-alice",
        ownerId: "usr_alice",
        status: "running",
        health: "starting",
      },
    ],
    [
      {
        id: "prof_sales",
        containerId: "ctr_alice",
        slug: "sales",
        displayName: "Sales",
        enabled: true,
        status: "stopped",
      },
    ],
  );
  const rowText = collectText(table.children[1].children[0]);

  assert.match(rowText, /Container must be running and ready/);
});

test("profile rows expose retry apply for errored profiles", () => {
  const table = renderProfilesFor(
    { id: "usr_alice", role: "employee" },
    [
      {
        id: "ctr_alice",
        containerName: "hermes-alice",
        ownerId: "usr_alice",
        status: "running",
        health: "ready",
      },
    ],
    [
      {
        id: "prof_sales",
        containerId: "ctr_alice",
        slug: "sales",
        displayName: "Sales",
        enabled: true,
        status: "error",
      },
    ],
  );
  const rowText = collectText(table.children[1].children[0]);

  assert.match(rowText, /Retry apply/);
});

test("profile editing uses an inline form instead of browser prompt dialogs", () => {
  const script = fs.readFileSync(path.join(__dirname, "../public/app.js"), "utf8");
  const start = script.indexOf("async function editProfile");
  const end = script.indexOf("\nasync function updateResource", start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const editProfileSource = script.slice(start, end);

  assert.doesNotMatch(editProfileSource, /window\.prompt/);
  assert.match(editProfileSource, /Save profile/);
  assert.match(editProfileSource, /resourceOptionLabel/);
});

test("admin user and resource edits use inline forms instead of browser prompt dialogs", () => {
  const script = fs.readFileSync(path.join(__dirname, "../public/app.js"), "utf8");

  assert.doesNotMatch(script, /window\.prompt/);
  assert.match(script, /data-user-editor/);
  assert.match(script, /Save user/);
  assert.match(script, /data-resource-editor/);
  assert.match(script, /Save resource/);
});

test("resource create and edit forms expose description and version metadata", () => {
  const script = fs.readFileSync(path.join(__dirname, "../public/app.js"), "utf8");
  const createStart = script.indexOf("function renderResourceForm");
  const createEnd = script.indexOf("\nasync function loadDashboard", createStart);
  const editStart = script.indexOf("async function editResource");
  const editEnd = script.indexOf("\nasync function containerAction", editStart);
  assert.notEqual(createStart, -1);
  assert.notEqual(createEnd, -1);
  assert.notEqual(editStart, -1);
  assert.notEqual(editEnd, -1);

  const createSource = script.slice(createStart, createEnd);
  const editSource = script.slice(editStart, editEnd);
  assert.match(createSource, /name: "description"/);
  assert.match(createSource, /name: "version"/);
  assert.match(createSource, /name: "visibility"/);
  assert.match(editSource, /name: "type"/);
  assert.match(editSource, /name: "visibility"/);
  assert.match(editSource, /name: "description"/);
  assert.match(editSource, /name: "version"/);
  assert.match(editSource, /type: String\(formData\.get\("type"\) \|\| resource\.type\)/);
  assert.match(editSource, /visibility: String\(formData\.get\("visibility"\) \|\| resource\.visibility\)/);
  assert.match(editSource, /description: String\(formData\.get\("description"\) \|\| ""\)/);
  assert.match(editSource, /version: String\(formData\.get\("version"\) \|\| ""\)/);
});

test("employee dashboard hides admin-only system configuration", async () => {
  const dashboard = await renderDashboardFor({
    id: "usr_alice",
    username: "alice",
    displayName: "Alice",
    role: "employee",
    mustChangePassword: false,
  });
  const text = collectText(dashboard);

  assert.match(text, /My container/);
  assert.match(text, /My container health/);
  assert.match(text, /My profiles/);
  assert.match(text, /Chat bindings/);
  assert.match(text, /Skill\/MCP library/);
  assert.doesNotMatch(text, /Employee containers/);
  assert.doesNotMatch(text, /Hermes profiles/);
  assert.doesNotMatch(text, /Resource library/);
  assert.doesNotMatch(text, /System configuration/);
  assert.doesNotMatch(text, /Docker mode/);
  assert.doesNotMatch(text, /Private model endpoint/);
  assert.doesNotMatch(text, /Public access/);
});

test("employee dashboard hides profile creation until container is ready", async () => {
  const dashboard = await renderDashboardFor(
    {
      id: "usr_alice",
      username: "alice",
      displayName: "Alice",
      role: "employee",
      mustChangePassword: false,
    },
    {
      containers: [
        {
          id: "ctr_alice",
          containerName: "hermes-alice",
          ownerId: "usr_alice",
          status: "created",
          health: "starting",
          llm: { model: "qwen3.6-35b-a3b" },
        },
      ],
    },
  );
  const text = collectText(dashboard);

  assert.match(text, /Container must be running and ready/);
  assert.doesNotMatch(text, /Create profile/);
});

test("dashboard lifecycle failures render an error instead of rejecting", async () => {
  const context = await runDashboardActionFailure('containerAction("ctr_alice", "reset")');

  assert.equal(context.__rejected, undefined);
  assert.equal(context.__resolved, true);
  assert.equal(context.__loadCalled, undefined);
  assert.equal(context.__errorNode.textContent, "Docker failed safely");
});

test("dashboard renders container reconciliation warnings", async () => {
  const dashboard = await renderDashboardFor(
    {
      id: "usr_admin",
      username: "admin",
      displayName: "Admin",
      role: "admin",
      mustChangePassword: false,
    },
    {
      containerWarnings: [
        {
          containerId: "ctr_alice",
          reason: "Docker status unavailable.",
        },
      ],
    },
  );
  const text = collectText(dashboard);

  assert.match(text, /Container warnings/);
  assert.match(text, /hermes-alice/);
  assert.match(text, /Docker status unavailable\./);
});
