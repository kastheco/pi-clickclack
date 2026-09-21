import assert from "node:assert/strict";
import test from "node:test";

import {
  buildBotCreateArguments,
  completionScript,
  helpText,
  parseArguments,
  renderPersonaEnvironment,
  validatePersona,
} from "../add-persona.mjs";

const persona = {
  alias: "utmco",
  displayName: "утмсо",
  handle: "utmco",
  project: "/home/kas/dev/utmco",
  url: "https://clickclack.example.test",
  workspace: "wsp_test",
  owner: "usr_kas",
  model: "openai-codex/gpt-test",
  thinking: "medium",
  agentDir: "/home/kas/.pi/agent",
  data: "/var/lib/clickclack",
  statePath: "/home/kas/.local/state/pi-clickclack/utmco.sqlite",
};

test("persona CLI parses interactive and automation flags", () => {
  const parsed = parseArguments([
    "--alias=utmco",
    "--display-name", "утмсо",
    "--handle", "utmco",
    "--project", "/home/kas/dev/utmco",
    "--yes",
    "--dry-run",
  ]);
  assert.match(parsed.repo, /pi-clickclack$/u);
  assert.deepEqual({ ...parsed, repo: "<repo>" }, {
    repo: "<repo>",
    alias: "utmco",
    displayName: "утмсо",
    handle: "utmco",
    project: "/home/kas/dev/utmco",
    yes: true,
    dryRun: true,
  });
  assert.throws(() => parseArguments(["--wat"]), /unknown argument/u);
  assert.throws(() => parseArguments(["--alias"]), /requires a value/u);
});

test("persona CLI validates the fixed project identity", () => {
  assert.equal(validatePersona(persona), persona);
  assert.throws(() => validatePersona({ ...persona, alias: "UTM Co" }), /alias must be lowercase/u);
  assert.throws(() => validatePersona({ ...persona, project: "~/dev/utmco" }), /project path must be absolute/u);
  assert.throws(() => validatePersona({ ...persona, displayName: "" }), /display name is required/u);
  assert.throws(() => validatePersona({ ...persona, thinking: "huge" }), /thinking level must be/u);
});

test("persona CLI creates the requested ClickClack bot identity", () => {
  assert.deepEqual(buildBotCreateArguments(persona), [
    "admin", "bot", "create",
    "--data", "/var/lib/clickclack",
    "--workspace", "wsp_test",
    "--owner", "usr_kas",
    "--created-by", "usr_kas",
    "--name", "утмсо",
    "--handle", "utmco",
    "--scopes", "bot:write,agent_activity:write",
    "--token-name", "utmco",
    "--plain",
  ]);
});

test("persona CLI writes one isolated project without exposing extra identities", () => {
  const environment = renderPersonaEnvironment(persona, "ccb_secret");
  assert.match(environment, /CLICKCLACK_BOT_TOKEN=ccb_secret/u);
  assert.ok(environment.includes('CLICKCLACK_PI_PROJECTS=[{"alias":"utmco","cwd":"/home/kas/dev/utmco"}]'));
  assert.ok(environment.includes("PI_WORKSPACE_DIR=/home/kas/dev/utmco"));
  assert.ok(environment.includes("CLICKCLACK_PI_STATE_PATH=/home/kas/.local/state/pi-clickclack/utmco.sqlite"));
  assert.doesNotMatch(environment, /утмсо/u);
  assert.throws(() => renderPersonaEnvironment(persona, "not-a-token"), /valid bot token/u);
});

test("persona CLI publishes help, version flags, and shell completions", () => {
  assert.match(helpText(), /Interactive when attached to a terminal/u);
  assert.match(helpText(), /--display-name/u);
  assert.match(completionScript("bash"), /pi-clickclack-persona/u);
  assert.match(completionScript("fish"), /complete -c pi-clickclack-persona/u);
  assert.throws(() => completionScript("powershell"), /bash, zsh, or fish/u);
});
