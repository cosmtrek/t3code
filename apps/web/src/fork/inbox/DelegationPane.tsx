import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { ThreadId, type EnvironmentId, type ScopedThreadRef } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import {
  ArchiveIcon,
  CheckIcon,
  CircleAlertIcon,
  CircleDashedIcon,
  CircleDotDashedIcon,
  MessageCircleQuestionIcon,
  ShieldQuestionIcon,
  Trash2Icon,
  UserRoundIcon,
  type LucideIcon,
} from "lucide-react";
import { useState, type ReactNode } from "react";

import ChatView from "../../components/ChatView";
import { BackgroundThreadContext } from "../../components/chat/backgroundThread";
import { resolveSidebarRowStatus, type SidebarThreadStatus } from "../../components/Sidebar.logic";
import { Button } from "../../components/ui/button";
import { ComposerHandleContext } from "../../composerHandleContext";
import { useDiffPanelStore } from "../../diffPanelStore";
import type { SideChatParentPanel } from "../../lib/sideChatPane";
import { cn } from "../../lib/utils";
import { useRightPanelStore } from "../../rightPanelStore";
import { useQuietThreadShells, useThreadShell } from "../../state/entities";
import type { DelegationDetail, LinkedThread } from "../types";
import { skippedNotice } from "./inboxView";
import { ReplyBox, useSendKey } from "./ReplyBox";

/** The sidebar's words, for when the thread is not in this client's sidebar state. */
const THREAD_STATUS_LABELS: Readonly<
  Record<LinkedThread["status"], { label: string; icon: LucideIcon } | null>
> = {
  running: null,
  idle: null,
  archived: { label: "Archived", icon: ArchiveIcon },
  deleted: { label: "Thread deleted", icon: Trash2Icon },
  unknown: null,
};

/** The sidebar row's status words, icons and colors, so a thread reads the same in both places. */
export const SIDEBAR_STATUS: Readonly<
  Record<
    Exclude<SidebarThreadStatus, "ready">,
    { label: string; icon: LucideIcon; className: string }
  >
> = {
  preparing: { label: "Setting up", icon: CircleDashedIcon, className: "text-info-foreground" },
  working: { label: "Working", icon: CircleDashedIcon, className: "text-info-foreground" },
  waiting: { label: "Waiting", icon: CircleDotDashedIcon, className: "text-muted-foreground" },
  approval: { label: "Approval", icon: ShieldQuestionIcon, className: "text-warning-foreground" },
  input: {
    label: "Input",
    icon: MessageCircleQuestionIcon,
    className: "text-indigo-600 dark:text-indigo-300",
  },
  request: { label: "Request", icon: UserRoundIcon, className: "text-guest-foreground" },
  limited: { label: "Limited", icon: CircleAlertIcon, className: "text-warning-foreground" },
  failed: { label: "Failed", icon: CircleAlertIcon, className: "text-error-foreground" },
};

/** Thread states that wait on the user: the list ranks them as Needs you and shows only these. */
export const NEEDS_YOU_STATUSES: ReadonlySet<SidebarThreadStatus> = new Set([
  "approval",
  "input",
  "request",
  "limited",
  "failed",
]);

/** The environment's threads that wait on the user, by thread ID. */
export function useBlockedThreadIds(environmentId: EnvironmentId): ReadonlySet<string> {
  const shells = useQuietThreadShells();
  return new Set(
    shells
      .filter(
        (shell) =>
          shell.environmentId === environmentId &&
          NEEDS_YOU_STATUSES.has(resolveSidebarRowStatus(shell)),
      )
      .map((shell) => shell.id as string),
  );
}

/**
 * A delegation: the reply the thread drafted, over the thread itself. The delegated messages are
 * in the conversation beside it, and the conversation with the agent is the thread's own chat, so
 * its findings, requests, approvals and launched threads show as they do everywhere else.
 */
export function DelegationPane({
  environmentId,
  detail,
  draftReply,
  sendingOff,
  onSendDraft,
  onDiscardDraft,
}: {
  readonly environmentId: EnvironmentId;
  readonly detail: DelegationDetail;
  /** The draft as it would go out, and where; null without one. */
  readonly draftReply: { readonly text: string; readonly target: string | null } | null;
  readonly sendingOff: boolean;
  /** Sends the reply, then settles the follow-up when asked; resolves with the error to show. */
  readonly onSendDraft: (text: string, settle: boolean) => Promise<string | null>;
  readonly onDiscardDraft: () => void;
}) {
  const thread = detail.delegation.thread;
  const live = thread !== null && thread.status !== "deleted" ? thread : null;
  const threadRef = live ? scopeThreadRef(environmentId, ThreadId.make(live.threadId)) : null;
  const shell = useThreadShell(threadRef);
  const notices = [
    detail.complete
      ? null
      : "These messages run past what T3 Code reads; the thread was given only part of them.",
    detail.rootMissing
      ? "The message this reply thread started from is no longer available."
      : null,
    skippedNotice(detail.skipped),
  ].filter((notice) => notice !== null);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {notices.map((notice) => (
        <p key={notice} className={cn(LANE, "shrink-0 pt-2 text-xs text-warning")}>
          {notice}
        </p>
      ))}

      {draftReply !== null ? (
        // A draft the thread rewrites replaces what the user had changed.
        <DraftReply
          key={draftReply.text}
          draft={draftReply.text}
          target={draftReply.target}
          canSend={!sendingOff && detail.canSend}
          onSend={onSendDraft}
          onDiscard={onDiscardDraft}
        />
      ) : null}

      {threadRef !== null && shell !== null ? (
        <DelegatedThreadChat threadRef={threadRef} />
      ) : (
        <p className={cn(LANE, "py-3 text-sm text-muted-foreground")}>
          {thread === null ? "No thread yet." : "The thread was deleted."}
        </p>
      )}
    </div>
  );
}

