const assert = require("node:assert/strict");
const test = require("node:test");

const { resolveCredential, validateCredentialRef } = require("../src/secrets");

test("SecretResolver MVP validates references and never returns raw secrets", () => {
  assert.equal(validateCredentialRef("secret://feishu/sales-01"), true);
  assert.equal(validateCredentialRef("secret://public-openai/key"), false);
  assert.equal(validateCredentialRef("plain-token"), false);

  const result = resolveCredential("secret://feishu/sales-01", { id: "usr_alice" }, "profile-config");

  assert.deepEqual(result, {
    resolved: false,
    credentialRef: "secret://feishu/sales-01",
    reason: "secret-resolution-not-implemented",
  });
});
