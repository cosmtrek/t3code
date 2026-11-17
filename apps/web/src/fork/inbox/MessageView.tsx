import type { EnvironmentId } from "@t3tools/contracts";
import type { DeviceHubAccess } from "@t3tools/client-runtime/state/deviceHubAccess";
import { DownloadIcon, ExternalLinkIcon, LinkIcon } from "lucide-react";
import { useState, type ReactNode } from "react";

import { ExpandedImageDialog } from "../../components/chat/ExpandedImageDialog";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../components/ui/tooltip";
import { cn } from "../../lib/utils";
import { forkUrl, renewForkAccess, renewStaleForkAccess, useForkAccess } from "../forkApiAccess";
import { useFormatTimestamp } from "../presentation";
import type { InboxMessage } from "../types";
import { nameOrUnknown, shortLink } from "./inboxView";

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
          continued && !message.mentionsSelf && "sr-only",
        )}
      >
        {showAuthor && (post || !atEnd) ? (
          <span className="truncate font-medium text-foreground">
            {nameOrUnknown(message.author.name)}
          </span>
        ) : null}
        <time className="shrink-0" dateTime={message.createdAt}>
          {formatTimestamp(message.createdAt)}
        </time>
        {message.mentionsSelf ? <span className="shrink-0 text-warning">@you</span> : null}
      </header>
      {quote ? (
        <p className="max-w-full truncate border-s-2 border-border ps-2 text-xs text-muted-foreground">
          {quote}
        </p>
      ) : null}
      {hasText ? (
        <p
          className={cn(
            "text-sm whitespace-pre-wrap wrap-anywhere",
            post
              ? "max-w-full"
              : self
                ? cn(
                    "rounded-2xl bg-primary px-3 py-2 text-primary-foreground",
                    atEnd ? "rounded-tr-sm" : "rounded-tl-sm",
                  )
                : "rounded-2xl rounded-tl-sm bg-muted px-3 py-2",
          )}
        >
          <LinkedText text={message.text} links={message.links} />
        </p>
      ) : null}
      {message.richSummary ? (
        <div className="rounded-xl border border-border/60 bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
          <p className="whitespace-pre-wrap wrap-anywhere">{message.richSummary}</p>
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
                  <LinkIcon className="size-3 shrink-0" />
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
      {!hasText &&
      !message.richSummary &&
      message.attachments.length === 0 &&
      message.links.length === 0 ? (
        <p className="rounded-xl border border-dashed border-border/70 px-3 py-1.5 text-xs text-muted-foreground">
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
      {children}
    </article>
  );
}

function LinkedText({
  text,
  links,
}: {
  readonly text: string;
  readonly links: ReadonlyArray<string>;
}) {
  const known = links.filter((link) => link.length > 0 && text.includes(link));
  if (known.length === 0) return text;
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
        className="underline underline-offset-2"
        href={part}
        target="_blank"
        rel="noreferrer noopener"
      >
        {part}
      </a>
    ) : (
      part
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
