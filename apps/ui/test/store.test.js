const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { JsonStore, normalizeUsernameSlug } = require("../src/store");

function tempStore(overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-platform-store-"));
  const store = new JsonStore(path.join(dir, "state.json"), {
    bootstrapAdminUsername: "admin",
    bootstrapAdminPassword: "admin-bootstrap-password",
    sessionTtlHours: 1,
    hermesImage: "hermes:latest",
    llmBaseUrl: "http://192.168.100.12:8000/v1",
    llmModel: "qwen3.6-35b-a3b",
    ...overrides,
  });
  return { dir, store };
}

test("username slugs are docker-safe and empty slugs are rejected", () => {
  assert.equal(normalizeUsernameSlug("Alice.Zhang"), "alice-zhang");
  assert.equal(normalizeUsernameSlug(" 张 三 "), "");
});

test("bootstrap admin password must satisfy the admin minimum length", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-platform-store-"));
  try {
    assert.throws(
      () =>
        new JsonStore(path.join(dir, "state.json"), {
          bootstrapAdminUsername: "admin",
          bootstrapAdminPassword: "admin-pass1",
          sessionTtlHours: 1,
          hermesImage: "hermes:latest",
          llmBaseUrl: "http://192.168.100.12:8000/v1",
          llmModel: "qwen3.6-35b-a3b",
        }),
      /admin password must be at least 12 characters/i,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("creating an employee creates exactly one deterministic container record", async () => {
  const { dir, store } = tempStore();
  try {
    const employee = await store.createUser({
      username: "Alice",
      displayName: "Alice Zhang",
      password: "employee-password",
      role: "employee",
    });

    assert.equal(employee.usernameSlug, "alice");
    assert.equal(employee.mustChangePassword, true);
    const containers = store.listContainers().filter((container) => container.ownerId === employee.id);
    assert.equal(containers.length, 1);
    assert.equal(containers[0].containerName, "hermes-alice");
    assert.equal(containers[0].status, "defined");

    await assert.rejects(
      () =>
        store.createUser({
          username: "alice!",
          displayName: "Collision",
          password: "employee-password",
          role: "employee",
        }),
      /username slug already exists/i,
    );

    await assert.rejects(
      () =>
        store.createUser({
          username: "张三",
          displayName: "张三",
          password: "employee-password",
          role: "employee",
        }),
      /at least one ASCII letter or digit/i,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("final admin cannot be deleted or downgraded", async () => {
  const { dir, store } = tempStore();
  try {
    await assert.rejects(() => store.deleteUser("usr_admin"), /final admin/i);
    await assert.rejects(() => store.updateUser("usr_admin", { role: "employee" }), /final admin/i);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("state writes are serialized and written atomically", async () => {
  const { dir, store } = tempStore();
  try {
    await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        store.createResource(
          {
            type: index % 2 === 0 ? "skill" : "mcp",
            name: `resource-${index}`,
            visibility: "company",
            packageRef: `pkg/${index}`,
          },
          "usr_admin",
        ),
      ),
    );

    assert.equal(store.listResources().length, 8);
    const raw = fs.readFileSync(path.join(dir, "state.json"), "utf8");
    const parsed = JSON.parse(raw);
    assert.equal(parsed.resources.length, 8);
    assert.equal(fs.existsSync(path.join(dir, "state.json.tmp")), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("startup recovery marks stale in-progress containers and profiles as error", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-platform-store-"));
  const dataFile = path.join(dir, "state.json");
  try {
    fs.writeFileSync(
      dataFile,
      `${JSON.stringify({
        version: 1,
        users: [],
        containers: [
          {
            id: "ctr_stale",
            ownerId: "usr_alice",
            containerName: "hermes-alice",
            status: "resetting",
            operationId: "stale-container-op",
          },
        ],
        profiles: [
          {
            id: "pro_stale",
            containerId: "ctr_stale",
            ownerId: "usr_alice",
            slug: "sales",
            displayName: "Sales",
            enabled: true,
            status: "applying",
            operationId: "stale-profile-op",
          },
        ],
        resources: [],
        sessions: [],
        executions: [],
        audit: [],
      }, null, 2)}\n`,
    );

    const store = new JsonStore(dataFile, {
      bootstrapAdminUsername: "admin",
      bootstrapAdminPassword: "admin-bootstrap-password",
      sessionTtlHours: 1,
      hermesImage: "hermes:latest",
      llmBaseUrl: "http://192.168.100.12:8000/v1",
      llmModel: "qwen3.6-35b-a3b",
    });

    const [container] = store.listContainers();
    const [profile] = store.listProfiles();
    assert.equal(container.status, "error");
    assert.equal(container.operationId, null);
    assert.match(container.recoveryNote, /Recovered stale in-progress state/);
    assert.equal(profile.status, "error");
    assert.equal(profile.operationId, null);
    assert.match(profile.recoveryNote, /Recovered stale in-progress state/);

    const persisted = JSON.parse(fs.readFileSync(dataFile, "utf8"));
    assert.equal(persisted.containers[0].status, "error");
    assert.equal(persisted.profiles[0].status, "error");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("execution retention preserves the newest 200 records per owner", async () => {
  const { dir, store } = tempStore();
  try {
    async function append(ownerId, index) {
      await store.appendExecution({
        actorId: ownerId,
        ownerId,
        targetType: "container",
        targetId: `ctr_${ownerId}`,
        operation: `container.test.${index}`,
        mode: "dry-run",
        redactedCommand: "docker start hermes-test",
        exitCode: 0,
      });
    }

    for (let index = 0; index < 200; index += 1) {
      await append("usr_alice", index);
    }
    for (let index = 0; index < 2001; index += 1) {
      await append("usr_bob", index);
    }

    const executions = store.listExecutions();
    assert.equal(executions.filter((execution) => execution.ownerId === "usr_alice").length, 200);
    assert.ok(executions.filter((execution) => execution.ownerId === "usr_bob").length >= 200);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("expired sessions are rejected during authentication lookup", async () => {
  const { dir, store } = tempStore({ sessionTtlHours: 0.000001 });
  try {
    const session = await store.createSession("usr_admin");
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(await store.getSession(session.token), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
