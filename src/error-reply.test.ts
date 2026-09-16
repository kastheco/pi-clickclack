import assert from "node:assert/strict";
import test from "node:test";
import { errorReply } from "./error-reply.js";

test("surfaces the cache error, correlation reference and non-destructive recovery", () => {
  const message = "Anthropic cache lineage diverged before transport: message history is not append-only";
  const reply = errorReply("pi couldn't complete that turn.", new Error(message), "turn_test");
  assert.ok(reply.includes(message));
  assert.match(reply, /`\/compact`, then `\/continue`/u);
  assert.match(reply, /reference: turn_test/u);
});

test("redacts credentials before truncation and removes response bodies and stacks", () => {
  const reply = errorReply("failed", new Error('OAuth failed known-credential ccb_secret sk-ant-secret Bearer bearer-secret token=opaque-secret "password":"a long secret" https://user:pass@host/path?key=url-secret; body={"private":"response"}; stack=private stack'), "turn_test", ["known-credential"]);
  for (const secret of ["known-credential", "ccb_secret", "sk-ant-secret", "bearer-secret", "opaque-secret", "a long secret", "url-secret", "response", "private stack"]) assert.ok(!reply.includes(secret), secret);
  assert.match(reply, /OAuth failed/u);
  assert.match(reply, /REDACTED/u);
});

test("never serializes unknown objects, bounds messages and renders them inertly", () => {
  assert.match(errorReply("failed", { token: "hidden" }, "turn_test"), /unknown error/u);
  const reply = errorReply("failed", new Error('<script>\n```\n@everyone ' + "x".repeat(4000)), "turn_test");
  assert.ok(reply.length < 1300);
  assert.match(reply, /\n\n    <script> ``` @everyone/u);
  assert.ok(!reply.includes("\n```"));
});

test("redacts environment secrets even when no explicit list is passed", () => {
  process.env.PI_ERROR_TEST_TOKEN = "opaque-environment-value";
  try {
    assert.ok(!errorReply("failed", "opaque-environment-value", "turn_test").includes("opaque-environment-value"));
  } finally {
    delete process.env.PI_ERROR_TEST_TOKEN;
  }
});
