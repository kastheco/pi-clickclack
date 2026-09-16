import { environmentSecretValues } from "./logger.js";

/** Publish only a bounded error message, never arbitrary objects or stack traces. */
export function errorReply(summary: string, error: unknown, reference: string, secrets: readonly string[] = []): string {
  let detail = error instanceof Error ? error.message : typeof error === "string" ? error : "unknown error";
  for (const secret of [...secrets, ...environmentSecretValues()].filter(Boolean).sort((a, b) => b.length - a.length)) {
    detail = detail.split(secret).join("[REDACTED]");
  }
  detail = detail
    // Provider errors can embed entire HTTP responses and stacks in their message.
    .split(/(?:;\s*(?:body|stack)=|\n\s*at\s)/u)[0]!
    .replace(/https?:\/\/[^\s<>"']+/giu, "[URL REDACTED]")
    .replace(/\bBearer\s+[^\s"']+/giu, "Bearer [REDACTED]")
    .replace(/\b(?:ccb_|sk-)[A-Za-z0-9._-]+/gu, "[REDACTED]")
    .replace(/(["']?(?:authorization|cookie|password|secret|token|access_token|refresh_token|api[_-]?key)["']?\s*[:=]\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s,;]+)/giu, "$1[REDACTED]")
    .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu, " ")
    .trim();
  if (!detail) detail = "unknown error";
  if (detail.length > 1200) detail = `${detail.slice(0, 1200)}…`;
  const recovery = detail.startsWith("Anthropic cache lineage diverged before transport:")
    ? "\n\ntry `/compact`, then `/continue` in this conversation. don't use `/new` to recover this session."
    : "";
  // An indented code block prevents provider text becoming links, HTML or commands.
  return `${summary}\n\n    ${detail}${recovery}\n\nreference: ${reference}`;
}
