import type { EnvironmentId } from "@t3tools/contracts";
import type { DeviceHubAccess } from "@t3tools/client-runtime/state/deviceHubAccess";
import { DownloadIcon, ExternalLinkIcon, LinkIcon } from "lucide-react";
import { useId, useState, type ReactNode } from "react";

import ChatMarkdown from "../../components/ChatMarkdown";
import { ExpandedImageDialog } from "../../components/chat/ExpandedImageDialog";
import { InlineButton } from "../../components/ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../components/ui/tooltip";
import { cn } from "../../lib/utils";
import { forkUrl, renewForkAccess, renewStaleForkAccess, useForkAccess } from "../forkApiAccess";
import { useFormatTimestamp } from "../presentation";
import type { InboxMessage } from "../types";
import { mentionParts, nameOrUnknown, shortLink } from "./inboxView";

type Mentions = InboxMessage["mentions"];

export function MessageView({
  environmentId,
  channelId,
  message,
  showAuthor,
  continued = false,
  inThread = false,
  quote,
  children,
  toolbar,
  layout = "bubble",
}: {
  readonly environmentId: EnvironmentId;
  readonly channelId: string;
  readonly message: InboxMessage;
  readonly showAuthor: boolean;
  /** Follows the same author's message closely, so it drops its header as the chat app does. */
  readonly continued?: boolean;
  /** A reply under its root hangs off the thread line, so every author sits on its side. */
  readonly inThread?: boolean;
  /** The message this one answers, shown above it as the chat app does. */
  readonly quote?: string | null;
  /** Shown under the message, such as the delegations that start there. */
  readonly children?: ReactNode;
  /** Actions shown beside the message, on its side away from the edge. */
  readonly toolbar?: ReactNode;
  /** `post` is a topic group's: full width, left-aligned, the text without a bubble. */
  readonly layout?: "bubble" | "post";
}) {
  const post = layout === "post";
  const access = useForkAccess(environmentId);
  const formatTimestamp = useFormatTimestamp();
  const self = message.author.isSelf;
  const atEnd = self && !inThread;
  const hasText = message.text.trim().length > 0;
  // A link the text already shows is a link there, not a second line under the bubble.
  const extraLinks = message.links.filter((link) => !message.text.includes(link));
  const unsupported =
    !hasText &&
    !message.richSummary &&
    message.attachments.length === 0 &&
    message.links.length === 0;
  // Bare media keeps no frame, as the chat app shows a lone image; a topic post's text has none.
  const frame: "self" | "muted" | "dashed" | "none" = message.richSummary
    ? "muted"
    : unsupported
      ? "dashed"
      : post || (!hasText && !quote)
        ? "none"
        : self
          ? "self"
          : "muted";
  const markdown = message.format === "markdown";
  const reactions = message.reactions ?? [];
  // The adapter's list marks my mention in the text itself; without it the header says so.
  const selfMarked = message.mentions?.some((mention) => mention.isSelf) ?? false;
  const media = (
    <>
      {message.attachments.map((attachment) => {
        if (access === null) {
          return (
            <span
              key={attachment.key}
              className="rounded-xl border border-border/60 px-3 py-1.5 text-xs text-muted-foreground"
            >
              {attachment.kind === "image" ? "Image" : "File"}: {attachment.name}
            </span>
          );
        }
        const path = `/inbox/media?${new URLSearchParams({ channelId, messageId: message.id, key: attachment.key }).toString()}`;
        if (attachment.kind === "image") {
          return (
            <MediaImage
              key={attachment.key}
              environmentId={environmentId}
              access={access}
              alt={attachment.name}
              path={path}
            />
          );
        }
        return (
          <div key={attachment.key} className="flex max-w-full min-w-0 flex-col gap-1">
            {VIDEO_NAME.test(attachment.name) ? (
              <MediaVideo environmentId={environmentId} access={access} path={path} />
            ) : null}
            <MediaLink
              environmentId={environmentId}
              access={access}
              name={attachment.name}
              path={path}
            />
          </div>
        );
      })}
      {extraLinks.length > 0 ? (
        <ul className="flex max-w-full min-w-0 flex-wrap gap-1 text-xs">
          {extraLinks.map((link) => (
            <li key={link} className="min-w-0">
              <Tooltip>
                <TooltipTrigger
                  render={
                    <a
                      className="inline-flex max-w-full min-w-0 items-center gap-1 rounded-md border border-border/60 px-1.5 py-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
                      href={link}
                      target="_blank"
                      rel="noreferrer noopener"
                    />
                  }
                >
                  <LinkIcon className="size-3.5 shrink-0" />
                  <span className="truncate">{shortLink(link)}</span>
                </TooltipTrigger>
                <TooltipPopup side="top" className="max-w-md break-all">
                  {link}
                </TooltipPopup>
              </Tooltip>
            </li>
          ))}
        </ul>
      ) : null}
    </>
  );
  const body = (
    <>
      {message.richSummary ? (
        <RichCard
          title={message.richSummary}
          text={message.text}
          links={message.links}
          mentions={message.mentions}
          openUrl={message.openUrl ?? null}
        />
      ) : hasText && markdown ? (
        <ChatMarkdown
          text={message.text}
          cwd={undefined}
          headingLevelOffset={3}
          className="text-sm"
        />
      ) : hasText ? (
        <p className="max-w-full text-sm whitespace-pre-wrap wrap-anywhere">
          <LinkedText text={message.text} links={message.links} mentions={message.mentions} />
          {message.editedAt ? <EditedMark /> : null}
        </p>
      ) : null}
      {message.editedAt && (markdown || !hasText || message.richSummary) ? <EditedMark /> : null}
      {media}
      {unsupported ? (
        <p className="text-xs text-muted-foreground">
          Unsupported message
          {message.openUrl ? (
            <>
              {" · "}
              <a
                className="text-foreground underline-offset-2 hover:underline"
                href={message.openUrl}
                target="_blank"
                rel="noreferrer noopener"
              >
                Open in app
              </a>
            </>
          ) : null}
        </p>
      ) : null}
      {reactions.length > 0 ? <Reactions reactions={reactions} /> : null}
    </>
  );
  if (isSystemNotice(message)) {
    return (
      <p className="self-center px-3 text-center text-xs text-muted-foreground">
        {message.richSummary} ·{" "}
        <time dateTime={message.createdAt}>{formatTimestamp(message.createdAt)}</time>
      </p>
    );
  }
  return (
    <article
      className={cn(
        "relative flex min-w-0 flex-col gap-1",
        post
          ? "items-start self-stretch"
          : // Room beside the bubble for the toolbar, as the chat app leaves it.
            [
              toolbar ? "max-w-[min(85%,calc(100%-6rem))]" : "max-w-[85%]",
              atEnd ? "items-end self-end" : "items-start self-start",
            ],
      )}
    >
      {toolbar ? (
        <div className={cn("absolute -top-1.5 z-10", atEnd ? "end-full me-1" : "start-full ms-1")}>
          {toolbar}
        </div>
      ) : null}
      <header
        className={cn(
          "flex min-w-0 items-baseline gap-2 text-xs text-muted-foreground",
          // As the chat app: a run of one speaker, and my own side, carry no header.
          (continued || (atEnd && !post)) && !(message.mentionsSelf && !selfMarked) && "sr-only",
        )}
      >
        {showAuthor && (post || !atEnd) ? (
          <span className={cn("truncate", post && "font-medium text-foreground")}>
            {nameOrUnknown(message.author.name)}
          </span>
        ) : null}
        <time
          className={cn(
            "shrink-0",
            !post &&
              "opacity-0 group-hover/message:opacity-100 group-focus-within/message:opacity-100",
          )}
          dateTime={message.createdAt}
        >
          {formatTimestamp(message.createdAt)}
        </time>
        {message.mentionsSelf && !selfMarked ? (
          <span className="shrink-0 font-medium text-primary">@you</span>
        ) : null}
      </header>
      {frame === "none" ? (
        <>
          {quote ? <QuoteLine text={quote} /> : null}
          {body}
        </>
      ) : (
        // Quote, content, and media are one message, so they share one frame as the chat app draws it.
        <div
          className={cn(
            "flex max-w-full min-w-0 flex-col items-start gap-1.5 text-sm",
            frame === "dashed"
              ? "rounded-lg border border-dashed border-border/70 px-3 py-1.5"
              : [
                  "rounded-lg px-3 py-2",
                  frame === "self"
                    ? "bg-primary/12 text-foreground"
                    : "bg-message text-message-foreground",
                ],
          )}
        >
          {quote ? <QuoteLine text={quote} /> : null}
          {body}
        </div>
      )}
      {children}
    </article>
  );
}

