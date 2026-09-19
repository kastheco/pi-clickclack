#!/usr/bin/env node

import { spawn } from "node:child_process";
import { chmod, mkdir, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

const aliasPattern = /^[a-z][a-z0-9-]{0,62}$/u;
const thinkingLevels = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const scriptPath = fileURLToPath(import.meta.url);
const defaultRepo = resolve(dirname(scriptPath), "..");

export function parseArguments(args) {
  const options = { repo: defaultRepo };
  const valueOptions = new Map([
    ["--alias", "alias"],
    ["--display-name", "displayName"],
    ["--handle", "handle"],
    ["--project", "project"],
    ["--url", "url"],
    ["--workspace", "workspace"],
    ["--owner", "owner"],
    ["--model", "model"],
    ["--thinking", "thinking"],
    ["--agent-dir", "agentDir"],
    ["--data", "data"],
    ["--clickclack-bin", "clickClackBin"],
    ["--repo", "repo"],
    ["--defaults-from", "defaultsFrom"],
    ["--completion", "completion"],
  ]);
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--help" || argument === "-h") options.help = true;
    else if (argument === "--version" || argument === "-v") options.version = true;
    else if (argument === "--yes" || argument === "-y") options.yes = true;
    else if (argument === "--dry-run") options.dryRun = true;
    else if (argument === "--force") options.force = true;
    else if (argument === "--skip-build") options.skipBuild = true;
    else if (valueOptions.has(argument)) {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${argument} requires a value`);
      options[valueOptions.get(argument)] = value;
      index += 1;
    } else {
      const equals = /^(--[^=]+)=(.*)$/u.exec(argument);
      const key = equals?.[1] && valueOptions.get(equals[1]);
      if (!key || !equals?.[2]) throw new Error(`unknown argument: ${argument}`);
      options[key] = equals[2];
    }
  }
  return options;
}

export function validatePersona(values) {
  const issues = [];
  if (!aliasPattern.test(values.alias ?? "")) issues.push("alias must be lowercase letters, numbers, and hyphens");
  if (!aliasPattern.test(values.handle ?? "")) issues.push("handle must be lowercase letters, numbers, and hyphens");
  if (!values.displayName?.trim()) issues.push("display name is required");
  if (!isAbsolute(values.project ?? "")) issues.push("project path must be absolute");
  if (!isAbsolute(values.data ?? "")) issues.push("ClickClack data path must be absolute");
  if (!isAbsolute(values.agentDir ?? "")) issues.push("Pi agent directory must be absolute");
  if (!values.workspace?.trim()) issues.push("workspace ID is required");
  if (!values.owner?.trim()) issues.push("owner user ID is required");
  if (!values.model?.trim() || /\s/u.test(values.model)) issues.push("Pi model is required and must not contain whitespace");
  if (!thinkingLevels.has(values.thinking)) issues.push("thinking level must be off, minimal, low, medium, high, xhigh, or max");
  try {
    const url = new URL(values.url);
    if (!['http:', 'https:'].includes(url.protocol)) issues.push("ClickClack URL must use http or https");
  } catch {
    issues.push("ClickClack URL must be absolute");
  }
  if (issues.length) throw new Error(`invalid persona setup:\n- ${issues.join("\n- ")}`);
  return values;
}

export function buildBotCreateArguments(values) {
  return [
    "admin", "bot", "create",
    "--data", values.data,
    "--workspace", values.workspace,
    "--owner", values.owner,
    "--created-by", values.owner,
    "--name", values.displayName,
    "--handle", values.handle,
    "--scopes", "bot:write,agent_activity:write",
    "--token-name", values.handle,
    "--plain",
  ];
}

export function renderPersonaEnvironment(values, token) {
  if (!/^ccb_[^\s]+$/u.test(token)) throw new Error("ClickClack did not return a valid bot token");
  return [
    `CLICKCLACK_URL=${values.url}`,
    `CLICKCLACK_WORKSPACE_ID=${values.workspace}`,
    `CLICKCLACK_BOT_TOKEN=${token}`,
    `CLICKCLACK_OWNER_IDS=${values.owner}`,
    `CLICKCLACK_PI_PROJECTS=${JSON.stringify([{ alias: values.alias, cwd: values.project }])}`,
    "CLICKCLACK_PI_INVOCATIONS=[]",
    `CLICKCLACK_PI_MODEL=${values.model}`,
    `CLICKCLACK_PI_THINKING_LEVEL=${values.thinking}`,
    `CLICKCLACK_PI_STATE_PATH=${values.statePath}`,
    `CLICKCLACK_PI_AGENT_DIR=${values.agentDir}`,
    "",
  ].join("\n");
}

export function helpText() {
  return `Usage: pi-clickclack-persona [options]\n\nCreate a ClickClack bot, lock it to one Pi project, and start its service.\nInteractive when attached to a terminal; every prompt also has a flag.\n\nOptions:\n  --alias <alias>            Project/service alias, for example utmco\n  --display-name <name>      Visible name, Unicode allowed\n  --handle <handle>          ClickClack handle without @\n  --project <path>           Absolute project directory\n  --url <url>                ClickClack base URL\n  --workspace <id>           ClickClack workspace ID\n  --owner <id>               Human owner user ID\n  --model <provider/model>    Pi model\n  --thinking <level>         Pi thinking level (default: medium)\n  --agent-dir <path>         Pi agent directory (default: ~/.pi/agent)\n  --data <path>              ClickClack data directory (default: /var/lib/clickclack)\n  --clickclack-bin <path>    ClickClack executable (default: clickclack)\n  --defaults-from <path>     Existing bridge env used for prompt defaults\n  --repo <path>              pi-clickclack checkout\n  -y, --yes                  Skip final confirmation\n  --dry-run                  Show the plan without creating anything\n  --force                    Replace an existing persona env file\n  --skip-build               Do not run pnpm build before installation\n  --completion <shell>       Print bash, zsh, or fish completion\n  -h, --help                 Show help\n  -v, --version              Show version\n`;
}

export function completionScript(shell) {
  const options = "--alias --display-name --handle --project --url --workspace --owner --model --thinking --agent-dir --data --clickclack-bin --defaults-from --repo --yes --dry-run --force --skip-build --completion --help --version";
  if (shell === "bash") return `complete -W '${options}' pi-clickclack-persona\n`;
  if (shell === "zsh") return `compdef '_arguments "*::option:(${options})"' pi-clickclack-persona\n`;
  if (shell === "fish") return options.split(" ").map((option) => `complete -c pi-clickclack-persona -l ${option.slice(2)}`).join("\n") + "\n";
  throw new Error("completion shell must be bash, zsh, or fish");
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) return process.stdout.write(helpText());
  if (options.version) return process.stdout.write(`${await packageVersion(expandHome(options.repo))}\n`);
  if (options.completion) return process.stdout.write(completionScript(options.completion));

  const repo = await realpath(expandHome(options.repo));
  const configHome = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  const defaultsPath = expandHome(options.defaultsFrom || join(configHome, "pi-clickclack", "env"));
  const defaults = await readEnvironment(defaultsPath);
  const interactive = Boolean(process.stdin.isTTY && process.stderr.isTTY);
  const prompt = interactive ? createInterface({ input: process.stdin, output: process.stderr }) : undefined;
  let cancelled = false;
  process.once("SIGINT", () => {
    cancelled = true;
    prompt?.close();
    process.stderr.write("\nsetup cancelled\n");
    process.exitCode = 130;
  });

  try {
    const alias = await resolveValue(options.alias, prompt, "Project alias", "", aliasPattern);
    const values = validatePersona({
      alias,
      displayName: await resolveValue(options.displayName, prompt, "Display name", alias),
      handle: await resolveValue(options.handle, prompt, "Handle", alias, aliasPattern),
      project: expandHome(await resolveValue(options.project, prompt, "Project directory", join(homedir(), "dev", alias))),
      url: await resolveValue(options.url || defaults.CLICKCLACK_URL, prompt, "ClickClack URL", "http://127.0.0.1:8080"),
      workspace: await resolveValue(options.workspace || defaults.CLICKCLACK_WORKSPACE_ID, prompt, "Workspace ID"),
      owner: await resolveValue(options.owner || defaults.CLICKCLACK_OWNER_IDS?.split(",")[0], prompt, "Owner user ID"),
      model: await resolveValue(options.model || defaults.CLICKCLACK_PI_MODEL, prompt, "Pi model"),
      thinking: await resolveValue(options.thinking || defaults.CLICKCLACK_PI_THINKING_LEVEL, prompt, "Thinking level", "medium"),
      agentDir: expandHome(await resolveValue(options.agentDir || defaults.CLICKCLACK_PI_AGENT_DIR, prompt, "Pi agent directory", join(homedir(), ".pi", "agent"))),
      data: expandHome(await resolveValue(options.data, prompt, "ClickClack data directory", "/var/lib/clickclack")),
      clickClackBin: options.clickClackBin ? expandHome(options.clickClackBin) : "clickclack",
      repo,
    });
    values.envPath = join(configHome, "pi-clickclack", "personas", `${alias}.env`);
    values.statePath = join(process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "pi-clickclack", `${alias}.sqlite`);

    await requireDirectory(values.project, "project directory");
    await requireDirectory(values.agentDir, "Pi agent directory");
    if (!options.force && await exists(values.envPath)) {
      throw new Error(`persona config already exists: ${values.envPath}\nUse --force only if you intend to replace it.`);
    }

    printPlan(values, options);
    if (options.dryRun) return;
    if (!options.yes && !await confirm(prompt, `Create @${values.handle} and start pi-clickclack-${values.alias}.service?`)) {
      process.stderr.write("setup cancelled\n");
      return;
    }
    if (cancelled) return;

    process.stderr.write(`creating @${values.handle}...\n`);
    const token = (await runCapture(values.clickClackBin, buildBotCreateArguments(values), { cwd: repo })).trim();
    const environment = renderPersonaEnvironment(values, token);
    await writeSecret(values.envPath, environment);

    if (!options.skipBuild) {
      process.stderr.write("building pi-clickclack...\n");
      await runInherited("pnpm", ["build"], { cwd: repo });
    }
    process.stderr.write(`installing pi-clickclack-${values.alias}.service...\n`);
    await runInherited(process.execPath, [
      join(repo, "scripts", "install-user-service.mjs"),
      "--persona", values.alias,
      "--repo", repo,
      "--env", values.envPath,
      "--start",
    ], { cwd: repo });
    process.stderr.write(`ready: @${values.handle} (${values.displayName}) -> ${values.project}\n`);
  } finally {
    prompt?.close();
  }
}

async function resolveValue(value, prompt, label, fallback = "", pattern) {
  if (value?.trim()) return value.trim();
  if (!prompt) throw new Error(`${label} is required in non-interactive mode`);
  for (;;) {
    const suffix = fallback ? ` [${fallback}]` : "";
    const answer = (await prompt.question(`${label}${suffix}: `)).trim() || fallback;
    if (answer && (!pattern || pattern.test(answer))) return answer;
    process.stderr.write(pattern ? `${label} must use lowercase letters, numbers, and hyphens\n` : `${label} is required\n`);
  }
}

async function confirm(prompt, message) {
  if (!prompt) throw new Error("--yes is required in non-interactive mode");
  const answer = (await prompt.question(`${message} [Y/n] `)).trim().toLowerCase();
  return answer === "" || answer === "y" || answer === "yes";
}

function printPlan(values, options) {
  process.stderr.write(["", "project persona", `  bot:      @${values.handle} (${values.displayName})`, `  project:  ${values.project}`, `  service:  pi-clickclack-${values.alias}.service`, `  config:   ${values.envPath}`, `  state:    ${values.statePath}`, `  model:    ${values.model}`, options.dryRun ? "  mode:     dry run" : "", ""].filter(Boolean).join("\n") + "\n");
}

async function writeSecret(path, contents) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await mkdir(dirname(parseEnvironment(contents).CLICKCLACK_PI_STATE_PATH), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}`;
  await writeFile(temporary, contents, { mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, path);
}

async function readEnvironment(path) {
  try {
    return parseEnvironment(await readFile(path, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return {};
    throw error;
  }
}

function parseEnvironment(contents) {
  const result = {};
  for (const sourceLine of contents.split(/\r?\n/u)) {
    const line = sourceLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/u.exec(line);
    if (!match) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    result[match[1]] = value;
  }
  return result;
}

function expandHome(path) {
  if (!path) return path;
  if (path === "~") return homedir();
  return path.startsWith("~/") ? join(homedir(), path.slice(2)) : resolve(path);
}

async function packageVersion(repo) {
  const packageJson = JSON.parse(await readFile(join(repo, "package.json"), "utf8"));
  return packageJson.version;
}

async function exists(path) {
  return Boolean(await stat(path).catch(() => undefined));
}

async function requireDirectory(path, label) {
  const entry = await stat(path).catch(() => undefined);
  if (!entry?.isDirectory()) throw new Error(`${label} does not exist: ${path}`);
}

function runCapture(command, args, options) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { ...options, stdio: ["ignore", "pipe", "inherit"] });
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.once("error", (error) => reject(commandError(command, error)));
    child.once("exit", (code, signal) => code === 0 ? resolvePromise(stdout) : reject(new Error(`${command} failed${signal ? ` from ${signal}` : ` with status ${code}`}`)));
  });
}

function runInherited(command, args, options) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { ...options, stdio: "inherit" });
    child.once("error", (error) => reject(commandError(command, error)));
    child.once("exit", (code, signal) => code === 0 ? resolvePromise() : reject(new Error(`${command} failed${signal ? ` from ${signal}` : ` with status ${code}`}`)));
  });
}

function commandError(command, error) {
  return error?.code === "ENOENT"
    ? new Error(`${command} was not found. Install it or pass its path with --clickclack-bin.`)
    : error;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode ||= 1;
  });
}
