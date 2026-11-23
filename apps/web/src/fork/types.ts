import type { ModelSelection } from "@t3tools/contracts";

/**
 * Responses of `/api/fork/*`, mirrored from apps/server/src/fork (channels/hub.ts,
 * inbox/operations.ts). Contracts stay untouched, so these change together with the server.
 */
export type ChannelStatus =
  | "disabled"
  | "token_missing"
  | "unreachable"
  | "unauthorized"
  | "incompatible"
  | "needs_login"
  | "collector_stopped"
  | "online";

export type ChannelKind = "http-adapter" | "example";

export type ExampleSimulation =
  | "online"
  | "needs_login"
  | "collector_stopped"
  | "unreachable"
  | "incompatible";

export interface ChannelCheckStep {
  readonly id: "token" | "connect" | "auth" | "protocol" | "login" | "online";
  readonly ok: boolean;
  readonly detail: string;
}

export interface ChannelView {
  readonly id: string;
  readonly kind: ChannelKind;
  readonly name: string;
  readonly baseUrl: string;
  readonly tokenFile: string;
  readonly enabled: boolean;
  readonly status: ChannelStatus;
  readonly statusSince: string;
  readonly lastCheckedAt: string | null;
  readonly steps: ReadonlyArray<ChannelCheckStep>;
  readonly tokenWarning: string | null;
  readonly health: {
    readonly protocol: number;
    readonly adapterVersion: string;
    readonly online: boolean;
    readonly loggedIn: boolean;
    readonly lastSyncAt: string | null;
    readonly self: { readonly name: string };
    readonly logsUrl?: string | null;
    readonly lastError?: string | null;
  } | null;
  readonly config: {
    readonly displayName: string;
    readonly defaultProjectPaths: ReadonlyArray<string>;
    readonly relevanceSummary: string;
  } | null;
  readonly projectMatches: ReadonlyArray<{
    readonly path: string;
    readonly projectId: string | null;
    readonly projectTitle: string | null;
  }>;
  readonly simulation: ExampleSimulation | null;
}

/** A check of an adapter that is not saved yet. */
export type ChannelProbe = Pick<
  ChannelView,
  "status" | "steps" | "tokenWarning" | "health" | "config"
>;

export interface ChannelAccess {
  readonly read: boolean;
  readonly send: boolean;
  readonly stale: boolean;
}

export interface InboxChannelSummary {
  readonly id: string;
  readonly name: string;
  readonly kind: ChannelKind;
  readonly status: ChannelStatus;
  readonly statusSince: string;
  readonly lastSyncAt: string | null;
  readonly selfName: string | null;
  readonly access: ChannelAccess;
  /** The optional parts of the protocol the adapter implements, such as `mentions`. */
  readonly capabilities: ReadonlyArray<string>;
  /** Unread DMs, groups that mention me, and unseen agent results. */
  readonly unreadCount: number | null;
  readonly error: string | null;
}

export type ConversationKind = "dm" | "group" | "topic_group";

export interface Author {
  readonly id: string;
  readonly name: string;
  readonly isSelf: boolean;
}

export type LinkedThreadStatus = "running" | "idle" | "archived" | "deleted" | "unknown";

export interface LinkedThread {
  readonly threadId: string;
  readonly projectId: string;
  readonly title: string | null;
  readonly status: LinkedThreadStatus;
  /** When its last run worth a look finished; null while running or after a quiet run. */
  readonly runCompletedAt: string | null;
  readonly createdAt: string;
  readonly detachedAt: string | null;
}

export interface InboxConversation {
  readonly id: string;
  readonly channelId: string;
  readonly kind: ConversationKind;
  readonly name: string;
  readonly lastActivityAt: string;
  readonly lastMessage: {
    readonly id: string;
    readonly createdAt: string;
    readonly author: Author;
    readonly preview: string;
  } | null;
  /** Someone else wrote after every read mark, or the user pinned it unread. */
  readonly unread: boolean;
  /** A mention I have not read or answered since. */
  readonly mentioned: boolean;
  /** The latest read mark; messages after it are new to the reader. */
  readonly readThroughAt: string | null;
  /** Notifications are off for it in the chat app. */
  readonly muted: boolean;
  /** The chat app's unread badge; null or absent when the adapter does not know it. */
  readonly unreadCount?: number | null;
}

export type DelegationScope = "chain" | "range";

export interface InboxDelegation {
  readonly id: string;
  readonly channelId: string;
  readonly conversationId: string;
  /** Empty when the channel no longer lists the conversation. */
  readonly conversationName: string;
  readonly anchorMessageId: string;
  /** Null for one made before delegations had scopes. */
  readonly scope: DelegationScope | null;
  readonly preview: string | null;
  readonly createdAt: string;
  readonly thread: LinkedThread | null;
  /** The thread finished a run after the user last looked. */
  readonly agentUnseen: boolean;
  readonly hasDraft: boolean;
  /** When the user last replied from this delegation; null before the first reply. */
  readonly lastSentAt: string | null;
}

