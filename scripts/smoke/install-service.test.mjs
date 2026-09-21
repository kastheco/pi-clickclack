import assert from "node:assert/strict";
import test from "node:test";

import {
  escapeSystemdPath,
  personaServiceName,
  quoteSystemd,
  renderServiceUnit,
  serviceRuntimeConfig,
  validatePersonaEnvironment,
} from "../install-user-service.mjs";

test("service installer renders absolute runtime and external secret paths", () => {
  const template = [
    "WorkingDirectory=@WORKING_DIRECTORY@",
    "ExecStart=@NODE_EXECUTABLE@ @ENV_ARGUMENT@ @ENTRYPOINT@",
  ].join("\n");
  assert.equal(renderServiceUnit(template, {
    WORKING_DIRECTORY: "/srv/pi clickclack",
    ENV_ARGUMENT: "--env-file=/home/user/.config/pi-clickclack/env",
    NODE_EXECUTABLE: "/opt/node/bin/node",
    ENTRYPOINT: "/srv/pi clickclack/dist/index.js",
  }), [
    "WorkingDirectory=/srv/pi\\x20clickclack",
    'ExecStart="/opt/node/bin/node" "--env-file=/home/user/.config/pi-clickclack/env" "/srv/pi clickclack/dist/index.js"',
  ].join("\n"));
});

test("persona services pin process-level extensions to the configured project", () => {
  assert.deepEqual(serviceRuntimeConfig(
    "/srv/pi-clickclack",
    { alias: "clickclack", cwd: "/home/user/dev/clickclack" },
  ), { workingDirectory: "/home/user/dev/clickclack" });
  assert.deepEqual(serviceRuntimeConfig("/srv/pi-clickclack"), {
    workingDirectory: "/srv/pi-clickclack",
  });
});

test("service installer rejects control characters and unresolved fields", () => {
  assert.throws(() => quoteSystemd("bad\npath"), /control characters/u);
  assert.equal(escapeSystemdPath("/srv/100% ready"), "/srv/100%%\\x20ready");
  assert.throws(() => renderServiceUnit("ExecStart=@MISSING@", {}), /unresolved service template/u);
});

test("persona installs use isolated service names", () => {
  assert.equal(personaServiceName("clickclack"), "pi-clickclack-clickclack.service");
  assert.equal(personaServiceName("pi-clickclack"), "pi-clickclack-pi-clickclack.service");
  assert.throws(() => personaServiceName("ClickClack"), /lowercase alias/u);
  assert.throws(() => personaServiceName("../clickclack"), /lowercase alias/u);
});

test("persona installs require one project and an explicit isolated state path", () => {
  assert.deepEqual(validatePersonaEnvironment([
    "CLICKCLACK_BOT_TOKEN=ccb_secret",
    'CLICKCLACK_PI_PROJECTS=[{"alias":"clickclack","cwd":"/home/user/dev/clickclack"}]',
    "CLICKCLACK_PI_STATE_PATH=/home/user/.local/state/pi-clickclack/clickclack.sqlite",
  ].join("\n")), { alias: "clickclack", cwd: "/home/user/dev/clickclack" });

  assert.throws(() => validatePersonaEnvironment([
    'CLICKCLACK_PI_PROJECTS=[{"alias":"one","cwd":"/one"},{"alias":"two","cwd":"/two"}]',
    "CLICKCLACK_PI_STATE_PATH=/tmp/persona.sqlite",
  ].join("\n")), /exactly one project/u);
  assert.throws(() => validatePersonaEnvironment(
    'CLICKCLACK_PI_PROJECTS=[{"alias":"clickclack","cwd":"/home/user/dev/clickclack"}]',
  ), /CLICKCLACK_PI_STATE_PATH is required/u);
  assert.throws(() => validatePersonaEnvironment([
    'CLICKCLACK_PI_PROJECTS=[{"alias":"clickclack","cwd":"/home/user/dev/clickclack"}]',
    "CLICKCLACK_PI_STATE_PATH=/tmp/persona.sqlite",
  ].join("\n"), "other"), /persona other must configure project alias other/u);
  assert.throws(() => validatePersonaEnvironment([
    'CLICKCLACK_PI_PROJECTS=[{"alias":"clickclack","cwd":"/home/user/dev/clickclack"}]',
    "CLICKCLACK_PI_STATE_PATH=/tmp/persona.sqlite",
    "PI_WORKSPACE_DIR=/home/user/dev/pi-clickclack",
  ].join("\n"), "clickclack"), /PI_WORKSPACE_DIR must match/u);
});
