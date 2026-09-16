import { isAbsolute, relative, resolve } from "node:path";

import type { AgentProgressPayload, Message } from "@clickclack/sdk-ts";

import {
  classifyGitCommand,
  classifyGitOperations,
  collectGitActivity,
  formatGitActivity,
  gitActivityNonce,
  renderGitActivity,
  type GitActivityContext,
  type GitActivityRecord,
  type GitOperation,
} from "./git-activity.js";

export type ActivitySource = Pick<Message, "channel_id" | "direct_conversation_id">;

export type ActivityMessage = { id: string };

export type ActivityTransport = {
  create(kind: "agent_commentary" | "agent_tool", body: string, turnId: string): Promise<ActivityMessage>;
  update(messageId: string, body: string): Promise<unknown>;
  progress?(payload: AgentProgressPayload): Promise<unknown>;
  publishGit?(body: string, nonce: string): Promise<unknown>;
};

export type TurnActivityOptions = {
  turnId: string;
  source: ActivitySource;
  projectCwd?: string;
  projectAlias?: string;
  sessionId?: string;
  transport: ActivityTransport;
  onError?: (error: unknown) => void;
  flushMs?: number;
  progressMs?: number;
  collectGitActivity?: (context: GitActivityContext) => Promise<GitActivityRecord>;
};

type TextProgressRow = {
  id: string;
  text: string;
  sent: boolean;
  finalized: boolean;
  timer?: NodeJS.Timeout;
};

type ToolRow = {
  body: string;
  gitOperations: GitOperation[];
  generatedPath?: string;
  messageId?: string;
  sentBody?: string;
};

const maximumCommentaryLength = 12_000;
const maximumProgressLength = 1_000;
const maximumToolDetailLength = 800;

/**
 * Adapts Pi session events to ClickClack's durable OpenClaw activity contract.
 * Commentary and tool rows share a turn_id, so ClickClack renders them as one
 * native collapsible preamble above the ordinary final answer.
 */
export class TurnActivity {
  private readonly turnId: string;
  private readonly projectCwd: string | undefined;
  private readonly projectAlias: string | undefined;
  private readonly sessionId: string | undefined;
  private readonly transport: ActivityTransport;
  private readonly onError: (error: unknown) => void;
  private readonly progressMs: number;
  private readonly collectGit: (context: GitActivityContext) => Promise<GitActivityRecord>;
  private queue: Promise<void> = Promise.resolve();
  private assistantSequence = 0;
  private progressSequence = 0;
  private currentText = "";
  private textProgress: TextProgressRow | undefined;
  private readonly toolRows = new Map<string, ToolRow>();
  private readonly generatedPaths = new Set<string>();

  constructor(options: TurnActivityOptions) {
    this.turnId = options.turnId;
    this.projectCwd = options.projectCwd;
    this.projectAlias = options.projectAlias;
    this.sessionId = options.sessionId;
    this.transport = options.transport;
    this.onError = options.onError ?? (() => {});
    this.progressMs = options.progressMs ?? options.flushMs ?? 150;
    this.collectGit = options.collectGitActivity ?? collectGitActivity;
    if (!options.source.channel_id && !options.source.direct_conversation_id) {
      throw new Error("activity source has no conversation target");
    }
  }