/** The chat's lanes, so the draft lines up with the messages and the timeline keeps its gutter. */
const LANE = "px-3 sm:px-12";

/** The thread's draft, editable in place and sent from here. */
function DraftReply({
  draft,
  target,
  canSend,
  onSend,
  onDiscard,
}: {
  readonly draft: string;
  readonly target: string | null;
  readonly canSend: boolean;
  readonly onSend: (text: string, settle: boolean) => Promise<string | null>;
  readonly onDiscard: () => void;
}) {
  const [text, setText] = useState(draft);
  const sendKey = useSendKey();
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const send = async (settle = false) => {
    setSending(true);
    setError(null);
    const failure = await onSend(text, settle);
    setSending(false);
    setError(failure);
  };
  const ready = canSend && !sending && text.trim().length > 0;
  return (
    <form
      className={cn(LANE, "shrink-0 border-b border-border/70 py-3")}
      onSubmit={(event) => {
        event.preventDefault();
        if (ready) void send();
      }}
    >
      <ReplyBox
        aria-label="Draft reply"
        value={text}
        disabled={sending}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (sendKey.isSend(event)) {
            event.preventDefault();
            event.currentTarget.form?.requestSubmit();
          }
        }}
        above={
          <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
            <h3 className="shrink-0 font-medium">Draft reply</h3>
            {target !== null ? <p className="min-w-0 truncate">{target}</p> : null}
          </div>
        }
        status={
          error !== null ? <span className="text-destructive-foreground">{error}</span> : null
        }
        actions={
          <>
            <Button
              type="button"
              size="xs"
              variant="ghost-muted"
              disabled={sending}
              onClick={onDiscard}
            >
              Discard
            </Button>
            {/* Sending alone keeps the follow-up open: "looking into it" ends nothing. */}
            <Button
              type="button"
              size="xs"
              variant="outline"
              disabled={!ready}
              onClick={() => void send(true)}
            >
              <CheckIcon />
              Send and settle
            </Button>
          </>
        }
        sending={sending}
        canSend={ready}
      />
    </form>
  );
}

/**
 * The thread's own chat, embedded as a side chat is. Diffs and shell commands need the thread's
 * panel and terminal, so they open the thread.
 */
function DelegatedThreadChat({ threadRef }: { readonly threadRef: ScopedThreadRef }) {
  const navigate = useNavigate();
  const openThread = () =>
    void navigate({
      to: "/$environmentId/$threadId",
      params: { environmentId: threadRef.environmentId, threadId: threadRef.threadId },
    });
  const parentPanel: SideChatParentPanel = {
    hostRef: threadRef,
    openToolDiff: (target) => {
      useDiffPanelStore.getState().selectToolCall(threadRef, target);
      useRightPanelStore.getState().open(threadRef, "diff");
      openThread();
    },
    runShellCommand: openThread,
  };
  return (
    <div data-side-chat-pane={threadRef.threadId} className="flex min-h-0 flex-1 flex-col">
      <BackgroundThreadContext value>
        <ComposerHandleContext value={null}>
          <ChatView
            environmentId={threadRef.environmentId}
            threadId={threadRef.threadId}
            routeKind="server"
            embedded={parentPanel}
          />
        </ComposerHandleContext>
      </BackgroundThreadContext>
    </div>
  );
}

/**
 * The thread's status as the sidebar shows it, live from this client's thread state. A finished
 * thread shows `fallback` instead: the inbox marks unseen results itself, so "Done" is noise.
 */
export function ThreadStatus({
  environmentId,
  thread,
  fallback = null,
  onlyNeedsYou = false,
}: {
  readonly environmentId: EnvironmentId;
  readonly thread: LinkedThread;
  readonly fallback?: ReactNode;
  /** Show only a state that waits on the user, else the fallback. */
  readonly onlyNeedsYou?: boolean;
}) {
  const shell = useThreadShell(scopeThreadRef(environmentId, ThreadId.make(thread.threadId)));
  const status = shell
    ? resolveSidebarRowStatus(shell)
    : thread.status === "running"
      ? "working"
      : null;
  if (onlyNeedsYou) {
    if (status === null || !NEEDS_YOU_STATUSES.has(status)) return fallback;
  }
  if (status !== null && status !== "ready") {
    const { label, icon, className } = SIDEBAR_STATUS[status];
    return <StatusLabel icon={icon} label={label} className={className} />;
  }
  const known = THREAD_STATUS_LABELS[thread.status];
  if (known === null) return fallback;
  return <StatusLabel icon={known.icon} label={known.label} className="text-muted-foreground" />;
}

/** Every delegation status draws as one icon and one word, so a column of them lines up. */
export function StatusLabel({
  icon: Icon,
  label,
  className,
}: {
  readonly icon: LucideIcon;
  readonly label: string;
  readonly className: string;
}) {
  return (
    <span className={cn("inline-flex shrink-0 items-center gap-1 text-xs font-medium", className)}>
      <Icon aria-hidden className="size-3 shrink-0" />
      {label}
    </span>
  );
}
