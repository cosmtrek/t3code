/**
 * The wake packet: everything one turn needs, so no turn depends on what an earlier one left in
 * the provider's context. Pure, so its shape and caps are tested without a server.
 */
import type { ChatMessage } from "./store.ts";

/** Chat before the new messages; older chat lives in the work thread or is not needed. */
export const RECENT_CHAT_LIMIT = 10;
/** One chat message in the packet; a longer one is cut, its rest stays in the chat. */
const MESSAGE_CHARS = 2_000;

export interface PacketInput {
  readonly name: string;
  readonly role: string;
  /** Messages already answered, oldest first. */
  readonly recentChat: ReadonlyArray<ChatMessage>;
  /** User messages this turn answers, oldest first. */
  readonly newMessages: ReadonlyArray<ChatMessage>;
}

const clip = (value: string) =>
  value.length > MESSAGE_CHARS ? `${value.slice(0, MESSAGE_CHARS)}… (cut)` : value;

const speaker = (message: ChatMessage) =>
  message.role === "user" ? "the user" : message.role === "bot" ? "you" : "error";

const line = (message: ChatMessage) =>
  `- ${speaker(message)} (${message.createdAt}): ${clip(message.text)}`;

export function buildPacket(input: PacketInput): string {
  const role = input.role.trim();
  const recent = input.recentChat
    .slice(-RECENT_CHAT_LIMIT)
    .filter((message) => message.role !== "error");
  return [
    `You are ${input.name}, a bot working for the user in T3 Code.`,
    role === ""
      ? "The user has not told you your job yet. Ask what you should take care of."
      : `Your role, in the user's words:\n${role}`,
    "",
    "This thread is your workspace; the user does not read it. Your last message in this turn is " +
      "posted to your chat with the user, so end with the reply itself, written to them.",
    ...(recent.length > 0 ? ["", "Recent chat with the user:", ...recent.map(line)] : []),
    "",
    "New from the user:",
    ...input.newMessages.map(line),
  ].join("\n");
}
