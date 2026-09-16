import assert from "node:assert/strict";
import test from "node:test";

import { escapeSystemdPath, quoteSystemd, renderServiceUnit } from "../install-user-service.mjs";

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

test("service installer rejects control characters and unresolved fields", () => {
  assert.throws(() => quoteSystemd("bad\npath"), /control characters/u);
  assert.equal(escapeSystemdPath("/srv/100% ready"), "/srv/100%%\\x20ready");
  assert.throws(() => renderServiceUnit("ExecStart=@MISSING@", {}), /unresolved service template/u);
});
