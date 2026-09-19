#!/usr/bin/env node

import { chmod, mkdir, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const legacyServiceName = "pi-clickclack.service";
const personaPattern = /^[a-z][a-z0-9-]{0,62}$/u;

export function personaServiceName(persona) {
  if (!personaPattern.test(persona)) {
    throw new Error("persona must be a lowercase alias containing only letters, numbers, and hyphens");
  }
  return `pi-clickclack-${persona}.service`;
}

export function validatePersonaEnvironment(contents, expectedAlias) {
  const environment = parseEnvironmentFile(contents);
  const projectsRaw = environment.get("CLICKCLACK_PI_PROJECTS");
  if (!projectsRaw) throw new Error("CLICKCLACK_PI_PROJECTS is required for a persona service");

  let projects;
  try {
    projects = JSON.parse(projectsRaw);
  } catch {
    throw new Error("CLICKCLACK_PI_PROJECTS must be valid JSON for a persona service");
  }
  if (!Array.isArray(projects) || projects.length !== 1) {
    throw new Error("a persona service must configure exactly one project");
  }
  const project = projects[0];
  if (!project || typeof project !== "object" || Array.isArray(project)
    || typeof project.alias !== "string" || !personaPattern.test(project.alias)
    || typeof project.cwd !== "string" || !isAbsolute(project.cwd)) {
    throw new Error("the persona project must have a lowercase alias and an absolute cwd");
  }

  if (expectedAlias && project.alias !== expectedAlias) {
    throw new Error(`persona ${expectedAlias} must configure project alias ${expectedAlias}`);
  }

  const statePath = environment.get("CLICKCLACK_PI_STATE_PATH");
  if (!statePath) throw new Error("CLICKCLACK_PI_STATE_PATH is required for a persona service");
  if (!isAbsolute(statePath)) throw new Error("CLICKCLACK_PI_STATE_PATH must be absolute for a persona service");
  return { alias: project.alias, cwd: project.cwd };
}

export function renderServiceUnit(template, values) {
  let rendered = template;
  for (const [name, value] of Object.entries(values)) {
    const replacement = name === "WORKING_DIRECTORY"
      ? escapeSystemdPath(value)
      : quoteSystemd(value);
    rendered = rendered.replaceAll(`@${name}@`, replacement);
  }
  const unresolved = rendered.match(/@[A-Z_]+@/gu);
  if (unresolved) throw new Error(`unresolved service template fields: ${unresolved.join(", ")}`);
  return rendered;
}

export function quoteSystemd(value) {
  assertNoControlCharacters(value);
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

export function escapeSystemdPath(value) {
  assertNoControlCharacters(value);
  return value
    .replaceAll("%", "%%")
    .replaceAll("\\", "\\x5c")
    .replaceAll(" ", "\\x20")
    .replaceAll("\t", "\\x09");
}

function assertNoControlCharacters(value) {
  if (/[\u0000-\u0008\u000a-\u001f\u007f]/u.test(value)) {
    throw new Error("systemd paths cannot contain control characters");
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const serviceName = options.persona ? personaServiceName(options.persona) : legacyServiceName;
  const repo = await realpath(options.repo);
  const packageJson = JSON.parse(await readFile(join(repo, "package.json"), "utf8"));
  if (packageJson.name !== "pi-clickclack") throw new Error(`${repo} is not a pi-clickclack checkout`);
  const entrypoint = join(repo, "dist", "index.js");
  const entrypointStat = await stat(entrypoint).catch(() => undefined);
  if (!entrypointStat?.isFile()) throw new Error(`build output is missing: ${entrypoint}; run pnpm build first`);

  const envPath = resolve(options.env);
  if (pathInside(repo, envPath)) throw new Error("the service environment file must live outside the repository");
  const envStat = await stat(envPath).catch(() => undefined);
  if (!envStat?.isFile()) throw new Error(`service environment file is missing: ${envPath}`);
  if (options.persona) validatePersonaEnvironment(await readFile(envPath, "utf8"), options.persona);

  const templatePath = new URL("../systemd/pi-clickclack.service.in", import.meta.url);
  const template = await readFile(templatePath, "utf8");
  const unit = renderServiceUnit(template, {
    DESCRIPTION: options.persona ? `Pi ClickClack project persona: ${options.persona}` : "Pi ClickClack bridge",
    WORKING_DIRECTORY: repo,
    ENV_ARGUMENT: `--env-file=${envPath}`,
    NODE_EXECUTABLE: process.execPath,
    ENTRYPOINT: entrypoint,
  });
  if (options.dryRun) {
    process.stdout.write(unit);
    return;
  }

  await chmod(envPath, 0o600);
  const configHome = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  const unitPath = join(configHome, "systemd", "user", serviceName);
  const overrides = `${unitPath}.d`;
  const overrideStat = await stat(overrides).catch(() => undefined);
  if (overrideStat?.isDirectory()) {
    if (!options.replaceOverrides) {
      throw new Error(`legacy service overrides exist at ${overrides}; rerun with --replace-overrides after reviewing them`);
    }
    const backup = `${overrides}.bak-${new Date().toISOString().replace(/[:.]/gu, "-")}`;
    await rename(overrides, backup);
    process.stdout.write(`moved legacy overrides to ${backup}\n`);
  }

  await mkdir(dirname(unitPath), { recursive: true, mode: 0o700 });
  const temporary = `${unitPath}.tmp-${process.pid}`;
  await writeFile(temporary, unit, { mode: 0o600 });
  await rename(temporary, unitPath);
  runSystemctl(["daemon-reload"]);
  runSystemctl(["enable", serviceName]);
  if (options.start) {
    runSystemctl(["restart", serviceName]);
    runSystemctl(["is-active", "--quiet", serviceName]);
  }
  process.stdout.write(`installed ${unitPath}\n`);
  process.stdout.write(options.start ? `${serviceName} is active\n` : `start with: systemctl --user start ${serviceName}\n`);
}

function parseArguments(args) {
  const configHome = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  const options = {
    repo: process.cwd(),
    env: undefined,
    persona: undefined,
    dryRun: false,
    replaceOverrides: false,
    start: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--repo" || argument === "--env") {
      const value = args[index + 1];
      if (!value) throw new Error(`${argument} requires a path`);
      options[argument.slice(2)] = isAbsolute(value) ? value : resolve(value);
      index += 1;
    } else if (argument === "--persona") {
      const value = args[index + 1];
      if (!value) throw new Error("--persona requires a lowercase alias");
      personaServiceName(value);
      options.persona = value;
      index += 1;
    } else if (argument === "--dry-run") options.dryRun = true;
    else if (argument === "--replace-overrides") options.replaceOverrides = true;
    else if (argument === "--start") options.start = true;
    else if (argument === "--help") {
      process.stdout.write("Usage: node scripts/install-user-service.mjs [--persona ALIAS] [--repo PATH] [--env PATH] [--replace-overrides] [--start] [--dry-run]\n");
      process.exit(0);
    } else throw new Error(`unknown argument: ${argument}`);
  }
  options.env ??= options.persona
    ? join(configHome, "pi-clickclack", "personas", `${options.persona}.env`)
    : join(configHome, "pi-clickclack", "env");
  return options;
}

function parseEnvironmentFile(contents) {
  const environment = new Map();
  for (const sourceLine of contents.split(/\r?\n/u)) {
    const line = sourceLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/u.exec(line);
    if (!match) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    environment.set(match[1], value);
  }
  return environment;
}

function pathInside(parent, candidate) {
  const path = relative(parent, candidate);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

function runSystemctl(args) {
  const result = spawnSync("systemctl", ["--user", ...args], { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`systemctl --user ${args.join(" ")} failed with status ${result.status}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