  handle(event: unknown): void {
    if (!isRecord(event) || typeof event.type !== "string") return;
    if (event.type === "agent_start") {
      this.publishProgress("append", {
        id: "lifecycle",
        kind: "lifecycle",
        text: "Pi is working",
        status: "running",
      });
      return;
    }
    if (event.type === "agent_end") {
      this.publishProgress("finalize", {
        id: "lifecycle",
        kind: "lifecycle",
        status: "done",
      });
      return;
    }
    if (event.type === "message_start") {
      if (isAssistantMessage(event.message)) {
        this.flushTextProgress("finalize");
        this.assistantSequence += 1;
        this.currentText = "";
        this.textProgress = undefined;
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
    this.flushTextProgress("finalize");
    await this.queue;
  }

  referencedGeneratedPaths(answer: string): string[] {
    if (!this.projectCwd) return [];
    return [...this.generatedPaths].filter((path) => {
      const projectRelative = relative(this.projectCwd!, path);
      return answer.includes(path)
        || (projectRelative && answer.includes(projectRelative));
    });
  }

  private handleAssistantUpdate(value: unknown): void {
    if (!isRecord(value) || typeof value.type !== "string") return;
    if (value.type === "text_delta" && typeof value.delta === "string") {
      this.currentText += value.delta;
      this.scheduleTextProgress();
      return;
    }
    if (value.type === "text_end" && typeof value.content === "string") {
      this.currentText = value.content;
      this.flushTextProgress("finalize");
    }
    // Deliberately ignore thinking_* events. Hidden model reasoning must never
    // leave the bridge, whether through durable rows or ephemeral progress.
  }

  private scheduleTextProgress(): void {
    if (!this.transport.progress || !this.currentText.trim()) return;
    const id = `assistant-${this.assistantSequence}`;
    if (!this.textProgress || this.textProgress.id !== id) {
      this.textProgress = { id, text: this.currentText, sent: false, finalized: false };
    } else {
      this.textProgress.text = this.currentText;
    }
    if (this.progressMs === 0) {
      this.flushTextProgress("update");
      return;
    }
    if (!this.textProgress.timer) {
      this.textProgress.timer = setTimeout(() => this.flushTextProgress("update"), this.progressMs);
    }
  }

  private flushTextProgress(op: "update" | "finalize"): void {
    const row = this.textProgress;
    if (!row || !row.text.trim() || !this.transport.progress || (op === "finalize" && row.finalized)) return;
    if (row.timer) clearTimeout(row.timer);
    delete row.timer;
    const first = !row.sent;
    row.sent = true;
    if (op === "finalize") row.finalized = true;
    this.publishProgress(first && op === "update" ? "append" : op, {
      id: row.id,
      kind: "commentary",
      text: row.text.trim().slice(-maximumProgressLength),
      ...(op === "finalize" ? { status: "done" } : {}),
    });
  }

  private flushPreambleText(): void {
    this.flushTextProgress("finalize");
    const body = this.currentText.trim().slice(0, maximumCommentaryLength);
    this.currentText = "";
    if (!body) return;
    this.enqueue(async () => {
      await this.transport.create("agent_commentary", body, this.turnId);
    });
  }

  private startTool(id: string, name: string, args: unknown): void {
    const row: ToolRow = {
      body: toolBody(name, args, this.projectCwd),
      gitOperations: this.projectCwd
        ? classifyGitOperations(name, args, this.projectCwd)
        : [],
      ...generatedPath(name, args, this.projectCwd),
    };
    this.toolRows.set(id, row);
    this.publishProgress("append", {
      id: `tool-${id}`,
      kind: "tool",
      tool_name: name,
      title: toolDetail(args, this.projectCwd) || name,
      status: "running",
    });
    this.enqueue(async () => {
      const posted = await this.transport.create("agent_tool", row.body, this.turnId);
      row.messageId = posted.id;
      row.sentBody = row.body;
    });
  }

  private finishTool(id: string, isError: boolean): void {
    const row = this.toolRows.get(id);
    if (!row) return;
    if (!isError && row.generatedPath) this.generatedPaths.add(row.generatedPath);
    if (isError) {
      row.body = `${row.body}\n\nfailed`;
      this.enqueue(async () => {
        if (row.messageId && row.sentBody !== row.body) {
          await this.transport.update(row.messageId, row.body);
          row.sentBody = row.body;
        }
      });
    }
    this.publishProgress("finalize", {
      id: `tool-${id}`,
      kind: "tool",
      status: isError ? "failed" : "succeeded",
    });
    this.publishGitActivity(id, row.gitOperations, isError);
  }

  private publishGitActivity(toolCallId: string, operations: GitOperation[], isError: boolean): void {
    if (
      operations.length === 0 ||
      !this.transport.publishGit ||
      !this.projectAlias ||
      !this.projectCwd ||
      !this.sessionId
    ) return;
    const publishGit = this.transport.publishGit;
    for (const [actionIndex, operation] of operations.entries()) {
      this.enqueue(async () => {
        const record = await this.collectGit({
          operation,
          outcome: isError ? "failed" : "succeeded",
          projectAlias: this.projectAlias!,
          projectCwd: this.projectCwd!,
          sessionId: this.sessionId!,
          turnId: this.turnId as GitActivityContext["turnId"],
        });
        await publishGit(
          renderGitActivity(record),
          gitActivityNonce(this.sessionId!, toolCallId, actionIndex),
        );
      });
    }
  }

  private publishProgress(
    op: "append" | "update" | "finalize",
    line: Extract<AgentProgressPayload, { op: "append" | "update" | "finalize" }>["line"],
  ): void {
    if (!this.transport.progress) return;
    const progress = this.transport.progress;
    const payload: AgentProgressPayload = {
      turn_id: this.turnId,
      seq: ++this.progressSequence,
      op,
      line,
    };
    this.enqueue(async () => { await progress(payload); });
  }

  private enqueue(work: () => Promise<void>): void {
    this.queue = this.queue.then(work).catch((error: unknown) => this.onError(error));
  }
}

function generatedPath(
  name: string,
  args: unknown,
  projectCwd?: string,
): { generatedPath?: string } {
  if (name !== "write" || !projectCwd || !isRecord(args)) return {};
  const raw = typeof args.path === "string"
    ? args.path
    : typeof args.file_path === "string" ? args.file_path : undefined;
  if (!raw?.trim()) return {};
  const candidate = resolve(projectCwd, raw);
  const projectRelative = relative(projectCwd, candidate);
  if (!projectRelative || projectRelative.startsWith("..") || isAbsolute(projectRelative)) return {};
  return { generatedPath: candidate };
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
