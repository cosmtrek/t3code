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

export interface DelegateTemplate {
  readonly id: string;
  readonly name: string;
  readonly prompt: string;
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
    readonly delegateTemplates: ReadonlyArray<DelegateTemplate>;
    readonly relevanceSummary: string;
  } | null;
  readonly projectMatches: ReadonlyArray<{
    readonly path: string;
    readonly projectId: string | null;
    readonly projectTitle: string | null;
  }>;
  readonly simulation: ExampleSimulation | null;
}

/** What a connection test shows; the rest of the channel always comes from the list. */
export interface ChannelTestResult {
  readonly status: ChannelStatus;
  readonly steps: ReadonlyArray<ChannelCheckStep>;
  readonly tokenWarning: string | null;
}

export function toChannelTestResult(channel: ChannelView): ChannelTestResult {
  return { status: channel.status, steps: channel.steps, tokenWarning: channel.tokenWarning };
}

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
  /** Notifications are off for it in the chat app. */
  readonly muted: boolean;
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
  readonly hasConclusion: boolean;
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
  readonly conclusion: string | null;
  readonly draft: string | null;
  readonly conclusionIsHistorical: boolean;
  readonly previousThreads: ReadonlyArray<LinkedThread>;
  /** Questions asked from the inbox and the agent's answers, latest five rounds. */
  readonly followUps: ReadonlyArray<FollowUp>;
  /** Replies sent from this delegation, newest first. */
  readonly sent: ReadonlyArray<SentReply>;
}

export interface SentReply {
  readonly sentAt: string;
  readonly source: "draft" | "edited draft" | "typed";
  readonly text: string;
}

export interface FollowUp {
  readonly role: "user" | "assistant";
  /** What a user entry asked for: an answer, or the reply to send. */
  readonly kind: "question" | "draft";
  readonly text: string;
  readonly at: string;
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

export interface ModelChoice {
  readonly instanceId: string;
  readonly model: string;
}

export interface DelegateOptions {
  readonly delegationId: string;
  /** The scope it was delegated with before; null when it never was. */
  readonly scope: DelegationScope | null;
  readonly projects: ReadonlyArray<{
    readonly id: string;
    readonly title: string;
    readonly workspaceRoot: string;
    readonly defaultModel: ModelChoice | null;
  }>;
  readonly defaultProjectId: string | null;
  /** Where the delegation's last thread worked: its worktree, else the project checkout. */
  readonly defaultWorkspaceStrategy: WorkspaceStrategy;
  readonly templates: ReadonlyArray<DelegateTemplate>;
  readonly providers: ReadonlyArray<{
    readonly instanceId: string;
    readonly name: string;
    readonly models: ReadonlyArray<{ readonly slug: string; readonly name: string }>;
  }>;
  readonly existing: LinkedThread | null;
}
