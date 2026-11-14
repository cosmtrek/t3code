import { ThreadId, type EnvironmentId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { ExternalLinkIcon, SendIcon } from "lucide-react";
import { useState } from "react";

import { Button } from "../../components/ui/button";
import { Textarea } from "../../components/ui/textarea";
import { cn } from "../../lib/utils";
import { ForkApiError, forkRequest, forkUrl, useForkAccess } from "../forkApiAccess";
import { formatTimestamp } from "../presentation";
import type { InboxMessage, LinkedThread, TopicDetail as TopicDetailData } from "../types";
import { STATE_LABELS } from "./inboxView";

const THREAD_STATUS_LABELS: Readonly<Record<LinkedThread["status"], string>> = {
  running: "Running",
  idle: "Finished",
  archived: "Archived",
  deleted: "Deleted",
  unknown: "Unknown",
};

export function TopicDetail({
  environmentId,
  detail,
  readOnly,
}: {
  readonly environmentId: EnvironmentId;
  readonly detail: TopicDetailData;
  readonly readOnly: boolean;
}) {
  const { item } = detail;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-3">
        <div className="mb-3 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
          <span className="truncate font-medium text-foreground">{item.conversationName}</span>
          <span>·</span>
          <span>{STATE_LABELS[item.state]}</span>
          {item.reopened ? <span>· reopened by a new message</span> : null}
        </div>
        <ol className="flex flex-col gap-3">
          {detail.messages.map((message) => (
            <li key={message.id}>
              <MessageView
                environmentId={environmentId}
                channelId={item.channelId}
                message={message}
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
        disabledReason={
          readOnly
            ? "The adapter is unreachable; sending is off."
            : !detail.canSend
              ? "This channel cannot send right now."
              : null
        }
      />
    </div>
  );
}

function MessageView({
  environmentId,
  channelId,
  message,
}: {
  readonly environmentId: EnvironmentId;
  readonly channelId: string;
  readonly message: InboxMessage;
}) {
  const access = useForkAccess(environmentId);
  return (
    <article className="flex min-w-0 flex-col gap-1">
      <header className="flex min-w-0 items-baseline gap-2 text-xs">
        <span className={cn("truncate font-medium", message.author.isSelf && "text-primary")}>
          {message.author.isSelf ? `${message.author.name} (you)` : message.author.name}
        </span>
        <time className="shrink-0 text-muted-foreground" dateTime={message.createdAt}>
          {formatTimestamp(message.createdAt)}
        </time>
        {message.mentionsSelf ? <span className="shrink-0 text-warning">@you</span> : null}
      </header>
      {message.text.trim() ? (
        <p className="text-sm break-words whitespace-pre-wrap">{message.text}</p>
      ) : null}
      {message.richSummary ? (
        <div className="rounded-md border border-border/60 bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
          <p className="break-words whitespace-pre-wrap">{message.richSummary}</p>
          {message.openUrl ? (
            <a
              className="mt-1 inline-flex items-center gap-1 text-foreground underline-offset-2 hover:underline"
              href={message.openUrl}
              target="_blank"
              rel="noreferrer noopener"
            >
              Open in app <ExternalLinkIcon className="size-3" />
            </a>
          ) : null}
        </div>
      ) : null}
      {message.attachments.map((attachment) =>
        attachment.kind === "image" && access !== null ? (
          <img
            key={attachment.key}
            alt={attachment.name}
            loading="lazy"
            className="max-h-72 max-w-full self-start rounded-md border border-border/60 object-contain"
            src={forkUrl(
              access,
              `/inbox/media?${new URLSearchParams({ channelId, messageId: message.id, key: attachment.key }).toString()}`,
            )}
          />
        ) : (
          <span key={attachment.key} className="text-xs text-muted-foreground">
            {attachment.kind === "image" ? "Image" : "File"}: {attachment.name}
          </span>
        ),
      )}
      {message.links.length > 0 ? (
        <ul className="flex flex-col gap-0.5 text-xs">
          {message.links.map((link) => (
            <li key={link} className="min-w-0 truncate">
              <a
                className="text-muted-foreground underline-offset-2 hover:underline"
                href={link}
                target="_blank"
                rel="noreferrer noopener"
              >
                {link}
              </a>
            </li>
          ))}
        </ul>
      ) : null}
    </article>
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
          {live ? (live.title ?? "Linked thread") : "Earlier conclusion"}
        </h3>
        {live ? (
          <>
            <span className="shrink-0 text-xs text-muted-foreground">
              {THREAD_STATUS_LABELS[live.status]}
            </span>
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
        <>
          {detail.conclusionIsHistorical ? (
            <p className="text-xs text-muted-foreground">Its thread was deleted.</p>
          ) : null}
          <p className="max-h-60 overflow-y-auto text-xs break-words whitespace-pre-wrap">
            {detail.conclusion}
          </p>
        </>
      ) : live?.status === "running" ? (
        <p className="text-xs text-muted-foreground">The thread is still working.</p>
      ) : live ? (
        <p className="text-xs text-muted-foreground">No conclusion yet.</p>
      ) : null}
    </section>
  );
}

function Composer({
  environmentId,
  detail,
  disabledReason,
}: {
  readonly environmentId: EnvironmentId;
  readonly detail: TopicDetailData;
  readonly disabledReason: string | null;
}) {
  const [text, setText] = useState(detail.draft?.trim() ?? "");
  const [seenDraft, setSeenDraft] = useState(detail.draft);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A draft that lands while the field still holds the previous one replaces it; an edit stays.
  if (detail.draft !== seenDraft) {
    setSeenDraft(detail.draft);
    if (detail.draft !== null && text === (seenDraft?.trim() ?? "")) setText(detail.draft.trim());
  }

  const send = async () => {
    setSending(true);
    setError(null);
    try {
      await forkRequest(environmentId, "/inbox/send", {
        method: "POST",
        body: {
          channelId: detail.item.channelId,
          conversationId: detail.item.conversationId,
          topicId: detail.item.topicId,
          text,
        },
      });
      setText("");
    } catch (cause) {
      setError(
        cause instanceof ForkApiError || cause instanceof Error ? cause.message : String(cause),
      );
    } finally {
      setSending(false);
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
      {detail.draft !== null && text === detail.draft.trim() ? (
        <p className="text-xs text-muted-foreground">Draft from the thread. Edit it, then send.</p>
      ) : null}
      <Textarea
        aria-label="Reply"
        value={text}
        rows={3}
        disabled={disabledReason !== null}
        placeholder={disabledReason ?? "Reply in this topic"}
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
        <Button
          type="submit"
          size="sm"
          disabled={disabledReason !== null || sending || text.trim().length === 0}
        >
          <SendIcon />
          {sending ? "Sending…" : "Send"}
        </Button>
      </div>
    </form>
  );
}
