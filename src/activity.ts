import type { Message } from "@clickclack/sdk-ts";

import { classifyGitCommand, formatGitActivity } from "./git-activity.js";

export type ActivitySource = Pick<Message, "channel_id" | "direct_conversation_id">;

export type ActivityMessage = { id: string };

export type ActivityTransport = {
  create(kind: "agent_commentary" | "agent_tool", body: string, turnId: string): Promise<ActivityMessage>;
  update(messageId: string, body: string): Promise<unknown>;
};

export type TurnActivityOptions = {
  turnId: string;
  source: ActivitySource;
  projectCwd?: string;
  transport: ActivityTransport;
  onError?: (error: unknown) => void;
  flushMs?: number;
};

type CommentaryRow = {
  body: string;
  dirty: boolean;
  messageId?: string;
  sentBody?: string;
  timer?: NodeJS.Timeout;
};

type ToolRow = {
  body: string;
  messageId?: string;
  sentBody?: string;
};

const maximumCommentaryLength = 12_000;
const maximumToolDetailLength = 800;

/**
 * Adapts Pi session events to ClickClack's durable OpenClaw activity contract.
 * Commentary and tool rows share a turn_id, so ClickClack renders them as one
 * native collapsible preamble above the ordinary final answer.
 */
export class TurnActivity {
  private readonly turnId: string;
  private readonly projectCwd: string | undefined;
  private readonly transport: ActivityTransport;
  private readonly onError: (error: unknown) => void;
  private readonly flushMs: number;
  private queue: Promise<void> = Promise.resolve();
  private assistantSequence = 0;
  private currentText = "";
  private readonly thinkingRows = new Map<string, CommentaryRow>();
  private readonly toolRows = new Map<string, ToolRow>();

  constructor(options: TurnActivityOptions) {
    this.turnId = options.turnId;
    this.projectCwd = options.projectCwd;
    this.transport = options.transport;
    this.onError = options.onError ?? (() => {});
    this.flushMs = options.flushMs ?? 700;
    if (!options.source.channel_id && !options.source.direct_conversation_id) {
      throw new Error("activity source has no conversation target");
    }
  }

  handle(event: unknown): void {
    if (!isRecord(event) || typeof event.type !== "string") return;
    if (event.type === "message_start") {
      if (isAssistantMessage(event.message)) {
        this.assistantSequence += 1;
        this.currentText = "";
      }
      return;
    }
    if (event.type === "message_update") {
      this.handleAssistantUpdate(event.assistantMessageEvent);
      return;
    }
    if (event.type === "message_end") {
      if (isAssistantMessage(event.message)) this.currentText = assistantText(event.message);
      return;
    }
    if (event.type === "tool_execution_start") {
      const id = stringField(event, "toolCallId");
      const name = stringField(event, "toolName");
      if (!id || !name) return;
      this.flushPreambleText();
      this.startTool(id, name, event.args);
      return;
    }
    if (event.type === "tool_execution_end") {
      const id = stringField(event, "toolCallId");
      if (!id) return;
      this.finishTool(id, event.isError === true);
    }
  }

  async finalize(): Promise<void> {
    for (const key of this.thinkingRows.keys()) this.flushCommentary(key);
    await this.queue;
  }

  private handleAssistantUpdate(value: unknown): void {
    if (!isRecord(value) || typeof value.type !== "string") return;
    if (value.type === "text_delta" && typeof value.delta === "string") {
      this.currentText += value.delta;
      return;
    }
    if (value.type === "text_end" && typeof value.content === "string") {
      this.currentText = value.content;
      return;
    }
    if (value.type === "thinking_delta" && typeof value.delta === "string") {
      this.updateThinking(numberField(value, "contentIndex") ?? 0, value.delta, false);
      return;
    }
    if (value.type === "thinking_end" && typeof value.content === "string") {
      this.updateThinking(numberField(value, "contentIndex") ?? 0, value.content, true);
    }
  }

  private updateThinking(contentIndex: number, value: string, complete: boolean): void {
    const key = `${this.assistantSequence}:${contentIndex}`;
    let row = this.thinkingRows.get(key);
    if (!row) {
      row = { body: "", dirty: false };
      this.thinkingRows.set(key, row);
    }
    const text = complete ? value : `${thinkingText(row.body)}${value}`;
    const body = `**Thinking**\n\n${text.trim()}`.slice(0, maximumCommentaryLength);
    if (!text.trim() || body === row.body) return;
    row.body = body;
    row.dirty = true;
    if (complete || this.flushMs === 0) {
      this.flushCommentary(key);
      return;
    }
    if (!row.timer) row.timer = setTimeout(() => this.flushCommentary(key), this.flushMs);
  }