function QuoteLine({ text }: { readonly text: string }) {
  return (
    <p className="max-w-full truncate border-s-2 border-muted-foreground/40 ps-2 text-xs text-muted-foreground">
      {text}
    </p>
  );
}

function EditedMark() {
  return <span className="ms-1 text-xs text-muted-foreground">(edited)</span>;
}

/** Each reaction as the chat app draws it: the emoji, then who reacted. */
function Reactions({ reactions }: { readonly reactions: NonNullable<InboxMessage["reactions"]> }) {
  return (
    <ul className="flex max-w-full flex-wrap gap-1">
      {reactions.map((reaction) => {
        const names = reaction.users.slice(0, 3).join(", ");
        const more = reaction.count - Math.min(reaction.users.length, 3);
        return (
          <li
            key={reaction.key}
            className={cn(
              "inline-flex max-w-full min-w-0 items-center gap-1.5 rounded-full border bg-background/70 px-2 py-0.5 text-xs",
              reaction.includesSelf ? "border-primary/40" : "border-transparent",
            )}
          >
            <span className="shrink-0">{reaction.emoji ?? reaction.key}</span>
            <span className="h-3 w-px shrink-0 bg-border" aria-hidden />
            <span className="truncate text-muted-foreground">
              {names || reaction.count}
              {names && more > 0 ? ` +${more}` : ""}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * Forwards and cards: the adapter flattens the body into `text`, so it reads as the card's
 * content under its title, clamped as the chat app's preview is.
 */
function RichCard({
  title,
  text,
  links,
  mentions,
  openUrl,
}: {
  readonly title: string;
  readonly text: string;
  readonly links: ReadonlyArray<string>;
  readonly mentions: Mentions;
  readonly openUrl: string | null;
}) {
  const bodyId = useId();
  const [expanded, setExpanded] = useState(false);
  const body = text.trim();
  const canExpand = body.length > 160 || body.split("\n").length > 3;
  return (
    <div className="flex max-w-full min-w-0 flex-col gap-1">
      <p className="border-s-2 border-border ps-2 font-medium leading-tight whitespace-pre-wrap wrap-anywhere">
        {title}
      </p>
      {body ? (
        <p
          id={bodyId}
          className={cn(
            "ps-2.5 text-muted-foreground whitespace-pre-wrap wrap-anywhere",
            canExpand && !expanded && "line-clamp-3",
          )}
        >
          <LinkedText text={body} links={links} mentions={mentions} />
        </p>
      ) : null}
      {canExpand || openUrl ? (
        <div className="flex items-center gap-3 ps-2.5 text-xs">
          {canExpand ? (
            <InlineButton
              aria-expanded={expanded}
              aria-controls={bodyId}
              tone="muted"
              onClick={() => setExpanded((value) => !value)}
            >
              {expanded ? "Show less" : "Show more"}
            </InlineButton>
          ) : null}
          {openUrl ? (
            <a
              className="inline-flex items-center gap-1 text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
              href={openUrl}
              target="_blank"
              rel="noreferrer noopener"
            >
              Open in app <ExternalLinkIcon className="size-3.5" />
            </a>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function LinkedText({
  text,
  links,
  mentions,
}: {
  readonly text: string;
  readonly links: ReadonlyArray<string>;
  readonly mentions: Mentions;
}) {
  const known = links.filter((link) => link.length > 0 && text.includes(link));
  if (known.length === 0) return <MentionedText text={text} mentions={mentions} />;
  // Longest first, so a link that contains another is matched whole.
  const pattern = new RegExp(
    `(${known
      .toSorted((left, right) => right.length - left.length)
      .map((link) => link.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join("|")})`,
  );
  return text.split(pattern).map((part, index) =>
    index % 2 === 1 ? (
      <a
        // oxlint-disable-next-line react/no-array-index-key -- parts are positional and never reorder
        key={index}
        className="text-info-foreground underline-offset-2 hover:underline"
        href={part}
        target="_blank"
        rel="noreferrer noopener"
      >
        {part}
      </a>
    ) : (
      // oxlint-disable-next-line react/no-array-index-key -- parts are positional and never reorder
      <MentionedText key={index} text={part} mentions={mentions} />
    ),
  );
}

function MentionedText({ text, mentions }: { readonly text: string; readonly mentions: Mentions }) {
  return mentionParts(text, mentions).map((part, index) =>
    part.mention ? (
      <span
        // oxlint-disable-next-line react/no-array-index-key -- parts are positional and never reorder
        key={index}
        className={
          part.mention.self ? "rounded bg-primary px-1 text-primary-foreground" : "text-primary"
        }
      >
        {part.text}
      </span>
    ) : (
      part.text
    ),
  );
}

/** Feishu's adapter writes join/leave notices as author "1" with only a summary line. */
const SYSTEM_AUTHOR_ID = "1";

function isSystemNotice(message: InboxMessage): boolean {
  return (
    message.author.id === SYSTEM_AUTHOR_ID &&
    message.text.trim().length === 0 &&
    message.attachments.length === 0 &&
    message.links.length === 0 &&
    !!message.richSummary
  );
}

const VIDEO_NAME = /\.(mp4|mov|m4v|webm)$/i;

/** The server names the download from `name`; `download` alone is ignored across origins. */
function MediaLink({
  environmentId,
  access,
  name,
  path,
}: {
  readonly environmentId: EnvironmentId;
  readonly access: DeviceHubAccess;
  readonly name: string;
  readonly path: string;
}) {
  const renew = () => renewStaleForkAccess(environmentId, access);
  return (
    <a
      className="inline-flex max-w-full min-w-0 items-center gap-1.5 self-start rounded-xl border border-border/60 px-3 py-1.5 text-xs text-foreground underline-offset-2 hover:underline"
      href={forkUrl(access, `${path}&${new URLSearchParams({ name }).toString()}`)}
      download={name}
      target="_blank"
      rel="noreferrer noopener"
      onPointerEnter={renew}
      onFocus={renew}
    >
      <DownloadIcon className="size-3.5 shrink-0" />
      <span className="truncate">{name}</span>
    </a>
  );
}

/** Loads nothing until played, so a chat full of videos costs no bandwidth. */
function MediaVideo({
  environmentId,
  access,
  path,
}: {
  readonly environmentId: EnvironmentId;
  readonly access: DeviceHubAccess;
  readonly path: string;
}) {
  const [renewed, setRenewed] = useState(false);
  const [failed, setFailed] = useState(false);
  if (failed) return null;
  return (
    <video
      controls
      preload="none"
      className="max-h-72 max-w-full rounded-xl border border-border/60"
      src={forkUrl(access, path)}
      onError={() => {
        if (renewed) {
          setFailed(true);
          return;
        }
        setRenewed(true);
        renewForkAccess(environmentId);
      }}
    />
  );
}

/** The URL carries a ticket that can expire; one failed load renews it and tries once more. */
function MediaImage({
  environmentId,
  access,
  alt,
  path,
}: {
  readonly environmentId: EnvironmentId;
  readonly access: DeviceHubAccess;
  readonly alt: string;
  readonly path: string;
}) {
  const [renewed, setRenewed] = useState(false);
  const [failed, setFailed] = useState(false);
  const [expanded, setExpanded] = useState(false);
  if (failed)
    return <span className="text-xs text-muted-foreground">Image: {alt} (not loaded)</span>;
  const src = forkUrl(access, path);
  return (
    <>
      <button
        type="button"
        aria-label={`Expand ${alt}`}
        className="max-w-full cursor-zoom-in rounded-xl"
        onClick={() => setExpanded(true)}
      >
        <img
          alt={alt}
          loading="lazy"
          className="max-h-72 max-w-full rounded-xl border border-border/60 object-contain"
          src={src}
          onError={() => {
            if (renewed) {
              setFailed(true);
              return;
            }
            setRenewed(true);
            renewForkAccess(environmentId);
          }}
        />
      </button>
      {expanded ? (
        <ExpandedImageDialog
          preview={{ images: [{ src, name: alt }], index: 0 }}
          onClose={() => setExpanded(false)}
        />
      ) : null}
    </>
  );
}
