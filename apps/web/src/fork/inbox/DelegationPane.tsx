import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { ThreadId, type EnvironmentId, type ScopedThreadRef } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import {
  ChevronDownIcon,
  CircleAlertIcon,
  CircleDashedIcon,
  CircleDotDashedIcon,
  MessageCircleQuestionIcon,
  ShieldQuestionIcon,
  UserRoundIcon,
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
import { useThreadShell } from "../../state/entities";
import type { DelegationDetail, LinkedThread } from "../types";
import { authorsSummary, skippedNotice } from "./inboxView";
import { MessageView } from "./MessageView";

/** The sidebar's words, for when the thread is not in this client's sidebar state. */
const THREAD_STATUS_LABELS: Readonly<Record<LinkedThread["status"], string | null>> = {
  running: null,
  idle: null,
  archived: "Archived",
  deleted: "Thread deleted",
  unknown: null,
};

/** The sidebar row's status words, icons and colors, so a thread reads the same in both places. */
const SIDEBAR_STATUS: Readonly<
  Record<
    Exclude<SidebarThreadStatus, "ready">,
    { label: string; icon: typeof CircleDashedIcon; className: string }
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

/**
 * A delegation: the messages it covers and the reply the thread drafted, over the thread itself.
 * The conversation with the agent is the thread's own chat, so its findings, requests, approvals
 * and launched threads show as they do everywhere else.
 */
export function DelegationPane({
  environmentId,
  detail,
  sendingOff,
  onUseDraft,
  onDiscardDraft,
}: {
  readonly environmentId: EnvironmentId;
  readonly detail: DelegationDetail;
  readonly sendingOff: boolean;
  /** Puts the draft into the conversation's reply box. */
  readonly onUseDraft: (text: string) => void;
  readonly onDiscardDraft: (draft: string) => void;
}) {
  const thread = detail.delegation.thread;
  const live = thread !== null && thread.status !== "deleted" ? thread : null;
  const threadRef = live ? scopeThreadRef(environmentId, ThreadId.make(live.threadId)) : null;
  const shell = useThreadShell(threadRef);
  const draft = detail.draft?.trim() ?? "";
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <SourceMessages
        environmentId={environmentId}
        detail={detail}
        status={live ? <ThreadStatus environmentId={environmentId} thread={live} /> : null}
      />

      {draft.length > 0 ? (
        <div className="flex shrink-0 flex-col gap-2.5 border-b border-border/70 bg-muted/40 px-4 py-3">
          <h3 className="text-xs font-medium text-muted-foreground">Draft reply</h3>
          <p className="max-h-40 overflow-y-auto text-sm whitespace-pre-wrap wrap-anywhere">
            {draft}
          </p>
          <div className="flex gap-2">
            <Button
              size="xs"
              variant="outline"
              disabled={sendingOff || !detail.canSend}
              onClick={() => onUseDraft(draft)}
            >
              Accept
            </Button>
            <Button size="xs" variant="ghost-muted" onClick={() => onDiscardDraft(draft)}>
              Discard
            </Button>
          </div>
        </div>
      ) : null}

      {threadRef !== null && shell !== null ? (
        <DelegatedThreadChat threadRef={threadRef} />
      ) : (
        <p className="px-4 py-3 text-sm text-muted-foreground">
          {thread === null ? "No thread yet." : "The thread was deleted."}
        </p>
      )}
    </div>
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

/** The delegated messages, folded to their authors beside the thread's status. */
function SourceMessages({
  environmentId,
  detail,
  status,
}: {
  readonly environmentId: EnvironmentId;
  readonly detail: DelegationDetail;
  readonly status: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const authors = authorsSummary(detail.messages);
  const count = detail.messages.length;
  const notices = [
    detail.complete
      ? null
      : "These messages run past what T3 Code reads; only part of them is shown.",
    detail.rootMissing
      ? "The message this reply thread started from is no longer available."
      : null,
    skippedNotice(detail.skipped),
  ].filter((notice) => notice !== null);
  return (
    <section
      className={cn(
        "flex max-h-[45%] min-w-0 shrink-0 flex-col gap-2 border-b border-border/70 px-4 py-2.5",
        open && "overflow-y-auto overscroll-contain",
      )}
    >
      <header className="flex min-w-0 items-center gap-2">
        {count === 0 ? (
          <span className="flex-1" />
        ) : (
          <button
            type="button"
            aria-expanded={open}
            className="flex min-w-0 flex-1 items-center gap-2 text-left text-xs text-muted-foreground hover:text-foreground"
            onClick={() => setOpen(!open)}
          >
            <ChevronDownIcon className={cn("size-3.5 shrink-0", !open && "-rotate-90")} />
            <span className="shrink-0 font-medium">
              {count === 1 ? "1 message" : `${count} messages`}
            </span>
            {authors !== null && !open ? (
              <span className="min-w-0 truncate">· {authors}</span>
            ) : null}
          </button>
        )}
        {status}
      </header>
      {notices.map((notice) => (
        <p key={notice} className="text-xs text-warning">
          {notice}
        </p>
      ))}
      {open ? (
        <ol className="flex flex-col gap-3">
          {detail.messages.map((message, index) => (
            <li key={message.id} className="flex min-w-0 flex-col">
              <MessageView
                environmentId={environmentId}
                channelId={detail.delegation.channelId}
                message={message}
                showAuthor={detail.messages[index - 1]?.author.id !== message.author.id}
              />
            </li>
          ))}
        </ol>
      ) : null}
    </section>
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
}: {
  readonly environmentId: EnvironmentId;
  readonly thread: LinkedThread;
  readonly fallback?: ReactNode;
}) {
  const shell = useThreadShell(scopeThreadRef(environmentId, ThreadId.make(thread.threadId)));
  const status = shell
    ? resolveSidebarRowStatus(shell)
    : thread.status === "running"
      ? "working"
      : null;
  if (status !== null && status !== "ready") {
    const { label, icon: Icon, className } = SIDEBAR_STATUS[status];
    return (
      <span
        className={cn("inline-flex shrink-0 items-center gap-1 text-xs font-medium", className)}
      >
        <Icon aria-hidden className="size-3 shrink-0" />
        {label}
      </span>
    );
  }
  const label = THREAD_STATUS_LABELS[thread.status];
  if (label === null) return fallback;
  return <span className="shrink-0 text-xs text-muted-foreground">{label}</span>;
}
