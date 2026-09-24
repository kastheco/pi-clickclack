import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import type { RealtimeEvent } from "@clickclack/sdk-ts";
import {
  parseSessionEntries,
  type AgentSessionRuntime,
  type FileEntry,
} from "@earendil-works/pi-coding-agent";

import type { Logger } from "./logger.js";

// Tangents are private side chats a ClickClack user opens with this bot from
// a bound conversation. ClickClack keeps them in memory and relays cursorless
// frames; this module owns the Pi side. Each tangent gets its own in-memory Pi
// session seeded with the binding's history at the moment it opened, so it
// never writes a session file, never shows up in /resume, and never touches
// the binding's own runtime. Closing the tangent aborts and disposes it.

export type TangentRecord = {
  id: string;
  workspace_id: string;
  channel_id?: string;
  direct_conversation_id?: string;
  owner_user_id: string;
  bot_user_id: string;
  created_at: string;
};

type TangentMessageRecord = {
  id: string;
  tangent_id: string;
  author_id: string;
  body: string;
};

export interface TangentTransport {
  /** Returns undefined when the tangent is gone or not ours. */
  get(tangentId: string): Promise<TangentRecord | undefined>;
  post(tangentId: string, body: string): Promise<void>;
  activity(tangentId: string, state: "working" | "idle"): Promise<void>;
}

export function createTangentTransport(
  baseUrl: string,
  token: string,
  fetchImpl: typeof fetch = fetch,
): TangentTransport {
  const url = (tangentId: string, suffix = "") =>
    new URL(`/api/tangents/${encodeURIComponent(tangentId)}${suffix}`, baseUrl).toString();
  const request = async (target: string, init: RequestInit = {}) => {
    const response = await fetchImpl(target, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        ...(init.body ? { "Content-Type": "application/json" } : {}),
      },
      signal: AbortSignal.timeout(15_000),
    });
    return response;
  };
  return {
    async get(tangentId) {
      const response = await request(url(tangentId));
      if (response.status === 404) return undefined;
      if (!response.ok) throw new Error(`tangent lookup failed: HTTP ${response.status}`);
      const data = (await response.json()) as { tangent?: TangentRecord };
      return data.tangent;
    },
    async post(tangentId, body) {
      const response = await request(url(tangentId, "/messages"), {
        method: "POST",
        body: JSON.stringify({ body }),
      });
      // 404 means the owner closed it meanwhile; there's nobody to tell.
      if (!response.ok && response.status !== 404) {
        throw new Error(`tangent reply failed: HTTP ${response.status}`);
      }
    },
    async activity(tangentId, state) {
      const response = await request(url(tangentId, "/activity"), {
        method: "POST",
        body: JSON.stringify({ state }),
      });
      if (!response.ok && response.status !== 404) {
        throw new Error(`tangent activity failed: HTTP ${response.status}`);
      }
    },
  };
}

/**
 * Copy a session file's entries for an in-memory fork. The header gets a new
 * id and points back at its source, the way Pi's own fork does, so extensions
 * never mistake the fork for the binding's session.
 */
export function forkEntriesFromSessionText(
  text: string,
  sourceFile: string,
  now = new Date(),
  sessionId: string = randomUUID(),
): FileEntry[] | undefined {
  const entries = parseSessionEntries(text);
  const headerIndex = entries.findIndex((entry) => entry.type === "session");
  if (headerIndex < 0) return undefined;
  const forked = entries.slice();
  forked[headerIndex] = {
    ...entries[headerIndex],
    id: sessionId,
    timestamp: now.toISOString(),
    parentSession: sourceFile,
  } as FileEntry;
  return forked;
}

export type TangentForkSource = {
  projectAlias: string;
  // The binding's current Pi session file. Absent before its first turn.
  sessionFile?: string;
};

export type TangentHostOptions = {
  transport: TangentTransport;
  workspaceId: string;
  ownerIds: readonly string[];
  selfId: () => string | undefined;
  /** The bound project and session for the tangent's source conversation. */
  resolveSource: (tangent: TangentRecord) => TangentForkSource | undefined;
  createRuntime: (projectAlias: string, forkEntries: FileEntry[] | undefined) => Promise<AgentSessionRuntime>;
  /** Run one prompt to completion and return the reply text. */
  runTurn: (runtime: AgentSessionRuntime, prompt: string) => Promise<string>;
  logger: Logger;
  readSessionFile?: (path: string) => string;
  maxTangents?: number;
};

type Entry = {
  record: TangentRecord;
  runtime: Promise<AgentSessionRuntime | undefined>;
  queue: Promise<void>;
  closed: boolean;
};

export const unboundTangentReply =
  "This conversation isn't bound to a Pi project, so there's nothing to fork. Bind it with `/project <alias>` in the conversation, then start a new tangent.";

export class TangentHost {
  private readonly tangents = new Map<string, Entry>();

  constructor(private readonly options: TangentHostOptions) {}

