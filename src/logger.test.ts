import assert from "node:assert/strict";
import test from "node:test";

import { createLogger, environmentSecretValues } from "./logger.js";

test("provider credentials are discovered from environment variable names", () => {
  assert.deepEqual(
    environmentSecretValues({
      OPENAI_API_KEY: "provider-key",
      CLICKCLACK_BOT_TOKEN: "bot-token",
      ORDINARY_SETTING: "visible",
    }),
    ["provider-key", "bot-token"],
  );
});

test("structured logs redact bot tokens and provider credentials", () => {
  const lines: string[] = [];
  const botToken = "ccb_this_must_never_be_logged";
  const providerCredential = "sk-provider-secret-123456789";
  const logger = createLogger({
    sink: (line) => lines.push(line),
    secretValues: [botToken, providerCredential],
    now: () => new Date("2026-01-01T00:00:00.000Z"),
  });

  logger.error(`request failed with Bearer ${botToken}`, {
    botToken,
    OPENAI_API_KEY: providerCredential,
    nested: { authorization: `Bearer ${botToken}` },
    error: new Error(`upstream echoed ${providerCredential}`),
  });

  const output = lines.join("\n");
  assert.doesNotMatch(output, /ccb_this_must_never_be_logged/u);
  assert.doesNotMatch(output, /sk-provider-secret/u);
  assert.match(output, /\[REDACTED\]/u);
  assert.deepEqual(JSON.parse(lines[0] ?? "{}"), {
    time: "2026-01-01T00:00:00.000Z",
    level: "error",
    message: "request failed with [REDACTED]",
    botToken: "[REDACTED]",
    OPENAI_API_KEY: "[REDACTED]",
    nested: { authorization: "[REDACTED]" },
    error: { name: "Error", message: "upstream echoed [REDACTED]" },
  });
});
