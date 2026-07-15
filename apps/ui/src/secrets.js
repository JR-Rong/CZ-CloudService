const SUPPORTED_SECRET_PROVIDERS = new Set(["wechat", "feishu", "wecom", "qq"]);

function parseCredentialRef(credentialRef) {
  const match = String(credentialRef || "").match(/^secret:\/\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/);
  if (!match) {
    return null;
  }
  return {
    provider: match[1],
    name: match[2],
  };
}

function validateCredentialRef(credentialRef) {
  const parsed = parseCredentialRef(credentialRef);
  return Boolean(parsed && SUPPORTED_SECRET_PROVIDERS.has(parsed.provider));
}

function resolveCredential(credentialRef) {
  if (!validateCredentialRef(credentialRef)) {
    throw Object.assign(new Error("credentialRef must match secret://<provider>/<name>."), { status: 400 });
  }
  return {
    resolved: false,
    credentialRef,
    reason: "secret-resolution-not-implemented",
  };
}

module.exports = {
  parseCredentialRef,
  resolveCredential,
  validateCredentialRef,
};
