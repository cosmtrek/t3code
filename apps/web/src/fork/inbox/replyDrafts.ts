import type { Mention } from "../types";
import type { ReplyTarget } from "./ConversationPane";

/** What the reply box held, kept per conversation in this browser so switching away loses nothing. */
export interface SavedReply {
  readonly text: string;
  readonly replyTo: ReplyTarget | null;
  readonly draft: { readonly text: string; readonly delegationId: string } | null;
}

export const replyDraftKey = (environmentId: string, channelId: string, conversationId: string) =>
  `t3code:inbox-reply:${environmentId}\u0000${channelId}\u0000${conversationId}`;

const isString = (value: unknown): value is string => typeof value === "string";

function mentionOf(value: unknown): Mention | null {
  if (typeof value !== "object" || value === null) return null;
  const { userId, name } = value as Record<string, unknown>;
  return isString(userId) && isString(name) ? { userId, name } : null;
}

function parse(raw: string): SavedReply | null {
  const value: unknown = JSON.parse(raw);
  if (typeof value !== "object" || value === null) return null;
  const { text, replyTo, draft } = value as Record<string, unknown>;
  if (!isString(text)) return null;
  const target =
    typeof replyTo === "object" && replyTo !== null ? (replyTo as Record<string, unknown>) : null;
  const from =
    typeof draft === "object" && draft !== null ? (draft as Record<string, unknown>) : null;
  return {
    text,
    replyTo:
      target && isString(target.messageId) && isString(target.quote)
        ? {
            messageId: target.messageId,
            quote: target.quote,
            inThread: typeof target.inThread === "boolean" ? target.inThread : null,
            canSwitch: target.canSwitch === true,
            mention: mentionOf(target.mention),
          }
        : null,
    draft:
      from && isString(from.text) && isString(from.delegationId)
        ? { text: from.text, delegationId: from.delegationId }
        : null,
  };
}

export function loadReply(key: string): SavedReply | null {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? null : parse(raw);
  } catch {
    return null;
  }
}

/** An empty reply removes the entry. */
export function saveReply(key: string, reply: SavedReply): void {
  try {
    if (reply.text.trim().length === 0) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(reply));
  } catch {
    // Storage is a convenience; without it the reply box simply starts empty.
  }
}
