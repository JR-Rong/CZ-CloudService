const crypto = require("node:crypto");

const KEY_LENGTH = 64;
const SCRYPT_OPTIONS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  if (typeof password !== "string" || password.length < 8) {
    throw new Error("Password must be at least 8 characters.");
  }

  return {
    algorithm: "scrypt",
    salt,
    hash: crypto.scryptSync(password, salt, KEY_LENGTH, SCRYPT_OPTIONS).toString("hex"),
  };
}

function verifyPassword(password, stored) {
  if (!stored || stored.algorithm !== "scrypt" || !stored.salt || !stored.hash) {
    return false;
  }

  try {
    const attempted = hashPassword(password, stored.salt);
    const actual = Buffer.from(stored.hash, "hex");
    const expected = Buffer.from(attempted.hash, "hex");
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

function createSessionToken() {
  return crypto.randomBytes(32).toString("hex");
}

module.exports = {
  createSessionToken,
  hashPassword,
  verifyPassword,
};