export interface InboxMessage {
  readonly id: string;
  readonly createdAt: string;
  /** The reply thread or topic this message belongs to; null for a root or a lone message. */
  readonly rootId?: string | null;
  /** The message this one answers; author and preview are null when the adapter lacks it. */
  readonly replyTo?: {
    readonly id: string;
    readonly authorName: string | null;
    readonly preview: string | null;
  } | null;
  readonly author: Author;
  /** Kept inside its reply thread or topic: the chat app does not show it on the timeline. */
  readonly inThread?: boolean;
  readonly mentionsSelf: boolean;
  readonly text: string;
  readonly richSummary?: string | null;
  readonly attachments: ReadonlyArray<{
    readonly key: string;
    readonly kind: "image" | "file";
    readonly name: string;
  }>;
  readonly links: ReadonlyArray<string>;
  readonly openUrl?: string | null;
  readonly format?: "text" | "markdown" | null;
  /** Who `text` names as `@name`; absent from adapters that only write the name. */
  readonly mentions?: ReadonlyArray<{
    readonly userId: string;
    readonly name: string;
    readonly isSelf: boolean;
  }> | null;
  readonly reactions?: ReadonlyArray<{
    readonly key: string;
    readonly emoji: string | null;
    readonly count: number;
    readonly users: ReadonlyArray<string>;
    readonly includesSelf: boolean;
  }> | null;
  readonly editedAt?: string | null;
  /** Replies in the thread this message roots, which a page may hold only some of. */
  readonly replyCount?: number | null;
}

export interface InboxResponse {
  /** Newest first. */
  readonly conversations: ReadonlyArray<InboxConversation>;
  /** Newest first. */
  readonly delegations: ReadonlyArray<InboxDelegation>;
  readonly stale: boolean;
  /** The page cap the conversation list hit before the channel's list ended. */
  readonly truncatedAtPages: number | null;
  /** Conversations the adapter sent that do not match the protocol. */
  readonly skipped: number;
  readonly access: ChannelAccess;
  readonly status: ChannelStatus;
}

export interface ConversationResponse {
  /** One page, oldest first. */
  readonly messages: ReadonlyArray<InboxMessage>;
  /** Reads the next older page; null at the conversation's start. */
  readonly nextCursor: string | null;
  readonly stale: boolean;
  readonly skipped: number;
}

export interface Mention {
  readonly userId: string;
  readonly name: string;
}

/** A file the adapter holds until a message names it. */
export interface Upload {
  readonly uploadId: string;
  readonly kind: "image" | "file";
  readonly name: string;
  readonly size: number;
}

export interface SendResult {
  readonly messageId: string;
  /** Names whose mention went out as plain text: nobody was notified for these. */
  readonly unresolvedMentions: ReadonlyArray<string>;
  /** Names of the files that did not go out; the text and the other files did. */
  readonly failedAttachments: ReadonlyArray<string>;
  /** false when the copy in the delegation's folder could not be written; null outside one. */
  readonly archived: boolean | null;
}

export interface DelegationDetail {
  readonly delegation: InboxDelegation;
  readonly conversation: {
    readonly id: string;
    readonly name: string;
    readonly kind: ConversationKind;
  };
  /** What the delegation covers, oldest first. */
  readonly messages: ReadonlyArray<InboxMessage>;
  /** False when the messages run past what T3 Code reads. */
  readonly complete: boolean;
  /** The reply thread's first message is gone from the adapter. */
  readonly rootMissing: boolean;
  readonly stale: boolean;
  readonly skipped: number;
  readonly canSend: boolean;
  readonly draft: string | null;
  readonly previousThreads: ReadonlyArray<LinkedThread>;
}

export type WorkspaceStrategy =
  | { readonly type: "root" }
  | { readonly type: "existing_worktree"; readonly worktreePath: string }
  | {
      readonly type: "worktree";
      readonly baseRef: string;
      readonly branch?: string;
      readonly startFromOrigin?: boolean;
    };

export interface DelegateOptions {
  readonly delegationId: string;
  /** The scope it was delegated with before; null when it never was. */
  readonly scope: DelegationScope | null;
  readonly projects: ReadonlyArray<{
    readonly id: string;
    readonly title: string;
    readonly workspaceRoot: string;
    /** The project's model for new threads, with its options such as effort. */
    readonly defaultModel: ModelSelection | null;
  }>;
  readonly defaultProjectId: string | null;
  /** Where the delegation's last thread worked: its worktree, else the project checkout. */
  readonly defaultWorkspaceStrategy: WorkspaceStrategy;
  readonly existing: LinkedThread | null;
}

/** Responses of `/api/fork/bots/*`, mirrored from apps/server/src/fork/bot. */
export interface BotSummary {
  readonly id: string;
  readonly name: string;
  readonly modelSelection: ModelSelection;
  readonly working: boolean;
  readonly lastMessage: Pick<BotChatMessage, "role" | "text" | "createdAt"> | null;
}

export interface BotChatMessage {
  readonly id: string;
  readonly role: "user" | "bot" | "error";
  readonly text: string;
  readonly createdAt: string;
  /** For a user message: the turn that took it; null while it waits for one. */
  readonly turnRunId: string | null;
}

export interface BotDetail {
  readonly bot: {
    readonly id: string;
    readonly name: string;
    readonly modelSelection: ModelSelection;
    readonly workThreadId: string | null;
  };
  readonly role: string;
  readonly working: boolean;
  /** Oldest first. */
  readonly chat: ReadonlyArray<BotChatMessage>;
}
