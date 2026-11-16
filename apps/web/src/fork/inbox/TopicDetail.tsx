import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { ThreadId, type EnvironmentId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { BotIcon, SendIcon } from "lucide-react";
import { useState } from "react";

import { resolveThreadStatusPill } from "../../components/Sidebar.logic";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Textarea } from "../../components/ui/textarea";
import { toastManager } from "../../components/ui/toast";
import { cn } from "../../lib/utils";
import { useThreadShell } from "../../state/entities";
import { ForkApiError, forkRequest } from "../forkApiAccess";
import type { LinkedThread, SendResult, TopicDetail as TopicDetailData } from "../types";
import {
  nextReplyText,
  replyTargetOf,
  sameDraftSource,
  skippedNotice,
  type DraftSource,
} from "./inboxView";
import { MessageView } from "./MessageView";

/** The sidebar's words, for when the thread is not in this client's sidebar state. */
const THREAD_STATUS_LABELS: Readonly<Record<LinkedThread["status"], string | null>> = {
  running: "Working",
  idle: "Done",
  archived: "Archived",
  deleted: "Thread deleted",
  unknown: null,
};

export function TopicDetail({
  environmentId,
  detail,
  sendingOff,
}: {
  readonly environmentId: EnvironmentId;
  readonly detail: TopicDetailData;
  readonly sendingOff: boolean;
}) {
  const { item } = detail;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-3">
        {detail.truncatedAtPages !== null ? (
          <p className="mb-3 text-xs text-muted-foreground">
            Showing the first {detail.truncatedAtPages} pages.
          </p>
        ) : null}
        {skippedNotice(detail.skipped) ? (
          <p className="mb-3 text-xs text-warning">{skippedNotice(detail.skipped)}</p>
        ) : null}
        <ol className="flex flex-col gap-3">
          {detail.messages.map((message, index) => (
            <li key={message.id} className="flex min-w-0 flex-col">
              <MessageView
                environmentId={environmentId}
                channelId={item.channelId}
                message={message}
                showAuthor={detail.messages[index - 1]?.author.id !== message.author.id}
              />
            </li>
          ))}
        </ol>
        {item.thread || detail.conclusion !== null || detail.previousThreads.length > 0 ? (
          <ThreadCard environmentId={environmentId} detail={detail} />
        ) : null}
      </div>
      <Composer
        key={item.id}
        environmentId={environmentId}
        detail={detail}
        disabled={sendingOff || !detail.canSend}
      />
    </div>
  );
}

function ThreadCard({
  environmentId,
  detail,
}: {
  readonly environmentId: EnvironmentId;
  readonly detail: TopicDetailData;
}) {
  const navigate = useNavigate();
  const thread = detail.item.thread;
  const live = thread !== null && thread.status !== "deleted" ? thread : null;
  return (
    <section className="mt-4 flex flex-col gap-2 rounded-lg border border-border/70 p-3">
      <header className="flex min-w-0 items-center gap-2">
        <h3 className="min-w-0 flex-1 truncate text-sm font-medium">
          {live
            ? (live.title ?? "Linked thread")
            : detail.conclusion !== null
              ? "Earlier conclusion"
              : "Thread deleted"}
        </h3>
        {live ? (
          <>
            <ThreadStatus environmentId={environmentId} thread={live} />
            <Button
              size="xs"
              variant="outline"
              onClick={() =>
                void navigate({
                  to: "/$environmentId/$threadId",
                  params: { environmentId, threadId: ThreadId.make(live.threadId) },
                })
              }
            >
              Open
            </Button>
          </>
        ) : null}
      </header>
      {detail.conclusion !== null ? (
        <Conclusion text={detail.conclusion} />
      ) : live?.status === "idle" ? (
        <p className="text-xs text-muted-foreground">Finished without a conclusion</p>
      ) : null}
      {live && live.status !== "archived" && !detail.conclusionIsHistorical ? (
        <AskThread key={live.threadId} environmentId={environmentId} detail={detail} />
      ) : null}
    </section>
  );
}

const CONCLUSION_LINES = 8;

function Conclusion({ text }: { readonly text: string }) {
  const [expanded, setExpanded] = useState(false);
  // Lines as written; a long wrapped line also counts as more than fits.
  const long = text.split("\n").length > CONCLUSION_LINES || text.length > 640;
  return (
    <div className="flex flex-col items-start gap-1">
      <p
        className={cn(
          "text-xs break-words whitespace-pre-wrap",
          long && !expanded && "line-clamp-8",
        )}
      >
        {text}
      </p>
      {long ? (
        <Button size="xs" variant="ghost-muted" onClick={() => setExpanded(!expanded)}>
          {expanded ? "Show less" : "Show more"}
        </Button>
      ) : null}
    </div>
  );
}

/**
 * Questions for the topic's thread. A box of its own, apart from the reply: what goes in here
 * never reaches the chat app.
 */
