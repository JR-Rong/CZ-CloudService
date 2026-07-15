const state = {
  user: null,
  users: [],
  csrfToken: "",
  containers: [],
  containerWarnings: [],
  profiles: [],
  resources: [],
  executions: [],
  system: null,
};

const CHAT_BINDING_PLATFORMS = [
  { value: "wechat", label: "WeChat" },
  { value: "feishu", label: "Feishu" },
  { value: "wecom", label: "WeCom" },
  { value: "qq", label: "QQ" },
];

async function api(path, options = {}) {
  const response = await fetch(path, {
    method: options.method || "GET",
    headers: {
      "content-type": "application/json",
      ...(options.body ? { "x-csrf-token": state.csrfToken } : {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};
  if (!response.ok) {
    throw new Error(payload.error || `Request failed with ${response.status}`);
  }
  return payload;
}

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key.startsWith("on")) node.addEventListener(key.slice(2).toLowerCase(), value);
    else node.setAttribute(key, value);
  }
  for (const child of children) {
    node.append(child);
  }
  return node;
}

function statusDot(status) {
  return el("span", { class: `dot ${status || "unknown"}`, title: status || "unknown" });
}

function renderLogin(error = "") {
  document.querySelector("#app").innerHTML = `
    <section class="login-view" aria-labelledby="login-title">
      <div class="login-panel">
        <p class="product-mark">CZ CloudService</p>
        <h1 id="login-title">Hermes Agent 管理平台</h1>
        <form id="login-form" class="form-grid">
          <label><span>Username</span><input name="username" autocomplete="username" required /></label>
          <label><span>Password</span><input name="password" type="password" autocomplete="current-password" required /></label>
          <button type="submit">Login</button>
        </form>
        <p id="login-error" class="error-text" role="alert">${error}</p>
      </div>
    </section>
  `;
  document.querySelector("#login-form").addEventListener("submit", handleLogin);
}

function renderPasswordChange() {
  document.querySelector("#app").replaceChildren(
    el("section", { class: "workspace narrow" }, [
      el("header", { class: "topbar" }, [
        el("div", {}, [
          el("p", { class: "product-mark", text: "CZ CloudService" }),
          el("h1", { text: "Hermes Agent 管理平台" }),
        ]),
        el("button", { onClick: logout, text: "Logout" }),
      ]),
      el("form", { id: "password-form", class: "panel form-grid" }, [
        el("h2", { text: "Change password" }),
        el("label", {}, [
          el("span", { text: "Current password" }),
          el("input", { name: "currentPassword", type: "password", required: "true" }),
        ]),
        el("label", {}, [
          el("span", { text: "New password" }),
          el("input", { name: "newPassword", type: "password", required: "true" }),
        ]),
        el("button", { type: "submit", text: "Update password" }),
        el("p", { id: "password-error", class: "error-text" }),
      ]),
    ]),
  );
  document.querySelector("#password-form").addEventListener("submit", handlePasswordChange);
}

function metric(label, value) {
  return el("div", { class: "metric" }, [el("span", { text: label }), el("strong", { text: String(value) })]);
}

function statusSummary(items, field) {
  const counts = new Map();
  for (const item of items) {
    const key = item[field] || "unknown";
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return [...counts.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([status, count]) => `${status}: ${count}`)
    .join(", ") || "none";
}

function actionButton(label, handler, disabled = false, title = "") {
  return el("button", {
    class: "small",
    disabled: disabled ? "true" : null,
    title,
    onClick: handler,
    text: label,
  });
}

function setDashboardError(message = "") {
  const node = document.querySelector("#dashboard-error");
  if (node) node.textContent = message;
}

async function runDashboardMutation(task) {
  try {
    setDashboardError("");
    await task();
    await loadDashboard();
  } catch (error) {
    setDashboardError(error.message || "Request failed");
  }
}

function containerForProfile(profile) {
  return state.containers.find((container) => container.id === profile.containerId) || null;
}

function containerIsRunningReady(container) {
  return container?.status === "running" && container.health === "ready";
}

function profileActionBlockReason(profile) {
  const container = containerForProfile(profile);
  if (!profile.enabled) return "Profile is disabled";
  if (!container) return "Container is not visible";
  if (!containerIsRunningReady(container)) {
    return "Container must be running and ready";
  }
  return "";
}

function profileApplyBlockReason(profile) {
  const container = containerForProfile(profile);
  if (!container) return "Container is not visible";
  if (!containerIsRunningReady(container)) {
    return "Container must be running and ready";
  }
  return "";
}

function resourceOptionLabel(resource) {
  const version = resource.version || "unversioned";
  return `${resource.name} | ${resource.type} | ${resource.visibility} | owner ${resource.ownerId} | ${resource.packageRef} | version ${version}`;
}

function bindingByPlatform(bindings = []) {
  return new Map((bindings || []).map((binding) => [binding.platform, binding]));
}

function renderChatBindingFields(bindings = []) {
  const current = bindingByPlatform(bindings);
  return CHAT_BINDING_PLATFORMS.map(({ value, label }) => {
    const binding = current.get(value) || {};
    return el("fieldset", { class: "binding-fields" }, [
      el("legend", { text: label }),
      el("input", {
        name: `${value}DisplayName`,
        placeholder: `${label} display name`,
        value: binding.displayName || "",
      }),
      el("input", {
        name: `${value}ExternalRef`,
        placeholder: `${value} external ref`,
        value: binding.externalRef || "",
      }),
      el("input", {
        name: `${value}CredentialRef`,
        placeholder: `secret://${value}/name`,
        value: binding.credentialRef || "",
      }),
    ]);
  });
}

function collectChatBindingsFromFormData(formData, existingBindings = []) {
  const current = bindingByPlatform(existingBindings);
  return CHAT_BINDING_PLATFORMS.map(({ value }) => {
    const existing = current.get(value) || {};
    const displayName = String(formData.get(`${value}DisplayName`) || "").trim();
    const externalRef = String(formData.get(`${value}ExternalRef`) || "").trim();
    const credentialRef = String(formData.get(`${value}CredentialRef`) || "").trim();
    if (!displayName && !externalRef && !credentialRef) {
      return null;
    }
    return {
      id: existing.id,
      platform: value,
      displayName: displayName || existing.displayName || value,
      externalRef,
      credentialRef,
      enabled: existing.enabled !== false,
    };
  }).filter(Boolean);
}

function removeChatBindingFormFields(body) {
  for (const { value } of CHAT_BINDING_PLATFORMS) {
    delete body[`${value}DisplayName`];
    delete body[`${value}ExternalRef`];
    delete body[`${value}CredentialRef`];
  }
}

function dashboardLabel(adminLabel, employeeLabel) {
  return state.user.role === "admin" ? adminLabel : employeeLabel;
}

function renderUsers() {
  if (state.user.role !== "admin") return null;
  const rows = state.users.map((user) =>
    el("tr", {}, [
      el("td", { text: user.username }),
      el("td", { text: user.displayName }),
      el("td", { text: user.role }),
      el("td", { text: user.mustChangePassword ? "must change" : "current" }),
      el("td", { class: "actions" }, [
        actionButton("Rename", (event) => editUser(user, "rename", event)),
        actionButton("Reset password", (event) => editUser(user, "password", event)),
        actionButton(user.role === "admin" ? "Make employee" : "Make admin", () =>
          updateUser(user.id, { role: user.role === "admin" ? "employee" : "admin" }),
        ),
        actionButton(
          "Delete user",
          () => confirmAction(`Delete user ${user.username}?`, () => deleteUser(user.id)),
          user.id === state.user.id,
          user.id === state.user.id ? "You cannot delete your active account" : "",
        ),
      ]),
    ]),
  );
  return table(["Username", "Display name", "Role", "Password", "Actions"], rows);
}

function renderContainers() {
  const rows = state.containers.map((container) =>
    el("tr", {}, [
      el("td", {}, [statusDot(container.health), document.createTextNode(container.containerName)]),
      el("td", { text: container.status }),
      el("td", { text: container.health }),
      el("td", { text: container.llm?.model || "" }),
      el("td", { class: "actions" }, [
        actionButton("Start", () => containerAction(container.id, "start")),
        actionButton("Stop", () => containerAction(container.id, "stop")),
        actionButton("Restart", () => containerAction(container.id, "restart")),
        ...(state.user.role === "admin"
          ? [
              actionButton("Create", () => containerAction(container.id, "create")),
              actionButton("Reset", () => confirmAction(`Reset ${container.containerName}?`, () => containerAction(container.id, "reset"))),
              actionButton("Delete", () => confirmAction(`Delete ${container.containerName}?`, () => containerAction(container.id, "delete"))),
            ]
          : []),
      ]),
    ]),
  );
  return table(["Container", "Status", "Health", "Model", "Actions"], rows);
}

function renderContainerWarnings() {
  if (!state.containerWarnings.length) return null;
  const containerNames = new Map(state.containers.map((container) => [container.id, container.containerName]));
  const rows = state.containerWarnings.map((warning) =>
    el("tr", {}, [
      el("td", { text: containerNames.get(warning.containerId) || warning.containerId || "unknown" }),
      el("td", { text: warning.reason || "Docker status unavailable." }),
    ]),
  );
  return el("section", { class: "panel warning-panel" }, [
    el("h2", { text: "Container warnings" }),
    table(["Container", "Warning"], rows),
  ]);
}

function renderProfiles() {
  const rows = state.profiles.map((profile) => {
    const container = containerForProfile(profile);
    const blockReason = profileActionBlockReason(profile);
    const applyBlockReason = profileApplyBlockReason(profile);
    const blocked = Boolean(blockReason);
    const applyBlocked = Boolean(applyBlockReason);
    return el("tr", {}, [
      el("td", {}, [statusDot(profile.status), document.createTextNode(profile.displayName)]),
      el("td", { text: container?.containerName || profile.containerName || "" }),
      el("td", { text: profile.slug }),
      el("td", { text: profile.enabled ? "enabled" : "disabled" }),
      el("td", { text: profile.status }),
      el("td", { class: "actions" }, [
        actionButton("Edit profile", (event) => editProfile(profile, event)),
        actionButton(profile.enabled ? "Disable" : "Enable", () => updateProfile(profile.id, { enabled: !profile.enabled })),
        ...(profile.status === "error"
          ? [actionButton("Retry apply", () => profileAction(profile.id, "create"), applyBlocked, applyBlockReason)]
          : []),
        actionButton("Start", () => profileAction(profile.id, "start"), blocked, blockReason),
        actionButton("Stop", () => profileAction(profile.id, "stop"), blocked, blockReason),
        actionButton("Restart", () => profileAction(profile.id, "restart"), blocked, blockReason),
        actionButton("Delete", () => confirmAction(`Delete ${profile.displayName}?`, () => deleteProfile(profile.id))),
        ...(blocked || (profile.status === "error" && applyBlocked)
          ? [el("span", { class: "error-text", text: blockReason || applyBlockReason })]
          : []),
      ]),
    ]);
  });
  return table(["Profile", "Container", "Slug", "Enabled", "Status", "Actions"], rows);
}

function canManageResource(resource) {
  return state.user.role === "admin" || resource.ownerId === state.user.id;
}

function renderResources() {
  const rows = state.resources.map((resource) => {
    const actions = canManageResource(resource)
      ? [
          actionButton("Edit resource", (event) => editResource(resource, event)),
          actionButton(resource.visibility === "company" ? "Make private" : "Share company", () =>
            updateResource(resource.id, { visibility: resource.visibility === "company" ? "private" : "company" }),
          ),
          actionButton("Delete resource", () =>
            confirmAction(`Delete resource ${resource.name}?`, () => deleteResource(resource.id)),
          ),
        ]
      : [];
    return el("tr", {}, [
      el("td", { text: resource.name }),
      el("td", { text: resource.type }),
      el("td", { text: resource.ownerId }),
      el("td", { text: resource.visibility }),
      el("td", { text: resource.packageRef }),
      el("td", { text: resource.version || "unversioned" }),
      el("td", { class: "actions" }, actions),
    ]);
  });
  return table(["Name", "Type", "Resource owner", "Visibility", "Package", "Version", "Actions"], rows);
}

function renderSystemSummary() {
  const system = state.system || {};
  const privateModel = system.privateModel || {};
  return el("dl", { class: "summary-grid" }, [
    el("dt", { text: "Docker mode" }),
    el("dd", { text: system.dockerMode || "unknown" }),
    el("dt", { text: "Private model endpoint" }),
    el("dd", { text: privateModel.baseUrl || "" }),
    el("dt", { text: "Private model name" }),
    el("dd", { text: privateModel.model || "" }),
    el("dt", { text: "OPENAI_API_KEY" }),
    el("dd", { text: privateModel.apiKey || "<redacted>" }),
    el("dt", { text: "Public access" }),
    el("dd", { text: system.publicAccess || "" }),
  ]);
}

function renderExecutions() {
  const rows = state.executions.slice(0, 12).map((execution) =>
    el("tr", {}, [
      el("td", { text: execution.operation }),
      el("td", { text: execution.targetType }),
      el("td", { text: String(execution.exitCode) }),
      el("td", { text: execution.mode }),
      el("td", { text: execution.redactedCommand }),
    ]),
  );
  return table(["Operation", "Target", "Exit", "Mode", "Command"], rows);
}

function table(headers, rows) {
  return el("table", {}, [
    el("thead", {}, [el("tr", {}, headers.map((header) => el("th", { text: header })))]),
    el("tbody", {}, rows.length ? rows : [el("tr", {}, [el("td", { colspan: headers.length, text: "No records" })])]),
  ]);
}

function renderAdminForms() {
  if (state.user.role !== "admin") return [];
  return [
    el("form", { id: "user-form", class: "panel form-inline" }, [
      el("h2", { text: "Employee accounts" }),
      el("input", { name: "username", placeholder: "username", required: "true" }),
      el("input", { name: "displayName", placeholder: "display name" }),
      el("input", { name: "password", placeholder: "initial password", type: "password", required: "true" }),
      el("button", { type: "submit", text: "Create employee" }),
    ]),
  ];
}

function renderProfileForm() {
  if (!state.containers.length) return null;
  const availableContainers = state.containers.filter(containerIsRunningReady);
  if (!availableContainers.length) {
    return el("section", { class: "panel" }, [
      el("h2", { text: dashboardLabel("Profiles", "My profiles") }),
      el("p", { class: "error-text", text: "Container must be running and ready" }),
    ]);
  }
  const containerOptions = availableContainers.map((container) =>
    el("option", { value: container.id, text: container.containerName }),
  );
  const resourceOptions = state.resources.map((resource) =>
    el("option", {
      value: resource.id,
      text: resourceOptionLabel(resource),
    }),
  );
  return el("form", { id: "profile-form", class: "panel form-inline" }, [
    el("h2", { text: dashboardLabel("Profiles", "My profiles") }),
    el("select", { name: "containerId" }, containerOptions),
    el("input", { name: "slug", placeholder: "sales-assistant", required: "true" }),
    el("input", { name: "displayName", placeholder: "Sales Assistant", required: "true" }),
    el("input", { name: "description", placeholder: "Description" }),
    el("h3", { text: "Chat bindings" }),
    ...renderChatBindingFields([]),
    el("select", { name: "resourceIds", multiple: "true", size: "3" }, resourceOptions),
    el("button", { type: "submit", text: "Create profile" }),
  ]);
}

function renderResourceForm() {
  return el("form", { id: "resource-form", class: "panel form-inline" }, [
    el("h2", { text: dashboardLabel("Skill/MCP resources", "Skill/MCP library") }),
    el("select", { name: "type" }, [el("option", { value: "skill", text: "skill" }), el("option", { value: "mcp", text: "mcp" })]),
    el("input", { name: "name", placeholder: "contract-review", required: "true" }),
    el("input", { name: "description", placeholder: "Internal contract review helper" }),
    el("input", { name: "packageRef", placeholder: "skills/contract-review" }),
    el("input", { name: "version", placeholder: "0.1.0" }),
    el("select", { name: "visibility" }, [el("option", { value: "private", text: "private" }), el("option", { value: "company", text: "company" })]),
    el("button", { type: "submit", text: "Save resource" }),
  ]);
}

async function loadDashboard() {
  const me = await api("/api/me");
  state.user = me.user;
  state.csrfToken = me.csrfToken;
  if (state.user.mustChangePassword) {
    renderPasswordChange();
    return;
  }
  const containers = await api("/api/containers");
  const resources = await api("/api/resources");
  const system = state.user.role === "admin" ? await api("/api/system") : null;
  const executions = await api("/api/executions");
  const users = state.user.role === "admin" ? await api("/api/users") : { users: [] };
  state.containers = containers.containers;
  state.containerWarnings = containers.warnings || [];
  state.resources = resources.resources;
  state.system = system;
  state.executions = executions.executions;
  state.users = users.users;
  const profileGroups = await Promise.all(state.containers.map(async (container) => {
    const profiles = await api(`/api/containers/${container.id}/profiles`);
    return profiles.profiles.map((profile) => ({ ...profile, containerName: container.containerName }));
  }));
  state.profiles = profileGroups.flat();

  const app = document.querySelector("#app");
  app.replaceChildren(
    el("section", { class: "workspace" }, [
      el("header", { class: "topbar" }, [
        el("div", {}, [
          el("p", { class: "product-mark", text: "CZ CloudService" }),
          el("h1", { text: "Hermes Agent 管理平台" }),
        ]),
        el("div", { class: "userbar" }, [
          el("span", { text: `${state.user.displayName} · ${state.user.role}` }),
          el("button", { onClick: logout, text: "Logout" }),
        ]),
      ]),
      el("section", { class: "metrics" }, [
        metric("Employees", state.user.role === "admin" ? state.users.filter((item) => item.role === "employee").length : 1),
        metric("Containers", state.containers.length),
        metric("Container statuses", statusSummary(state.containers, "status")),
        metric(dashboardLabel("Container health summary", "My container health"), statusSummary(state.containers, "health")),
        metric("Ready", state.containers.filter((item) => item.health === "ready").length),
        metric("Profiles", state.profiles.length),
        metric("Profile statuses", statusSummary(state.profiles, "status")),
        metric("Resources", state.resources.length),
        ...(state.user.role === "admin" ? [metric("Docker mode", state.system?.dockerMode || "dry-run")] : []),
      ]),
      ...renderAdminForms(),
      state.user.role === "admin"
        ? el("section", { class: "panel" }, [el("h2", { text: "Employee accounts" }), renderUsers()])
        : null,
      renderProfileForm(),
      renderResourceForm(),
      renderContainerWarnings(),
      el("section", { class: "panel" }, [el("h2", { text: dashboardLabel("Employee containers", "My container") }), renderContainers()]),
      el("section", { class: "panel" }, [el("h2", { text: dashboardLabel("Hermes profiles", "My profiles") }), renderProfiles()]),
      el("section", { class: "panel" }, [el("h2", { text: dashboardLabel("Skill/MCP resources", "Skill/MCP library") }), renderResources()]),
      state.user.role === "admin"
        ? el("section", { class: "panel" }, [el("h2", { text: "System configuration" }), renderSystemSummary()])
        : null,
      el("section", { class: "panel" }, [el("h2", { text: "Execution history" }), renderExecutions()]),
      el("p", { id: "dashboard-error", class: "error-text" }),
    ].filter(Boolean)),
  );
  bindDashboardForms();
}

function bindDashboardForms() {
  document.querySelector("#user-form")?.addEventListener("submit", createEmployee);
  document.querySelector("#profile-form")?.addEventListener("submit", createProfile);
  document.querySelector("#resource-form")?.addEventListener("submit", createResource);
}

async function handleLogin(event) {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  try {
    const login = await api("/api/login", {
      method: "POST",
      body: Object.fromEntries(form),
    });
    state.user = login.user;
    state.csrfToken = login.csrfToken;
    await loadDashboard();
  } catch (error) {
    renderLogin(error.message);
  }
}

async function handlePasswordChange(event) {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  try {
    const result = await api("/api/me/password", { method: "POST", body: Object.fromEntries(form) });
    state.user = result.user;
    state.csrfToken = result.csrfToken;
    await loadDashboard();
  } catch (error) {
    document.querySelector("#password-error").textContent = error.message;
  }
}

async function createEmployee(event) {
  event.preventDefault();
  const body = Object.fromEntries(new FormData(event.currentTarget));
  body.role = "employee";
  await runDashboardMutation(() => api("/api/users", { method: "POST", body }));
}

async function createProfile(event) {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const body = Object.fromEntries(form);
  const containerId = body.containerId || state.containers[0]?.id;
  body.resourceIds = form.getAll("resourceIds").filter(Boolean);
  body.bindings = collectChatBindingsFromFormData(form, []);
  delete body.containerId;
  removeChatBindingFormFields(body);
  await runDashboardMutation(() => api(`/api/containers/${containerId}/profiles`, { method: "POST", body }));
}

async function createResource(event) {
  event.preventDefault();
  const body = Object.fromEntries(new FormData(event.currentTarget));
  await runDashboardMutation(() => api("/api/resources", { method: "POST", body }));
}

async function updateUser(id, body) {
  await runDashboardMutation(() => api(`/api/users/${id}`, { method: "PUT", body }));
}

function removeUserEditor() {
  document.querySelector("[data-user-editor]")?.remove();
}

async function editUser(user, mode, event) {
  removeUserEditor();
  const row = event?.currentTarget?.closest("tr");
  if (!row) return;
  const resetPassword = mode === "password";
  const editor = el("tr", { "data-user-editor": user.id }, [
    el("td", { colspan: "5" }, [
      el("form", { class: "form-grid profile-editor" }, [
        el("h3", { text: resetPassword ? `Reset password for ${user.username}` : `Rename ${user.username}` }),
        resetPassword
          ? el("label", {}, [
              el("span", { text: "New password" }),
              el("input", { name: "password", type: "password", required: "true" }),
            ])
          : el("label", {}, [
              el("span", { text: "Display name" }),
              el("input", { name: "displayName", value: user.displayName || "", required: "true" }),
            ]),
        el("div", { class: "actions" }, [
          el("button", { type: "submit", text: "Save user" }),
          el("button", { type: "button", onClick: removeUserEditor, text: "Cancel" }),
        ]),
      ]),
    ]),
  ]);
  row.after(editor);
  editor.querySelector("form").addEventListener("submit", async (submitEvent) => {
    submitEvent.preventDefault();
    const formData = new FormData(submitEvent.currentTarget);
    const body = resetPassword
      ? { password: String(formData.get("password") || "") }
      : { displayName: String(formData.get("displayName") || "") };
    await updateUser(user.id, body);
  });
}

async function deleteUser(id) {
  await runDashboardMutation(() => api(`/api/users/${id}`, { method: "DELETE", body: {} }));
}

async function updateProfile(id, body) {
  await runDashboardMutation(() => api(`/api/profiles/${id}`, { method: "PUT", body }));
}

function removeProfileEditor() {
  document.querySelector("[data-profile-editor]")?.remove();
}

async function editProfile(profile, event) {
  removeProfileEditor();
  const row = event?.currentTarget?.closest("tr");
  if (!row) return;
  const existingBindings = profile.bindings || [];
  const selectedResources = new Set(profile.resourceIds || []);
  const resourceOptions = state.resources.map((resource) =>
    el("option", {
      value: resource.id,
      text: resourceOptionLabel(resource),
      selected: selectedResources.has(resource.id) ? "true" : null,
    }),
  );
  const editor = el("tr", { "data-profile-editor": profile.id }, [
    el("td", { colspan: "6" }, [
      el("form", { class: "form-grid profile-editor" }, [
        el("h3", { text: `Edit ${profile.displayName}` }),
        el("label", {}, [
          el("span", { text: "Display name" }),
          el("input", { name: "displayName", value: profile.displayName, required: "true" }),
        ]),
        el("label", {}, [
          el("span", { text: "Description" }),
          el("input", { name: "description", value: profile.description || "" }),
        ]),
        el("h3", { text: "Chat bindings" }),
        ...renderChatBindingFields(existingBindings),
        el("label", {}, [
          el("span", { text: "Resource IDs" }),
          el("select", { name: "resourceIds", multiple: "true", size: "4" }, resourceOptions),
        ]),
        el("div", { class: "actions" }, [
          el("button", { type: "submit", text: "Save profile" }),
          el("button", { type: "button", onClick: removeProfileEditor, text: "Cancel" }),
        ]),
      ]),
    ]),
  ]);
  row.after(editor);
  editor.querySelector("form").addEventListener("submit", async (submitEvent) => {
    submitEvent.preventDefault();
    const form = submitEvent.currentTarget;
    const formData = new FormData(form);
    const update = {
      displayName: String(formData.get("displayName") || ""),
      description: String(formData.get("description") || ""),
      bindings: collectChatBindingsFromFormData(formData, existingBindings),
      resourceIds: [...form.querySelector('[name="resourceIds"]').selectedOptions].map((option) => option.value),
    };
    await updateProfile(profile.id, update);
  });
}

async function updateResource(id, body) {
  await runDashboardMutation(() => api(`/api/resources/${id}`, { method: "PUT", body }));
}

function removeResourceEditor() {
  document.querySelector("[data-resource-editor]")?.remove();
}

async function editResource(resource, event) {
  removeResourceEditor();
  const row = event?.currentTarget?.closest("tr");
  if (!row) return;
  const editor = el("tr", { "data-resource-editor": resource.id }, [
    el("td", { colspan: "6" }, [
      el("form", { class: "form-grid profile-editor" }, [
        el("h3", { text: `Edit ${resource.name}` }),
        el("label", {}, [
          el("span", { text: "Resource type" }),
          el("select", { name: "type" }, [
            el("option", { value: "skill", text: "skill", selected: resource.type === "skill" ? "true" : null }),
            el("option", { value: "mcp", text: "mcp", selected: resource.type === "mcp" ? "true" : null }),
          ]),
        ]),
        el("label", {}, [
          el("span", { text: "Resource name" }),
          el("input", { name: "name", value: resource.name, required: "true" }),
        ]),
        el("label", {}, [
          el("span", { text: "Visibility" }),
          el("select", { name: "visibility" }, [
            el("option", { value: "private", text: "private", selected: resource.visibility === "private" ? "true" : null }),
            el("option", { value: "company", text: "company", selected: resource.visibility === "company" ? "true" : null }),
          ]),
        ]),
        el("label", {}, [
          el("span", { text: "Description" }),
          el("input", { name: "description", value: resource.description || "" }),
        ]),
        el("label", {}, [
          el("span", { text: "Package reference" }),
          el("input", { name: "packageRef", value: resource.packageRef || "" }),
        ]),
        el("label", {}, [
          el("span", { text: "Version" }),
          el("input", { name: "version", value: resource.version || "" }),
        ]),
        el("div", { class: "actions" }, [
          el("button", { type: "submit", text: "Save resource" }),
          el("button", { type: "button", onClick: removeResourceEditor, text: "Cancel" }),
        ]),
      ]),
    ]),
  ]);
  row.after(editor);
  editor.querySelector("form").addEventListener("submit", async (submitEvent) => {
    submitEvent.preventDefault();
    const formData = new FormData(submitEvent.currentTarget);
    await updateResource(resource.id, {
      type: String(formData.get("type") || resource.type),
      visibility: String(formData.get("visibility") || resource.visibility),
      name: String(formData.get("name") || ""),
      description: String(formData.get("description") || ""),
      packageRef: String(formData.get("packageRef") || ""),
      version: String(formData.get("version") || ""),
    });
  });
}

async function containerAction(id, action) {
  await runDashboardMutation(() => api(`/api/containers/${id}/actions`, { method: "POST", body: { action } }));
}

async function profileAction(id, action) {
  await runDashboardMutation(() => api(`/api/profiles/${id}/actions`, { method: "POST", body: { action } }));
}

async function deleteProfile(id) {
  await runDashboardMutation(() => api(`/api/profiles/${id}`, { method: "DELETE", body: {} }));
}

async function deleteResource(id) {
  await runDashboardMutation(() => api(`/api/resources/${id}`, { method: "DELETE", body: {} }));
}

function confirmAction(message, fn) {
  if (window.confirm(message)) {
    return fn();
  }
  return undefined;
}

async function logout() {
  await api("/api/logout", { method: "POST", body: {} });
  state.user = null;
  state.csrfToken = "";
  renderLogin();
}

document.addEventListener("DOMContentLoaded", () => {
  api("/api/me")
    .then((me) => {
      state.user = me.user;
      state.csrfToken = me.csrfToken;
      return loadDashboard();
    })
    .catch(() => renderLogin());
});
