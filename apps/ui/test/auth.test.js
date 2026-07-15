const assert = require("node:assert/strict");
const test = require("node:test");

const { hashPassword, verifyPassword } = require("../src/auth");

test("password hashes verify the original password only", () => {
  const stored = hashPassword("correct horse battery staple");

  assert.equal(verifyPassword("correct horse battery staple", stored), true);
  assert.equal(verifyPassword("correct horse battery staples", stored), false);
  assert.notEqual(stored.hash, "correct horse battery staple");
  assert.equal(typeof stored.salt, "string");
});
