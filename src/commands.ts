import type { BotCommandInput } from "@clickclack/sdk-ts";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent";

export type SlashInvocation = { raw: string; name: string; args: string };
export const botCommandMenu: readonly BotCommandInput[] = [
  { command: "project", description: "Bind this conversation to a configured project", args_hint: "<alias>" },
  { command: "invoke", description: "Show or set how this conversation invokes Pi", args_hint: "[mention|always]" },
  { command: "continue", description: "Continue the latest recoverable Pi session" },
  { command: "compact", description: "Compact the current Pi session", args_hint: "[instructions]" },
  { command: "new", description: "Start a new Pi session" },
  { command: "name", description: "Show or set the Pi session name", args_hint: "[name]" },
  { command: "session", description: "Show Pi session usage and context stats" },
  { command: "model", description: "Show or select the Pi model", args_hint: "[provider/model]" },
  { command: "thinking", description: "Show or set the Pi thinking level", args_hint: "[level]" },
  { command: "reasoning", description: "Show or set whether Pi's working commentary streams", args_hint: "[stream|off]" },
  { command: "reload", description: "Reload Pi extensions, skills, prompts, and context" },
  { command: "copy", description: "Send the last Pi answer as a new message" },
];

export function parseSlashInvocation(body: string): SlashInvocation | undefined {
  const trimmed = body.trim();
  const match = /^\/([^\s]+)(?:\s+([\s\S]*))?$/u.exec(trimmed);
  if (!match?.[1]) return undefined;
  return { raw: trimmed, name: match[1], args: match[2]?.trim() ?? "" };
}

/** Omp exposes extension commands through ExtensionRunner and prompt templates on AgentSession. */
export function runtimeBotCommandMenu(session: AgentSession): BotCommandInput[] {
  const commands: BotCommandInput[] = [];
  for (const command of session.extensionRunner?.getRegisteredCommands() ?? []) {
    if (!isPublishableCommandName(command.name)) continue;
    commands.push({ command: command.name, description: boundedMetadata(command.description ?? "Run an omp extension command") });
  }
  for (const template of session.promptTemplates ?? []) {
    if (!isPublishableCommandName(template.name)) continue;
    commands.push({ command: template.name, description: boundedMetadata(template.description || "Run an omp prompt template") });
  }
  return commands;
}

export function isPiResourceCommand(session: AgentSession, invocation: SlashInvocation): boolean {
  if (session.extensionRunner?.getCommand(invocation.name)) return true;
  return (session.promptTemplates ?? []).some((template) => template.name === invocation.name);
}

function isPublishableCommandName(name: string): boolean {
  return /^[a-z0-9_-]{1,32}(?::[a-z0-9_-]{1,32})?$/u.test(name);
}
function boundedMetadata(value: string): string { return value.trim().slice(0, 100); }