  private flushPreambleText(): void {
    const body = this.currentText.trim().slice(0, maximumCommentaryLength);
    this.currentText = "";
    if (!body) return;
    this.enqueue(async () => {
      await this.transport.create("agent_commentary", body, this.turnId);
    });
  }

  private flushCommentary(key: string): void {
    const row = this.thinkingRows.get(key);
    if (!row) return;
    if (row.timer) clearTimeout(row.timer);
    delete row.timer;
    if (!row.dirty || !row.body.trim()) return;
    row.dirty = false;
    this.enqueue(async () => {
      if (row.messageId) {
        if (row.sentBody !== row.body) {
          await this.transport.update(row.messageId, row.body);
          row.sentBody = row.body;
        }
        return;
      }
      const posted = await this.transport.create("agent_commentary", row.body, this.turnId);
      row.messageId = posted.id;
      row.sentBody = row.body;
    });
  }

  private startTool(id: string, name: string, args: unknown): void {
    const row: ToolRow = { body: toolBody(name, args, this.projectCwd) };
    this.toolRows.set(id, row);
    this.enqueue(async () => {
      const posted = await this.transport.create("agent_tool", row.body, this.turnId);
      row.messageId = posted.id;
      row.sentBody = row.body;
    });
  }

  private finishTool(id: string, isError: boolean): void {
    const row = this.toolRows.get(id);
    if (!row || !isError) return;
    row.body = `${row.body}\n\nfailed`;
    this.enqueue(async () => {
      if (row.messageId && row.sentBody !== row.body) {
        await this.transport.update(row.messageId, row.body);
        row.sentBody = row.body;
      }
    });
  }

  private enqueue(work: () => Promise<void>): void {
    this.queue = this.queue.then(work).catch((error: unknown) => this.onError(error));
  }
}

function toolBody(name: string, args: unknown, projectCwd?: string): string {
  const git = gitBody(name, args, projectCwd);
  if (git) return git;
  const detail = toolDetail(args, projectCwd);
  return detail ? `**${name}**\n\n${detail}` : `**${name}**`;
}

/**
 * Renders a `bash` call that runs git under its own heading. Git is the one
 * kind of shell command whose result outlives the turn, so it is worth
 * distinguishing from the reads and greps it is buried among.
 */
function gitBody(name: string, args: unknown, projectCwd?: string): string {
  if (name !== "bash" || !isRecord(args)) return "";
  const command = args.command;
  if (typeof command !== "string" || !command.trim()) return "";
  const normalized = projectCwd
    ? stripPinnedCwdPrefix(command.trim(), projectCwd)
    : command.trim();
  const activity = classifyGitCommand(normalized);
  return activity ? formatGitActivity(activity) : "";
}

function toolDetail(value: unknown, projectCwd?: string): string {
  if (!isRecord(value)) return "";
  for (const key of ["command", "path", "query", "pattern", "url", "description"] as const) {
    const candidate = value[key];
    if (typeof candidate === "string" && candidate.trim()) {
      const detail = key === "command" && projectCwd
        ? stripPinnedCwdPrefix(candidate.trim(), projectCwd)
        : candidate.trim();
      return detail.replace(/\s+/gu, " ").slice(0, maximumToolDetailLength);
    }
  }
  return "";
}

function stripPinnedCwdPrefix(command: string, projectCwd: string): string {
  for (const cwd of [projectCwd, `'${projectCwd}'`, `"${projectCwd}"`]) {
    const prefix = `cd ${cwd} &&`;
    if (command.startsWith(prefix)) return command.slice(prefix.length).trimStart();
  }
  return command;
}

function thinkingText(body: string): string {
  return body.replace(/^\*\*Thinking\*\*\n\n/u, "");
}

function assistantText(value: unknown): string {
  if (!isAssistantMessage(value)) return "";
  if (typeof value.content === "string") return value.content.trim();
  if (!Array.isArray(value.content)) return "";
  return value.content
    .filter((part): part is { type: "text"; text: string } => Boolean(
      isRecord(part) && part.type === "text" && typeof part.text === "string",
    ))
    .map((part) => part.text)
    .join("")
    .trim();
}

function isAssistantMessage(value: unknown): value is Record<string, unknown> & { role: "assistant" } {
  return isRecord(value) && value.role === "assistant";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

function stringField(value: Record<string, unknown>, key: string): string | undefined {
  const field = value[key];
  return typeof field === "string" && field ? field : undefined;
}

function numberField(value: Record<string, unknown>, key: string): number | undefined {
  const field = value[key];
  return typeof field === "number" ? field : undefined;
}