  /** Handles tangent.* frames. Returns false for every other event. */
  async handle(event: RealtimeEvent): Promise<boolean> {
    if (!event.type.startsWith("tangent.")) return false;
    if (event.workspace_id !== this.options.workspaceId) return true;
    const payload = event.payload as Record<string, unknown>;
    switch (event.type) {
      case "tangent.opened": {
        const record = payload.tangent as TangentRecord | undefined;
        if (record && this.accepts(record)) this.register(record);
        return true;
      }
      case "tangent.message":
        await this.receive(payload.message as TangentMessageRecord | undefined);
        return true;
      case "tangent.closed":
        if (typeof payload.tangent_id === "string") await this.close(payload.tangent_id);
        return true;
      default:
        return true;
    }
  }

  get size(): number {
    return this.tangents.size;
  }

  /** Waits for every queued tangent turn. */
  async waitForIdle(): Promise<void> {
    await Promise.allSettled([...this.tangents.values()].map((entry) => entry.queue));
  }

  async stop(): Promise<void> {
    await Promise.allSettled([...this.tangents.keys()].map((id) => this.close(id)));
  }

  private accepts(record: TangentRecord): boolean {
    const self = this.options.selfId();
    return Boolean(self)
      && record.bot_user_id === self
      && record.workspace_id === this.options.workspaceId
      && this.options.ownerIds.includes(record.owner_user_id);
  }

  private register(record: TangentRecord): Entry {
    const existing = this.tangents.get(record.id);
    if (existing) return existing;
    const max = this.options.maxTangents ?? 8;
    if (this.tangents.size >= max) {
      const oldest = this.tangents.keys().next().value;
      if (oldest) void this.close(oldest);
    }
    const entry: Entry = {
      record,
      // Fork right away so the tangent sees the conversation as it was when
      // it opened, not when the first question arrives.
      runtime: this.fork(record),
      queue: Promise.resolve(),
      closed: false,
    };
    this.tangents.set(record.id, entry);
    return entry;
  }

  private async fork(record: TangentRecord): Promise<AgentSessionRuntime | undefined> {
    const source = this.options.resolveSource(record);
    if (!source) return undefined;
    let entries: FileEntry[] | undefined;
    if (source.sessionFile) {
      const read = this.options.readSessionFile ?? ((path: string) => readFileSync(path, "utf8"));
      entries = forkEntriesFromSessionText(read(source.sessionFile), source.sessionFile);
    }
    return this.options.createRuntime(source.projectAlias, entries);
  }

  private async receive(message: TangentMessageRecord | undefined): Promise<void> {
    if (!message || typeof message.tangent_id !== "string" || typeof message.body !== "string") return;
    if (message.author_id === this.options.selfId()) return;
    let entry = this.tangents.get(message.tangent_id);
    if (!entry) {
      // Opened while this bridge was offline or restarting: recover it.
      const record = await this.options.transport.get(message.tangent_id);
      if (!record || !this.accepts(record)) return;
      entry = this.register(record);
    }
    if (message.author_id !== entry.record.owner_user_id) return;
    // Runs detached: the service handles realtime events one at a time, and a
    // tangent turn must never hold up the main conversation. Turns within one
    // tangent still run in order.
    const current = entry;
    current.queue = current.queue
      .then(() => this.answer(current, message.body))
      .catch((error: unknown) => {
        this.options.logger.error("tangent turn failed", { tangentId: current.record.id, error });
      });
  }

  private async answer(entry: Entry, prompt: string): Promise<void> {
    if (entry.closed) return;
    const id = entry.record.id;
    let runtime: AgentSessionRuntime | undefined;
    try {
      runtime = await entry.runtime;
    } catch (error) {
      this.options.logger.error("tangent fork failed", { tangentId: id, error });
      if (!entry.closed) await this.options.transport.post(id, `Couldn't fork this conversation's Pi session: ${errorText(error)}`);
      return;
    }
    if (entry.closed) return;
    if (!runtime) {
      await this.options.transport.post(id, unboundTangentReply);
      return;
    }
    await this.bestEffortActivity(id, "working");
    try {
      const reply = await this.options.runTurn(runtime, prompt);
      if (!entry.closed) await this.options.transport.post(id, reply);
    } catch (error) {
      if (!entry.closed) await this.options.transport.post(id, `Pi couldn't finish that: ${errorText(error)}`);
    } finally {
      if (!entry.closed) await this.bestEffortActivity(id, "idle");
    }
  }

  private async bestEffortActivity(id: string, state: "working" | "idle"): Promise<void> {
    try {
      await this.options.transport.activity(id, state);
    } catch (error) {
      this.options.logger.warn("tangent activity publish failed", { tangentId: id, error });
    }
  }

  private async close(id: string): Promise<void> {
    const entry = this.tangents.get(id);
    if (!entry) return;
    entry.closed = true;
    this.tangents.delete(id);
    let runtime: AgentSessionRuntime | undefined;
    try {
      runtime = await entry.runtime;
    } catch {
      return;
    }
    if (!runtime) return;
    try {
      await runtime.session.abort();
    } catch (error) {
      this.options.logger.warn("tangent abort failed", { tangentId: id, error });
    }
    try {
      await runtime.dispose();
    } catch (error) {
      this.options.logger.warn("tangent dispose failed", { tangentId: id, error });
    }
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
