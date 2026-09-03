/**
 * Renders a workflow human decision as ClickClack text and reads the reply.
 *
 * Decisions arrive as structured choices, but ClickClack is a chat surface, so
 * a decision becomes one numbered message and the operator answers with an
 * ordinary reply. Matching is deliberately strict: a reply either names exactly
 * one choice or it is not an answer at all. Guessing would risk resuming a
 * durable workflow on a message the operator never meant as a decision.
 */

import type { ClaimedWorkflowDecision, DecisionAnswer } from "./workflow-decisions.js";

/** Reply text that means "leave this decision alone". */
const dismissals = new Set(["cancel", "dismiss", "ignore", "later", "skip"]);

/**
 * Namespace marking a turn as a workflow decision prompt.
 *
 * ClickClack's message kinds are message, agent_commentary, and agent_tool; a
 * decision is not one of them and adding a kind would diverge this fork from
 * upstream on its own message contract. turn_id is an opaque bot-authored
 * correlation string that ClickClack passes through unvalidated and publishes
 * on the message.created event, so it carries the marker instead.
 *
 * A decision prompt therefore posts as agent_commentary, which already requires
 * a bot token holding agent_activity:write, so a human session cannot forge
 * one.
 */
const decisionTurnPrefix = "decision:";

/** Builds the turn_id that marks one decision prompt. */
export function decisionTurnId(requestId: string, revision: number): string {
  return `${decisionTurnPrefix}${requestId}:${revision}`;
}

/** True when a turn_id marks a workflow decision prompt. */
export function isDecisionTurnId(turnId: string | undefined): boolean {
  return turnId !== undefined && turnId.startsWith(decisionTurnPrefix);
}

export function renderDecisionPrompt(decision: ClaimedWorkflowDecision): string {
  const lines = [
    `**${decision.title}**`,
    "",
    decision.summary,
    "",
  ];
  decision.choices.forEach((choice, index) => {
    const suffix = choice.expectsInput ? " _(reply with your answer after the number)_" : "";
    lines.push(`${index + 1}. ${choice.label}${suffix}`);
  });
  lines.push("", "_Reply with a number to answer. Reply `cancel` to leave it pending._");
  return lines.join("\n");
}

export type DecisionReply =
  | { kind: "answer"; answer: DecisionAnswer }
  | { kind: "dismissed" }
  | { kind: "unmatched" };

/**
 * Reads one operator reply against a presented decision.
 *
 * A choice that collects text takes everything after the number as its input.
 * A choice that expects input but receives none is unmatched rather than
 * answered, because an empty instruction would route the workflow onward with
 * nothing to act on.
 */
export function readDecisionReply(
  decision: ClaimedWorkflowDecision,
  body: string,
): DecisionReply {
  const trimmed = body.trim();
  if (trimmed === "") return { kind: "unmatched" };
  if (dismissals.has(trimmed.toLowerCase())) return { kind: "dismissed" };

  const numbered = /^(\d+)[.):]?\s*(.*)$/su.exec(trimmed);
  if (numbered === null) return matchByLabel(decision, trimmed);

  const position = Number.parseInt(numbered[1] ?? "", 10);
  const choice = decision.choices[position - 1];
  if (choice === undefined) return { kind: "unmatched" };

  const remainder = (numbered[2] ?? "").trim();
  if (!choice.expectsInput) {
    return { kind: "answer", answer: { choice: choice.key } };
  }
  if (remainder === "") return { kind: "unmatched" };
  return {
    kind: "answer",
    answer: { choice: choice.key, input: { instructions: remainder } },
  };
}

/** Falls back to an exact, unambiguous label or key match. */
function matchByLabel(decision: ClaimedWorkflowDecision, body: string): DecisionReply {
  const normalized = body.toLowerCase();
  const matches = decision.choices.filter(
    (choice) => choice.label.toLowerCase() === normalized || choice.key.toLowerCase() === normalized,
  );
  const choice = matches.length === 1 ? matches[0] : undefined;
  if (choice === undefined || choice.expectsInput) return { kind: "unmatched" };
  return { kind: "answer", answer: { choice: choice.key } };
}