function AskThread({
  environmentId,
  detail,
}: {
  readonly environmentId: EnvironmentId;
  readonly detail: TopicDetailData;
}) {
  const [text, setText] = useState("");
  const [asked, setAsked] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const followUps = detail.followUps;
  const lastQuestion = followUps.findLast((entry) => entry.role === "user")?.text ?? null;
  // Shown until the thread's own record of it comes back.
  const pending = asked !== null && asked !== lastQuestion ? asked : null;
  const working = pending !== null || followUps.at(-1)?.role === "user";

  const ask = async () => {
    const question = text.trim();
    if (question.length === 0) return;
    setAsking(true);
    setError(null);
    setAsked(question);
    setText("");
    try {
      await forkRequest(environmentId, "/inbox/ask", {
        method: "POST",
        body: {
          channelId: detail.item.channelId,
          conversationId: detail.item.conversationId,
          topicId: detail.item.topicId,
          text: question,
        },
      });
    } catch (cause) {
      setAsked(null);
      setText(question);
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setAsking(false);
    }
  };

  return (
    <div className="flex flex-col gap-2 border-t border-border/60 pt-2">
      {followUps.length > 0 || pending !== null ? (
        <ol className="flex flex-col gap-1.5 text-xs">
          {followUps.map((entry) => (
            <li key={`${entry.role}:${entry.at}`} className="break-words whitespace-pre-wrap">
              <span className="font-medium">{entry.role === "user" ? "You" : "Agent"}: </span>
              {entry.text}
            </li>
          ))}
          {pending !== null ? (
            <li className="break-words whitespace-pre-wrap">
              <span className="font-medium">You: </span>
              {pending}
            </li>
          ) : null}
          {working ? <li className="text-muted-foreground">Working…</li> : null}
        </ol>
      ) : null}
      <form
        className="flex items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void ask();
        }}
      >
        <BotIcon className="mb-2 size-4 shrink-0 text-muted-foreground" />
        <Textarea
          aria-label="Ask the agent"
          value={text}
          rows={2}
          placeholder="Ask the agent…"
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              event.currentTarget.form?.requestSubmit();
            }
          }}
        />
        <Button
          type="submit"
          size="sm"
          variant="outline"
          disabled={asking || text.trim().length === 0}
        >
          Ask
        </Button>
      </form>
      {error ? <p className="text-xs text-destructive-foreground">{error}</p> : null}
    </div>
  );
}

/** The thread's status as the sidebar shows it, live from this client's thread state. */
function ThreadStatus({
  environmentId,
  thread,
}: {
  readonly environmentId: EnvironmentId;
  readonly thread: LinkedThread;
}) {
  const shell = useThreadShell(scopeThreadRef(environmentId, ThreadId.make(thread.threadId)));
  const pill = shell ? resolveThreadStatusPill({ thread: shell }) : null;
  const label = pill?.label ?? THREAD_STATUS_LABELS[thread.status];
  if (label === null) return null;
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1 text-xs",
        pill?.colorClass ?? "text-muted-foreground",
      )}
    >
      <span className={cn("size-1.5 rounded-full", pill?.dotClass ?? "bg-current opacity-60")} />
      {label}
    </span>
  );
}

function Composer({
  environmentId,
  detail,
  disabled,
}: {
  readonly environmentId: EnvironmentId;
  readonly detail: TopicDetailData;
  readonly disabled: boolean;
}) {
  const source: DraftSource | null =
    detail.draft === null
      ? null
      : { threadId: detail.item.thread?.threadId ?? null, text: detail.draft.trim() };
  const replyTarget = replyTargetOf(detail);
  const [shown, setShown] = useState(source);
  const [text, setText] = useState(source?.text ?? "");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!sameDraftSource(source, shown)) {
    setShown(source);
    setText(nextReplyText(text, shown, source));
  }

  const send = async () => {
    setSending(true);
    setError(null);
    try {
      const result = await forkRequest<SendResult>(environmentId, "/inbox/send", {
        method: "POST",
        body: {
          channelId: detail.item.channelId,
          conversationId: detail.item.conversationId,
          topicId: detail.item.topicId,
          text,
        },
      });
      setText("");
      setSending(false);
      if (result.archived === false) {
        toastManager.add({
          type: "warning",
          title: "Sent, but the copy in the item folder could not be saved.",
        });
      }
    } catch (cause) {
      setSending(false);
      setError(
        cause instanceof ForkApiError && cause.code === "delivery_unknown"
          ? "Delivery unknown: the adapter did not confirm the message. Check the chat before sending again."
          : cause instanceof Error
            ? cause.message
            : String(cause),
      );
    }
  };

  return (
    <form
      className="flex shrink-0 flex-col gap-2 border-t border-border/70 p-3"
      onSubmit={(event) => {
        event.preventDefault();
        void send();
      }}
    >
      {replyTarget !== null || (shown !== null && text === shown.text) ? (
        <div className="flex min-w-0 items-center gap-2">
          {replyTarget !== null ? (
            <p className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
              Replying to {replyTarget}
            </p>
          ) : (
            <span className="flex-1" />
          )}
          {shown !== null && text === shown.text ? <Badge variant="info">Draft</Badge> : null}
        </div>
      ) : null}
      <Textarea
        aria-label="Reply"
        value={text}
        rows={3}
        disabled={disabled}
        placeholder={disabled ? "Sending is off" : "Reply in the chat"}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            event.currentTarget.form?.requestSubmit();
          }
        }}
      />
      <div className="flex items-center gap-2">
        {error ? (
          <p className="min-w-0 flex-1 text-xs text-destructive-foreground">{error}</p>
        ) : (
          <span className="flex-1" />
        )}
        <Button type="submit" size="sm" disabled={disabled || sending || text.trim().length === 0}>
          <SendIcon />
          {sending ? "Sending…" : "Send"}
        </Button>
      </div>
    </form>
  );
}
