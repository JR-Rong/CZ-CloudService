#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const dataRoot = process.env.HERMES_PROFILE_DATA_DIR || "/data";
const profileRoot = path.join(dataRoot, "profiles");

function fail(code, message) {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

function print(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function ensureDataRoot() {
  fs.mkdirSync(profileRoot, { recursive: true, mode: 0o700 });
}

function assertSlug(slug) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(slug || "")) {
    fail(2, "invalid profile slug");
  }
}

function profilePath(slug) {
  assertSlug(slug);
  return path.join(profileRoot, `${slug}.json`);
}

function readProfile(slug) {
  const file = profilePath(slug);
  if (!fs.existsSync(file)) {
    return null;
  }
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function writeProfile(profile) {
  ensureDataRoot();
  const file = profilePath(profile.slug);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(profile, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function modelConfig() {
  const baseUrl = process.env.OPENAI_BASE_URL || "";
  const apiBase = process.env.OPENAI_API_BASE || "";
  const model = process.env.OPENAI_MODEL || "";
  const localModel = process.env.LOCAL_LLM_MODEL || "";

  if (
    !baseUrl ||
    !apiBase ||
    !model ||
    !localModel ||
    !process.env.OPENAI_API_KEY ||
    process.env.HERMES_PRIVATE_MODEL_ONLY !== "1" ||
    !process.env.HERMES_OWNER_ID ||
    !process.env.HERMES_EMPLOYEE_USERNAME
  ) {
    fail(20, "private model configuration is missing or invalid");
  }

  if (apiBase !== baseUrl || localModel !== model) {
    fail(20, "private model aliases do not match authoritative values");
  }

  return { baseUrl, model, privateOnly: true };
}

function nowIso() {
  return new Date().toISOString();
}

function parseCreateArgs(args) {
  let slug = "";
  let displayName = "";
  let configJson = "";

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--slug") {
      slug = args[++index] || "";
    } else if (arg === "--name") {
      displayName = args[++index] || "";
    } else if (arg === "--config-json") {
      configJson = args[++index] || "";
    } else {
      fail(2, `unsupported create argument: ${arg}`);
    }
  }

  assertSlug(slug);
  if (!displayName.trim()) {
    fail(2, "profile display name is required");
  }
  if (configJson !== "-") {
    fail(2, "create requires --config-json -");
  }

  return { slug, displayName };
}

function parsePayload(slug, displayName) {
  let payload;
  try {
    payload = JSON.parse(fs.readFileSync(0, "utf8"));
  } catch {
    fail(2, "invalid profile config json");
  }

  if (!payload || Array.isArray(payload) || typeof payload !== "object") {
    fail(2, "profile config must be a JSON object");
  }
  if (payload.version !== 1) {
    fail(2, "unsupported profile config version");
  }
  if (payload.slug !== slug) {
    fail(2, "profile config slug does not match command slug");
  }

  const privateModel = modelConfig();
  const payloadModel = payload.model || {};
  if (
    payloadModel.provider !== "openai-compatible" ||
    payloadModel.baseUrl !== privateModel.baseUrl ||
    payloadModel.model !== privateModel.model ||
    payloadModel.privateOnly !== true
  ) {
    fail(20, "profile config private model metadata is missing or invalid");
  }

  return {
    version: 1,
    slug,
    displayName,
    description: String(payload.description || ""),
    bindings: Array.isArray(payload.bindings) ? payload.bindings : [],
    resources: Array.isArray(payload.resources) ? payload.resources : [],
  };
}

function commandHealth(args) {
  if (args.length !== 1 || args[0] !== "--json") {
    fail(2, "health requires --json");
  }
  print({
    status: "ready",
    privateModel: modelConfig(),
  });
}

function commandCreate(args) {
  const { slug, displayName } = parseCreateArgs(args);
  const existing = readProfile(slug);
  const payload = parsePayload(slug, displayName);
  const next = {
    ...payload,
    status: existing ? existing.status : "stopped",
    updatedAt: nowIso(),
  };

  writeProfile(next);
  print({
    slug,
    displayName,
    status: next.status,
    updated: Boolean(existing),
    updatedAt: next.updatedAt,
  });
}

function commandList(args) {
  if (args.length !== 1 || args[0] !== "--json") {
    fail(2, "list requires --json");
  }
  ensureDataRoot();
  const profiles = fs.readdirSync(profileRoot)
    .filter((name) => name.endsWith(".json"))
    .map((name) => JSON.parse(fs.readFileSync(path.join(profileRoot, name), "utf8")))
    .sort((left, right) => left.slug.localeCompare(right.slug))
    .map((profile) => ({
      slug: profile.slug,
      displayName: profile.displayName,
      status: profile.status,
      updatedAt: profile.updatedAt,
    }));

  print({ version: 1, profiles });
}

function changeStatus(slug, status) {
  const profile = readProfile(slug);
  if (!profile) {
    fail(3, "profile not found");
  }

  const next = { ...profile, status, updatedAt: nowIso() };
  writeProfile(next);
  print({
    slug,
    status,
    updatedAt: next.updatedAt,
  });
}

function commandDelete(args) {
  if (args.length !== 1) {
    fail(2, "delete requires a profile slug");
  }
  const slug = args[0];
  const file = profilePath(slug);
  if (!fs.existsSync(file)) {
    print({ slug, missing: true });
    return;
  }
  fs.unlinkSync(file);
  print({ slug, deleted: true });
}

function main(argv) {
  const [command, ...args] = argv;

  if (command === "health") {
    commandHealth(args);
  } else if (command === "create") {
    commandCreate(args);
  } else if (command === "list") {
    commandList(args);
  } else if (command === "start") {
    if (args.length !== 1) fail(2, "start requires a profile slug");
    changeStatus(args[0], "running");
  } else if (command === "stop") {
    if (args.length !== 1) fail(2, "stop requires a profile slug");
    changeStatus(args[0], "stopped");
  } else if (command === "restart") {
    if (args.length !== 1) fail(2, "restart requires a profile slug");
    changeStatus(args[0], "running");
  } else if (command === "delete") {
    commandDelete(args);
  } else {
    fail(2, "unsupported hermes-profilectl command");
  }
}

main(process.argv.slice(2));
