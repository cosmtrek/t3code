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
    readonly self: { readonly id: string; readonly name: string };
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
  readonly pendingCount: number | null;
  readonly error: string | null;
}

export type ItemState =
  | "needs_reply"
  | "drafted"
  | "investigating"
  | "waiting"
  | "open"
  | "done"
  | "ignored";

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
  readonly createdAt: string;
  readonly detachedAt: string | null;
}

export interface InboxItem {
  readonly id: string;
  readonly channelId: string;
  readonly conversationId: string;
  readonly conversationName: string;
  readonly conversationKind: ConversationKind;
  readonly topicId: string;
  readonly rootMessageId: string;
  readonly preview: string;
  readonly replyCount: number;
  readonly lastMessageAt: string;
  readonly lastAuthor: Author;
  readonly participatedBySelf: boolean;
  readonly state: ItemState;
  readonly category: "direct" | "participated" | "followed" | "other";
  readonly reopened: boolean;
  readonly waitMs: number;
  readonly highlight: boolean;
  readonly score: number;
  readonly mark: { readonly state: "done" | "ignored"; readonly markedAt: string } | null;
  readonly thread: LinkedThread | null;
  readonly hasConclusion: boolean;
  readonly hasDraft: boolean;
}

export interface InboxMessage {
  readonly id: string;
  readonly topicId: string;
  readonly createdAt: string;
  readonly author: Author;
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

export interface TopicDetail {
  readonly item: InboxItem;
  readonly conversation: {
    readonly id: string;
    readonly name: string;
    readonly kind: ConversationKind;
  };
  readonly messages: ReadonlyArray<InboxMessage>;
  readonly stale: boolean;
  readonly canSend: boolean;
  readonly conclusion: string | null;
  readonly draft: string | null;
  readonly conclusionIsHistorical: boolean;
  readonly previousThreads: ReadonlyArray<LinkedThread>;
}

export interface ModelChoice {
  readonly instanceId: string;
  readonly model: string;
}

export interface DelegateOptions {
  readonly itemId: string;
  readonly projects: ReadonlyArray<{
    readonly id: string;
    readonly title: string;
    readonly workspaceRoot: string;
    readonly defaultModel: ModelChoice | null;
  }>;
  readonly defaultProjectId: string | null;
  readonly templates: ReadonlyArray<DelegateTemplate>;
  readonly providers: ReadonlyArray<{
    readonly instanceId: string;
    readonly name: string;
    readonly models: ReadonlyArray<{ readonly slug: string; readonly name: string }>;
  }>;
  readonly existing: LinkedThread | null;
}
