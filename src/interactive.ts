export type InteractiveRequestSpec =
  | { kind: "confirmation"; title: string; message: string }
  | { kind: "selection"; title: string; options: readonly string[] }
  | { kind: "input"; title: string; placeholder?: string }
  | { kind: "editor"; title: string; prefill?: string };

export type InteractiveReply =
  | { kind: "answer"; value: boolean | string }
  | { kind: "cancel" }
  | { kind: "unmatched"; guidance: string };

export function renderInteractivePrompt(request: InteractiveRequestSpec): string {
  const title = request.title.trim() || "Pi needs your input";
  if (request.kind === "confirmation") {
    return [`**${title}**`, request.message.trim(), "Reply `yes` or `no`. Use `/cancel` to cancel."].filter(Boolean).join("\n\n");
  }
  if (request.kind === "selection") {
    const choices = request.options.map((option, index) => `${index + 1}. ${option}`).join("\n");
    return [`**${title}**`, choices, "Reply with a number or the exact option. Use `/cancel` to cancel."].join("\n\n");
  }
  if (request.kind === "input") {
    const placeholder = request.placeholder?.trim();
    return [`**${title}**`, placeholder ? `Expected input: ${placeholder}` : "Reply with your answer.", "Use `/cancel` to cancel."].join("\n\n");
  }
  const prefill = request.prefill?.trim();
  return [
    `**${title}**`,
    prefill ? `Current text:\n\n\`\`\`text\n${prefill}\n\`\`\`` : "Reply with the text to use.",
    "Use `/cancel` to cancel.",
  ].join("\n\n");
}

export function readInteractiveReply(request: InteractiveRequestSpec, body: string): InteractiveReply {
  const answer = body.trim();
  if (/^\/(?:cancel|abort)\s*$/iu.test(answer)) return { kind: "cancel" };

  if (request.kind === "confirmation") {
    if (/^(?:y|yes|confirm|confirmed|ok|okay)\s*[.!]?$/iu.test(answer)) {
      return { kind: "answer", value: true };
    }
    if (/^(?:n|no|deny|denied|reject|rejected)\s*[.!]?$/iu.test(answer)) {
      return { kind: "answer", value: false };
    }
    return { kind: "unmatched", guidance: "reply `yes`, `no`, or `/cancel`." };
  }

  if (request.kind === "selection") {
    const numeric = /^(\d+)\s*[.)]?$/u.exec(answer);
    if (numeric) {
      const index = Number(numeric[1]) - 1;
      const option = request.options[index];
      if (option !== undefined) return { kind: "answer", value: option };
    }
    const matches = request.options.filter((option) => option.localeCompare(answer, undefined, { sensitivity: "accent" }) === 0);
    if (matches.length === 1) return { kind: "answer", value: matches[0]! };
    return {
      kind: "unmatched",
      guidance: `reply with a number from 1 to ${request.options.length}, the exact option, or \`/cancel\`.`,
    };
  }

  if (!answer) return { kind: "unmatched", guidance: "reply with text or `/cancel`." };
  return { kind: "answer", value: answer };
}
