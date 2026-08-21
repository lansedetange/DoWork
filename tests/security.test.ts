import assert from "node:assert/strict";
import test from "node:test";
import { containsLikelySecret, isSensitivePath, redactSensitiveText } from "../src/main/security.ts";

test("recognizes sensitive workspace paths", () => {
  assert.equal(isSensitivePath(".env"), true);
  assert.equal(isSensitivePath("config/.env.production"), true);
  assert.equal(isSensitivePath("keys/service.pem"), true);
  assert.equal(isSensitivePath("src/index.ts"), false);
});

test("detects and redacts common credentials", () => {
  const value = "Authorization: Bearer secret-token-value and api_key=very-secret-value";
  assert.equal(containsLikelySecret(value), true);
  const redacted = redactSensitiveText(value);
  assert.doesNotMatch(redacted, /secret-token-value|very-secret-value/);
  assert.match(redacted, /\[REDACTED\]/);
});
