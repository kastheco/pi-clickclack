export type Brand<Value, Name extends string> = Value & { readonly __brand: Name };

export type ConversationId = Brand<string, "ConversationId">;
export type MessageId = Brand<string, "MessageId">;
export type ProjectAlias = Brand<string, "ProjectAlias">;
export type TurnId = Brand<string, "TurnId">;

export const conversationTypes = ["channel", "direct"] as const;
export type ConversationType = (typeof conversationTypes)[number];

export const invocationModes = ["mention", "always", "auto"] as const;
export type InvocationMode = (typeof invocationModes)[number];

export type ConversationKey = {
  type: ConversationType;
  id: ConversationId;
};

export function toConversationId(value: string): ConversationId {
  return value as ConversationId;
}

export function toMessageId(value: string): MessageId {
  return value as MessageId;
}

export function toProjectAlias(value: string): ProjectAlias {
  return value as ProjectAlias;
}

export function toTurnId(value: string): TurnId {
  return value as TurnId;
}
