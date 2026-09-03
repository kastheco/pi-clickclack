import type { BotCommandInput } from "@clickclack/sdk-ts";
import type { AgentSessionRuntime } from "@earendil-works/pi-coding-agent";

export type SlashInvocation = {
  raw: string;
  name: string;
  args: string;
};

export const botCommandMenu: readonly BotCommandInput[] = [
  { command: "project", description: "Bind this conversation to a configured project", args_hint: "<alias>" },
  { command: "continue", description: "Continue the latest recoverable Pi session" },
  { command: "compact", description: "Compact the current Pi session", args_hint: "[instructions]" },
  { command: "new", description: "Start a new Pi session" },
  { command: "name", description: "Show or set the Pi session name", args_hint: "[name]" },
  { command: "session", description: "Show Pi session usage and context stats" },
  { command: "model", description: "Show or select the Pi model", args_hint: "[provider/model]" },
  { command: "thinking", description: "Show or set the Pi thinking level", args_hint: "[level]" },
  { command: "reload", description: "Reload Pi extensions, skills, prompts, and context" },
  { command: "copy", description: "Send the last Pi answer as a new message" },
];

export function parseSlashInvocation(body: string): SlashInvocation | undefined {
  const trimmed = body.trim();
  const match = /^\/([^\s]+)(?:\s+([\s\S]*))?$/u.exec(trimmed);
  if (!match?.[1]) return undefined;
  return {
    raw: trimmed,
    name: match[1],
    args: match[2]?.trim() ?? "",
  };
}

export function runtimeBotCommandMenu(runtime: AgentSessionRuntime): BotCommandInput[] {
  const commands: BotCommandInput[] = [];
  for (const command of runtime.session.extensionRunner.getRegisteredCommands()) {
    if (!isPublishableCommandName(command.invocationName)) continue;
    commands.push({
      command: command.invocationName,
      description: boundedMetadata(command.description ?? "Run a Pi extension command"),
    });
  }
  for (const template of runtime.session.promptTemplates) {
    if (!isPublishableCommandName(template.name)) continue;
    commands.push({
      command: template.name,
      description: boundedMetadata(template.description || "Run a Pi prompt template"),
      ...(template.argumentHint ? { args_hint: boundedMetadata(template.argumentHint) } : {}),
    });
  }
  return commands;
}

export function isPiResourceCommand(runtime: AgentSessionRuntime, invocation: SlashInvocation): boolean {
  if (runtime.session.extensionRunner.getCommand(invocation.name)) return true;
  if (runtime.session.promptTemplates.some((template) => template.name === invocation.name)) return true;
  if (!invocation.name.startsWith("skill:")) return false;
  const skillName = invocation.name.slice("skill:".length);
  return runtime.session.resourceLoader.getSkills().skills.some((skill) => skill.name === skillName);
}

/**
 * Matches ClickClack's bot command shape, including one optional namespace
 * segment, so a command family such as /kas:cook reaches the command menu.
 * A name outside this shape is dropped rather than rejected, because Pi
 * extensions may register names ClickClack cannot represent.
 */
function isPublishableCommandName(name: string): boolean {
  return /^[a-z0-9_-]{1,32}(?::[a-z0-9_-]{1,32})?$/u.test(name);
}

function boundedMetadata(value: string): string {
  return value.trim().slice(0, 100);
}
