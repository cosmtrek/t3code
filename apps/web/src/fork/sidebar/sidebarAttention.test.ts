import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { InboxConversation, InboxDelegation } from "../types";
import { attentionItems, type AttentionInbox } from "./sidebarAttention";

const ENV = EnvironmentId.make("env");

const conversation = (id: string, minute: number, extra: Partial<InboxConversation>) =>
  ({
    id,
    kind: "group",
    unread: false,
    mentioned: false,
    lastActivityAt: `2026-11-27T10:${String(minute).padStart(2, "0")}:00Z`,
    ...extra,
  }) as InboxConversation;

const followUp = (conversationId: string, extra: Partial<InboxDelegation>) =>
  ({
    id: `d-${conversationId}`,
    conversationId,
    agentUnseen: false,
    hasDraft: false,
    thread: null,
    settledAt: null,
    ...extra,
  }) as InboxDelegation;

const inbox = (
  conversations: ReadonlyArray<InboxConversation>,
  delegations: ReadonlyArray<InboxDelegation> = [],
): AttentionInbox => ({
  environmentId: ENV,
  channels: [{ id: "ch", attention: { conversations, delegations } }],
});

const ids = (items: ReturnType<typeof attentionItems>) => items.map((item) => item.conversation.id);

describe("attentionItems", () => {
  it("puts follow-ups first, then DMs, then mentions, newest first within each", () => {
    const items = attentionItems(
      [
        inbox(
          [
            conversation("mention-old", 1, { mentioned: true }),
            conversation("dm", 2, { kind: "dm", unread: true }),
            conversation("mention-new", 3, { mentioned: true }),
            conversation("follow-up", 0, {}),
          ],
          [followUp("follow-up", { hasDraft: true })],
        ),
      ],
      new Map(),
    );
    expect(ids(items)).toEqual(["follow-up", "dm", "mention-new", "mention-old"]);
    expect(items[0]!.followUp?.id).toBe("d-follow-up");
  });

  it("lists a follow-up only while it waits on the user", () => {
    const thread = { threadId: "t", detachedAt: null } as InboxDelegation["thread"];
    const working = inbox([conversation("c", 1, {})], [followUp("c", { thread })]);
    expect(ids(attentionItems([working], new Map()))).toEqual([]);
    expect(ids(attentionItems([working], new Map([[ENV, new Set(["t"])]])))).toEqual(["c"]);
  });

  it("skips a channel whose listing is not read yet", () => {
    expect(
      attentionItems(
        [{ environmentId: ENV, channels: [{ id: "ch", attention: null }] }],
        new Map(),
      ),
    ).toEqual([]);
  });
});
