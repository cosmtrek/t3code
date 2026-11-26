import { useAtomValue } from "@effect/atom-react";
import {
  ThreadId,
  type EnvironmentId,
  type ModelSelection,
  type RuntimeMode,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import {
  BotIcon,
  CheckIcon,
  CopyIcon,
  EllipsisIcon,
  ExternalLinkIcon,
  FileTextIcon,
  IdCardIcon,
  MessageSquareIcon,
  PauseIcon,
  PencilIcon,
  PlayIcon,
  PlusIcon,
  SettingsIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react";
import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent,
  type ReactNode,
} from "react";

import {
  resolveRuntimeModeOption,
  runtimeModeOptions,
} from "../../components/chat/runtimeModeConfig";
import { AssistantSelectionToolbar } from "../../components/chat/AssistantSelectionToolbar";
import ChatMarkdown from "../../components/ChatMarkdown";
import { RightPanelResizeHandle } from "../../components/preview/RightPanelResizeHandle";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../../components/ui/dialog";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "../../components/ui/empty";
import { SettingsGroup } from "../../components/settings/SettingsGroup";
import { SettingsRow } from "../../components/settings/settingsLayout";
import { Input } from "../../components/ui/input";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../../components/ui/menu";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../../components/ui/select";
import { SidebarInset } from "../../components/ui/sidebar";
import {
  NumberField,
  NumberFieldDecrement,
  NumberFieldGroup,
  NumberFieldIncrement,
  NumberFieldInput,
} from "../../components/ui/number-field";
import { Spinner } from "../../components/ui/spinner";
import { Switch } from "../../components/ui/switch";
import { Textarea } from "../../components/ui/textarea";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../components/ui/tooltip";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { useEnvironmentSettings } from "../../hooks/useSettings";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import { RESIZABLE_WIDTH_PROPERTY, useResizableWidth } from "../../hooks/useResizableWidth";
import { cn } from "../../lib/utils";
import { providerInstanceEntriesFor } from "../../providerInstances";
import { useEnvironments } from "../../state/environments";
import { EMPTY_SERVER_PROVIDERS, serverEnvironment } from "../../state/server";
import { ForkApiError, forkRequest } from "../forkApiAccess";
import { DelegateModelPicker } from "../inbox/DelegateDialog";
import { IconAction } from "../inbox/IconAction";
import { PaneHeader } from "../inbox/PaneHeader";
import { formatSince, UnreadCount } from "../presentation";
import type {
  BotChatMessage,
  BotConnectorInstance,
  BotConnectorSettings,
  BotDetail,
  BotNotebook,
  BotPermission,
  BotQuestion,
  BotSettings,
  BotSummary,
} from "../types";
import { useForkResource, type ForkEvent } from "../useForkResource";
import { BotComposer, type BotComposerHandle } from "./BotComposer";
import { revealCitedText } from "./revealCitedText";

const ENVIRONMENT_STORAGE_KEY = "t3code:bots-environment";
const BOT_STORAGE_KEY = "t3code:bots-selected";
const NOTEBOOK_STORAGE_KEY = "t3code:bots-notebook";

const readStored = (key: string) => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};

const store = (key: string, value: string) => {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Private mode: the choice lasts for this page only.
  }
};

const isBotEvent = (event: ForkEvent) => event.type === "bots";

const errorText = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

export function BotsPage() {
  const { environments } = useEnvironments();
  // Every known environment, so a reconnect does not unmount the page and its open dialog.
  const connected = environments;
  const [chosen, setChosen] = useState<string | null>(() => readStored(ENVIRONMENT_STORAGE_KEY));
  const environment =
    connected.find((candidate) => candidate.environmentId === chosen) ?? connected[0] ?? null;

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none">
      <div className="flex min-h-0 flex-1 flex-col bg-background">
        {environment ? (
          <EnvironmentBots
            key={environment.environmentId}
            environmentId={environment.environmentId}
            environmentPicker={
              connected.length > 1 ? (
                <Select
                  value={environment.environmentId}
                  onValueChange={(value) => {
                    if (!value) return;
                    setChosen(value);
                    store(ENVIRONMENT_STORAGE_KEY, value);
                  }}
                >
                  <SelectTrigger
                    aria-label="Environment"
                    title={environment.label}
                    size="xs"
                    className="w-auto max-w-28 min-w-0"
                  >
                    <SelectValue>{environment.label}</SelectValue>
                  </SelectTrigger>
                  <SelectPopup>
                    {connected.map((candidate) => (
                      <SelectItem key={candidate.environmentId} value={candidate.environmentId}>
                        {candidate.label}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              ) : null
            }
          />
        ) : (
          <>
            <PaneHeader edge="list">
              <h1 className="truncate px-1 text-sm font-medium">Bots</h1>
            </PaneHeader>
            <BotsEmpty title="No environment" description="Connect an environment to use bots." />
          </>
        )}
      </div>
    </SidebarInset>
  );
}

function BotsEmpty({
  title,
  description,
  children,
}: {
  readonly title: string;
  readonly description?: string;
  readonly children?: ReactNode;
}) {
  return (
    <Empty size="compact">
      <EmptyMedia variant="icon">
        <BotIcon />
      </EmptyMedia>
      <EmptyHeader>
        <EmptyTitle>{title}</EmptyTitle>
        {description ? <EmptyDescription>{description}</EmptyDescription> : null}
      </EmptyHeader>
      {children}
    </Empty>
  );
}

function EnvironmentBots({
  environmentId,
  environmentPicker,
}: {
  readonly environmentId: EnvironmentId;
  readonly environmentPicker: ReactNode;
}) {
  const listing = useForkResource<{ bots: ReadonlyArray<BotSummary> }>(
    environmentId,
    "/bots",
    isBotEvent,
  );
  const [selected, setSelected] = useState<string | null>(() => readStored(BOT_STORAGE_KEY));
  const [creating, setCreating] = useState(false);
  const bots = listing.data?.bots ?? [];
  const bot = bots.find((candidate) => candidate.id === selected) ?? bots[0] ?? null;
  const select = (botId: string) => {
    setSelected(botId);
    store(BOT_STORAGE_KEY, botId);
  };
  const unsupported = listing.error?.status === 404;
  const listWidth = useResizableWidth({
    storageKey: "t3code:bots-list-width",
    defaultWidth: 240,
    minWidth: 200,
    maxWidth: 400,
    edge: "right",
  });

  return (
    <div className="relative flex min-h-0 flex-1">
      <aside
        className="relative flex w-(--resizable-width) min-w-50 flex-col border-r max-md:hidden"
        style={{ [RESIZABLE_WIDTH_PROPERTY]: `${listWidth.width}px` } as CSSProperties}
      >
        <RightPanelResizeHandle
          handlers={listWidth.handlers}
          label="Resize the bot list"
          className="-right-1 left-auto any-pointer-coarse:-right-2 any-pointer-coarse:left-auto"
        />
        <PaneHeader edge="list">
          <h1 className="flex-1 shrink-0 px-1 text-sm font-medium">Bots</h1>
          {environmentPicker}
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label="New bot"
            disabled={unsupported}
            onClick={() => setCreating(true)}
          >
            <PlusIcon />
          </Button>
        </PaneHeader>
        <nav className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto p-2">
          {bots.map((candidate) => (
            <button
              key={candidate.id}
              type="button"
              onClick={() => select(candidate.id)}
              className={cn(
                "flex min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-accent",
                candidate.id === bot?.id && "bg-accent",
              )}
            >
              <BotAvatar name={candidate.name} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm">{candidate.name}</span>
                <span className="block truncate text-xs text-muted-foreground">
                  {candidate.paused
                    ? "Paused"
                    : candidate.working
                      ? "Working…"
                      : candidate.lastMessage
                        ? candidate.lastMessage.text.replace(/[`*_#>]/g, "")
                        : "New"}
                </span>
              </span>
              {candidate.unread > 0 ? <UnreadCount count={candidate.unread} /> : null}
            </button>
          ))}
        </nav>
      </aside>
      {bot ? (
        <BotChat key={bot.id} environmentId={environmentId} botId={bot.id} />
      ) : (
        <div className="flex min-w-0 flex-1 flex-col">
          <PaneHeader edge="detail" className="md:hidden">
            <h1 className="truncate px-1 text-sm font-medium">Bots</h1>
          </PaneHeader>
          {listing.data === null && listing.loading ? (
            <div className="flex flex-1 items-center justify-center">
              <Spinner />
            </div>
          ) : unsupported ? (
            <BotsEmpty
              title="No bots here"
              description="This environment runs a T3 Code build without bots."
            />
          ) : listing.error ? (
            <BotsEmpty title="Bots could not load" description={listing.error.message} />
          ) : (
            <BotsEmpty
              title="No bots yet"
              description="A bot is a teammate you tell its job in plain words."
            >
              <Button size="sm" onClick={() => setCreating(true)}>
                New bot
              </Button>
            </BotsEmpty>
          )}
        </div>
      )}
      {creating ? (
        <CreateBotDialog
          environmentId={environmentId}
          onClose={() => setCreating(false)}
          onCreated={(botId) => {
            setCreating(false);
            select(botId);
            void listing.refresh();
          }}
        />
      ) : null}
    </div>
  );
}

function BotAvatar({ name }: { readonly name: string }) {
  return (
    <span
      aria-hidden
      className="flex size-6 shrink-0 items-center justify-center rounded-md bg-primary text-xs font-semibold text-primary-foreground"
    >
      {name.trim().charAt(0).toUpperCase() || "?"}
    </span>
  );
}

function CreateBotDialog({
  environmentId,
  onClose,
  onCreated,
}: {
  readonly environmentId: EnvironmentId;
  readonly onClose: () => void;
  readonly onCreated: (botId: string) => void;
}) {
  const [name, setName] = useState("");
  const [model, setModel] = useState<ModelSelection | null>(null);
  const [pickedMode, setPickedMode] = useState<RuntimeMode | null>(null);
  const modes = useRuntimeModes(environmentId, model?.instanceId ?? null);
  const runtimeMode = runtimeModeWithin(pickedMode ?? "auto", modes);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canCreate = name.trim() !== "" && !submitting;

  const submit = async () => {
    setSubmitting(true);
    setError(null);
    try {
      const result = await forkRequest<{ botId: string }>(environmentId, "/bots/create", {
        method: "POST",
        body: { name, modelSelection: model, runtimeMode },
      });
      onCreated(result.botId);
    } catch (cause) {
      setSubmitting(false);
      setError(errorText(cause));
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogPopup className="sm:max-w-md">
        <form
          className="flex min-h-0 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            if (canCreate) void submit();
          }}
        >
          <DialogHeader>
            <DialogTitle>New bot</DialogTitle>
            <DialogDescription>Tell it its job in the chat once it is created.</DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <div className="space-y-3">
              <label className="block">
                <span className="mb-1.5 block text-xs font-medium text-foreground">Name</span>
                <Input
                  autoFocus
                  value={name}
                  maxLength={60}
                  placeholder="Release Watcher"
                  onChange={(event) => setName(event.target.value)}
                />
              </label>
              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <span className="mb-1.5 block text-xs font-medium text-foreground">Model</span>
                  <DelegateModelPicker
                    environmentId={environmentId}
                    projectId={null}
                    selection={model}
                    onChange={setModel}
                  />
                </div>
                <div>
                  <span className="mb-1.5 block text-xs font-medium text-foreground">
                    Permission mode
                  </span>
                  <RuntimeModeSelect modes={modes} value={runtimeMode} onChange={setPickedMode} />
                </div>
              </div>
              <span className="block text-2xs text-muted-foreground">
                {resolveRuntimeModeOption(runtimeMode).description}
              </span>
              {error ? <p className="text-xs text-destructive-foreground">{error}</p> : null}
            </div>
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={!canCreate}>
              {submitting ? <Spinner size="sm" /> : null}
              Create
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}

function BotChat({
  environmentId,
  botId,
}: {
  readonly environmentId: EnvironmentId;
  readonly botId: string;
}) {
  const navigate = useNavigate();
  const detail = useForkResource<BotDetail>(
    environmentId,
    `/bots/bot?botId=${encodeURIComponent(botId)}`,
    (event) => isBotEvent(event) && event.botId === botId,
  );
  const composerRef = useRef<BotComposerHandle>(null);
  const [chatViewport, setChatViewport] = useState<HTMLDivElement | null>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [editingSettings, setEditingSettings] = useState(false);
  // Wide screens remember the choice; narrow ones float it over the chat, closed until asked.
  const wide = useMediaQuery("xl");
  const [notebookHidden, setNotebookHidden] = useState(
    () => readStored(NOTEBOOK_STORAGE_KEY) === "hidden",
  );
  const [notebookFloating, setNotebookFloating] = useState(false);
  const notebookOpen = wide ? !notebookHidden : notebookFloating;
  const setNotebookOpen = (next: boolean) => {
    if (!wide) return setNotebookFloating(next);
    setNotebookHidden(!next);
    store(NOTEBOOK_STORAGE_KEY, next ? "shown" : "hidden");
  };
  const data = detail.data;
  const lastPostId = data?.chat.findLast((message) => message.role !== "user")?.id ?? null;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- tells the server the user has seen the bot's latest post, here or when the tab comes back
  useEffect(() => {
    if (lastPostId === null) return;
    const markSeen = () => {
      if (document.visibilityState !== "visible") return;
      void forkRequest(environmentId, "/bots/seen", { method: "POST", body: { botId } }).catch(
        () => undefined,
      );
    };
    markSeen();
    document.addEventListener("visibilitychange", markSeen);
    return () => document.removeEventListener("visibilitychange", markSeen);
  }, [environmentId, botId, lastPostId]);
  const workThreadId = data?.bot.workThreadId ?? null;

  const send = async (message: string) => {
    setSending(true);
    setError(null);
    try {
      await forkRequest(environmentId, "/bots/send", {
        method: "POST",
        body: { botId, text: message },
      });
      setSending(false);
      void detail.refresh();
      return true;
    } catch (cause) {
      setError(errorText(cause));
      setSending(false);
      return false;
    }
  };

  const setPaused = async (paused: boolean) => {
    setError(null);
    try {
      await forkRequest(environmentId, "/bots/pause", { method: "POST", body: { botId, paused } });
    } catch (cause) {
      setError(errorText(cause));
    }
  };

  // A citation links to a thread; here its source is a post in this chat.
  const revealOnCitationClick = (event: MouseEvent) => {
    if (!revealCitedText(event.target)) return;
    event.preventDefault();
    event.stopPropagation();
  };

  const openWorkThread = () => {
    if (workThreadId === null) return;
    void navigate({
      to: "/$environmentId/$threadId",
      params: { environmentId, threadId: ThreadId.make(workThreadId) },
    });
  };

  return (
    <>
      <section className="flex min-w-72 flex-1 flex-col">
        <PaneHeader edge="detail">
          {data ? <BotAvatar name={data.bot.name} /> : null}
          <h2 className="min-w-0 flex-1 truncate px-1 text-sm font-medium">
            {data?.bot.name ?? ""}
          </h2>
          {data?.bot.paused ? (
            <Badge variant="warning">Paused</Badge>
          ) : data?.working ? (
            <span className="flex items-center gap-1.5 px-1 text-xs text-muted-foreground">
              <Spinner size="sm" />
              Working
            </span>
          ) : null}
          <Menu>
            <MenuTrigger
              render={<Button size="icon-xs" variant="ghost" aria-label="Bot actions" />}
            >
              <EllipsisIcon />
            </MenuTrigger>
            <MenuPopup align="end">
              <MenuItem disabled={notebookOpen} onClick={() => setNotebookOpen(true)}>
                <IdCardIcon />
                Profile
              </MenuItem>
              <MenuItem disabled={workThreadId === null} onClick={openWorkThread}>
                <ExternalLinkIcon />
                Work thread
              </MenuItem>
              <MenuSeparator />
              <MenuItem disabled={!data} onClick={() => setEditingSettings(true)}>
                <SettingsIcon />
                Settings
              </MenuItem>
              <MenuItem disabled={!data} onClick={() => void setPaused(!data?.bot.paused)}>
                {data?.bot.paused ? <PlayIcon /> : <PauseIcon />}
                {data?.bot.paused ? "Resume" : "Pause"}
              </MenuItem>
              <MenuSeparator />
              <MenuItem variant="destructive" onClick={() => setDeleting(true)}>
                <Trash2Icon />
                Delete bot
              </MenuItem>
            </MenuPopup>
          </Menu>
        </PaneHeader>
        <AssistantSelectionToolbar
          viewport={chatViewport}
          // Citations name a thread; here it stands for the bot's chat, which owns the message ids.
          threadRef={{ environmentId, threadId: ThreadId.make(botId) }}
          onCite={(citation, sourceAnchor) =>
            composerRef.current?.cite(citation, sourceAnchor) ?? false
          }
        />
        {/* Reversed, so the newest message stays in view as messages arrive. */}
        <div
          ref={setChatViewport}
          data-assistant-citation-viewport=""
          className="flex min-h-0 flex-1 scrollbar-gutter-both flex-col-reverse overflow-y-auto"
          onClickCapture={revealOnCitationClick}
        >
          <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-4 py-6">
            {data?.chat.length === 0 ? (
              <p className="py-10 text-center text-sm text-muted-foreground">
                Tell {data.bot.name} what it is responsible for.
              </p>
            ) : null}
            {data?.chat.map((message) => (
              <ChatLine
                key={message.id}
                message={message}
                environmentId={environmentId}
                botId={botId}
              />
            ))}
            {data?.questions.map((question) => (
              <QuestionCard
                key={question.id}
                environmentId={environmentId}
                botId={botId}
                question={question}
              />
            ))}
          </div>
        </div>
        <div className="mx-auto w-full max-w-3xl px-4 pb-4" onClickCapture={revealOnCitationClick}>
          <BotComposer
            ref={composerRef}
            draftKey={`${environmentId}:${botId}`}
            placeholder={data ? `Message ${data.bot.name}` : ""}
            status={error ? <span className="text-destructive-foreground">{error}</span> : null}
            sending={sending}
            onSend={send}
          />
        </div>
      </section>
      {data && notebookOpen ? (
        <NotebookPanel
          environmentId={environmentId}
          detail={data}
          overlay={!wide}
          onHide={() => setNotebookOpen(false)}
          onOpenSettings={() => setEditingSettings(true)}
        />
      ) : null}
      {editingSettings && data ? (
        <SettingsDialog
          key={data.bot.id}
          environmentId={environmentId}
          botId={data.bot.id}
          name={data.bot.name}
          instanceId={data.bot.modelSelection.instanceId}
          settings={data.bot.settings}
          connectors={data.connectors}
          turnsToday={data.bot.turnsToday}
          onClose={() => setEditingSettings(false)}
        />
      ) : null}
      {deleting && data ? (
        <DeleteBotDialog
          environmentId={environmentId}
          botId={data.bot.id}
          name={data.bot.name}
          onClose={() => setDeleting(false)}
        />
      ) : null}
    </>
  );
}

function ChatLine({
  message,
  environmentId,
  botId,
}: {
  readonly message: BotChatMessage;
  readonly environmentId: EnvironmentId;
  readonly botId: string;
}) {
  if (message.role === "user") {
    return (
      <div className="flex flex-col items-end gap-1">
        <div className="max-w-[85%] rounded-2xl bg-secondary px-3.5 py-2">
          {/* As a thread draws a user message, so citations show as their cards. */}
          <ChatMarkdown
            text={message.text}
            cwd={undefined}
            className="text-sm user-message-markdown"
            lineBreaks
            parseRawHtml={false}
            extensions={USER_MESSAGE_MARKDOWN}
          />
        </div>
        <span className="text-xs text-muted-foreground">
          {message.turnRunId === null ? "Waiting for the bot" : formatSince(message.createdAt)}
        </span>
      </div>
    );
  }
  if (message.role === "error") {
    return <p className="text-sm text-destructive-foreground">{message.text}</p>;
  }
  return (
    <div
      data-assistant-citation-source={message.id}
      data-assistant-citation-environment={environmentId}
      data-assistant-citation-thread={botId}
    >
      <ChatMarkdown text={message.text} cwd={undefined} className="text-sm" />
    </div>
  );
}

const USER_MESSAGE_MARKDOWN = { userMessage: true, leadingWhitespace: true } as const;

const DAY_NAMES = ["", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function scheduleLabel(schedule: BotNotebook["routines"][number]["schedule"]) {
  if (schedule.type === "every") return `Every ${schedule.minutes} min`;
  const days = schedule.weekdays;
  return !days || days.length === 0 || days.length === 7
    ? `Daily ${schedule.time}`
    : `${days.map((day) => DAY_NAMES[day]).join(", ")} ${schedule.time}`;
}

function NotebookSection({
  title,
  count,
  action,
  children,
}: {
  readonly title: string;
  readonly count?: number;
  readonly action?: ReactNode;
  readonly children?: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-2 border-b px-3 py-3">
      <div className="flex h-6 items-center gap-2">
        <h3 className="flex flex-1 items-baseline gap-1.5 text-xs font-semibold">
          {title}
          {count !== undefined ? (
            <span className="font-normal text-muted-foreground tabular-nums">{count}</span>
          ) : null}
        </h3>
        {action}
      </div>
      {children}
    </section>
  );
}

const CLAMP = { 3: "line-clamp-3", 4: "line-clamp-4" } as const;

/** Long text shows its first lines; "more" appears only when something is cut. */
function ClampedText({
  text,
  lines,
  className,
}: {
  readonly text: string;
  readonly lines: keyof typeof CLAMP;
  readonly className?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const [cut, setCut] = useState(false);
  return (
    <div className="flex flex-col items-start gap-0.5">
      <p
        ref={(node) => {
          if (node && !expanded) setCut(node.scrollHeight > node.clientHeight + 1);
        }}
        className={cn("whitespace-pre-wrap wrap-anywhere", !expanded && CLAMP[lines], className)}
      >
        {text}
      </p>
      {cut || expanded ? (
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          className="text-xs text-muted-foreground hover:text-foreground"
        >
          {expanded ? "Show less" : "Show more"}
        </button>
      ) : null}
    </div>
  );
}

function CopyPathButton({ path }: { readonly path: string }) {
  const { copyToClipboard, isCopied } = useCopyToClipboard<null>();
  return (
    <IconAction
      label={isCopied ? "Copied" : `Copy notes folder: ${path}`}
      onClick={() => copyToClipboard(path, null)}
    >
      {isCopied ? <CheckIcon /> : <CopyIcon />}
    </IconAction>
  );
}

function NotebookPanel({
  environmentId,
  detail,
  overlay,
  onHide,
  onOpenSettings,
}: {
  readonly environmentId: EnvironmentId;
  readonly detail: BotDetail;
  /** Narrow screens: float over the chat instead of taking a column. */
  readonly overlay: boolean;
  readonly onHide: () => void;
  readonly onOpenSettings: () => void;
}) {
  const navigate = useNavigate();
  const width = useResizableWidth({
    storageKey: "t3code:bots-profile-width",
    defaultWidth: 320,
    minWidth: 280,
    maxWidth: 560,
    edge: "left",
  });
  const { notebook, role } = detail;
  const botId = detail.bot.id;
  const [error, setError] = useState<string | null>(null);
  const [openFile, setOpenFile] = useState<OpenFile | null>(null);
  // One action at a time: a second click while one runs would fire it twice.
  const [pending, setPending] = useState<string | null>(null);
  const post = async (key: string, path: string, body: Record<string, unknown>) => {
    if (pending !== null) return;
    setPending(key);
    setError(null);
    try {
      await forkRequest(environmentId, path, { method: "POST", body: { botId, ...body } });
    } catch (cause) {
      setError(errorText(cause));
    }
    setPending(null);
  };
  const handBack = (threadId: string) =>
    void post(`thread:${threadId}`, "/bots/thread/handback", { threadId });
  const openThread = (threadId: string) =>
    void navigate({
      to: "/$environmentId/$threadId",
      params: { environmentId, threadId: ThreadId.make(threadId) },
    });
  const runNow = (routineId: number) =>
    void post(`routine:${routineId}`, "/bots/routine/run", { routineId });
  const open = notebook.items.filter((item) => item.status !== "done" && !item.setAside);
  const setAside = notebook.items.filter((item) => item.status !== "done" && item.setAside);
  const unlinked = notebook.threads.filter((thread) => thread.itemId === null);
  const connectors = detail.connectors.filter(
    (instance) => detail.bot.settings.connectors[instance.id]?.enabled === true,
  );
  const empty = [
    open.length === 0 && unlinked.length === 0 && "No work",
    notebook.routines.length === 0 && "No routines",
    notebook.memory.length === 0 && "No memory",
    detail.notes.length === 0 && "No notes",
    detail.skills.length === 0 && "No skills",
    connectors.length === 0 && "No connectors",
  ].filter((label) => label !== false);

  return (
    <aside
      className={cn(
        "relative flex w-(--resizable-width) max-w-full min-w-70 flex-col border-l bg-background",
        overlay && "absolute inset-y-0 right-0 z-20 shadow-lg",
      )}
      style={{ [RESIZABLE_WIDTH_PROPERTY]: `${width.width}px` } as CSSProperties}
    >
      <RightPanelResizeHandle handlers={width.handlers} label="Resize the profile" />
      <PaneHeader edge="detail">
        <h2 className="min-w-0 flex-1 truncate px-1 text-sm font-medium">Profile</h2>
        <IconAction label="Close profile" onClick={onHide}>
          <XIcon />
        </IconAction>
      </PaneHeader>
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        {error ? <p className="px-3 pt-2 text-xs text-destructive-foreground">{error}</p> : null}
        <RoleEditor key={botId} environmentId={environmentId} botId={botId} role={role} />
        {open.length > 0 || unlinked.length > 0 ? (
          <NotebookSection title="Work" count={open.length}>
            {open.map((item) => (
              <div key={item.id} className="flex flex-col gap-0.5">
                <div className="flex min-w-0 items-center gap-1.5 text-sm">
                  <span className="w-4.5 shrink-0 text-xs text-muted-foreground tabular-nums">
                    #{item.id}
                  </span>
                  <span className="min-w-0 flex-1 truncate">{item.title}</span>
                  {item.status === "waiting" ? (
                    <Badge size="sm" variant="warning">
                      Waiting
                    </Badge>
                  ) : null}
                </div>
                {item.note ? (
                  <p className="ps-6 text-xs text-muted-foreground wrap-anywhere">{item.note}</p>
                ) : null}
                {notebook.threads
                  .filter((thread) => thread.itemId === item.id)
                  .map((thread) => (
                    <ThreadLink
                      key={thread.threadId}
                      thread={thread}
                      onOpen={openThread}
                      onHandBack={handBack}
                      busy={pending !== null}
                    />
                  ))}
              </div>
            ))}
            {unlinked.map((thread) => (
              <ThreadLink
                key={thread.threadId}
                thread={thread}
                onOpen={openThread}
                onHandBack={handBack}
                busy={pending !== null}
              />
            ))}
          </NotebookSection>
        ) : null}
        {setAside.length > 0 ? (
          <NotebookSection title="Set aside" count={setAside.length}>
            {setAside.map((item) => (
              <div key={item.id} className="flex min-w-0 items-center gap-1.5 text-sm">
                <span className="w-4.5 shrink-0 text-xs text-muted-foreground tabular-nums">
                  #{item.id}
                </span>
                <span className="min-w-0 flex-1 truncate text-muted-foreground">{item.title}</span>
                <Button
                  size="xs"
                  variant="outline"
                  disabled={pending !== null}
                  onClick={() =>
                    void post(`item:${item.id}`, "/bots/item/reopen", { itemId: item.id })
                  }
                >
                  Reopen
                </Button>
              </div>
            ))}
          </NotebookSection>
        ) : null}
        {notebook.routines.length > 0 ? (
          <NotebookSection title="Routines" count={notebook.routines.length}>
            {notebook.routines.map((routine) => (
              <div key={routine.id} className="flex min-w-0 items-center gap-2">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm">{routine.title}</div>
                  <div className="truncate text-xs text-muted-foreground">
                    {scheduleLabel(routine.schedule)}
                    {routine.nextDueAt
                      ? ` · next ${new Date(routine.nextDueAt).toLocaleString()}`
                      : ""}
                  </div>
                </div>
                <Button
                  size="xs"
                  variant="outline"
                  disabled={pending !== null}
                  onClick={() => runNow(routine.id)}
                >
                  Run now
                </Button>
              </div>
            ))}
          </NotebookSection>
        ) : null}
        {notebook.memory.length > 0 ? (
          <NotebookSection title="Memory" count={notebook.memory.length}>
            <ul className="flex flex-col gap-2">
              {notebook.memory.map((note) => (
                <li key={note.id} className="border-l-2 ps-2">
                  <ClampedText text={note.text} lines={3} className="text-xs leading-relaxed" />
                </li>
              ))}
            </ul>
          </NotebookSection>
        ) : null}
        {detail.notes.length > 0 ? (
          <NotebookSection
            title="Notes"
            count={detail.notes.length}
            action={<CopyPathButton path={detail.notesPath} />}
          >
            {detail.notes.map((note) => (
              <button
                key={note.name}
                type="button"
                onClick={() => setOpenFile({ kind: "note", name: note.name, title: note.name })}
                className="flex min-w-0 items-center gap-1.5 text-left text-sm hover:text-foreground"
              >
                <FileTextIcon className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate">{note.name}</span>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {formatSince(note.updatedAt)}
                </span>
              </button>
            ))}
          </NotebookSection>
        ) : null}
        {detail.skills.length > 0 ? (
          <NotebookSection title="Skills" count={detail.skills.length}>
            {detail.skills.map((skill) => (
              <button
                key={skill.path}
                type="button"
                onClick={() =>
                  setOpenFile({
                    kind: skill.shared ? "shared-skill" : "skill",
                    name: skill.folder,
                    title: skill.name,
                  })
                }
                className="flex min-w-0 flex-col text-left hover:text-foreground"
              >
                <span className="flex min-w-0 items-center gap-1.5 text-sm">
                  <span className="min-w-0 flex-1 truncate">{skill.name}</span>
                  {skill.shared ? (
                    <span className="shrink-0 text-xs text-muted-foreground">shared</span>
                  ) : null}
                </span>
                {skill.description ? (
                  <span className="line-clamp-2 text-xs text-muted-foreground">
                    {skill.description}
                  </span>
                ) : null}
              </button>
            ))}
          </NotebookSection>
        ) : null}
        {connectors.length > 0 ? (
          <NotebookSection
            title="Connectors"
            count={connectors.length}
            action={
              <IconAction label="Connector settings" onClick={onOpenSettings}>
                <SettingsIcon />
              </IconAction>
            }
          >
            {connectors.map((instance) => (
              <ConnectorSummary
                key={instance.id}
                instance={instance}
                value={detail.bot.settings.connectors[instance.id]!}
                onOpen={onOpenSettings}
              />
            ))}
          </NotebookSection>
        ) : null}
        {empty.length > 0 ? (
          <p className="px-3 py-3 text-xs text-muted-foreground">{empty.join(" · ")}</p>
        ) : null}
      </div>
      {openFile !== null ? (
        <NoteDialog
          environmentId={environmentId}
          botId={botId}
          file={openFile}
          onClose={() => setOpenFile(null)}
        />
      ) : null}
    </aside>
  );
}

/** One connector the bot has on: its command, what it may do unasked, and whether it works now. */
function ConnectorSummary({
  instance,
  value,
  onOpen,
}: {
  readonly instance: BotConnectorInstance;
  readonly value: BotConnectorSettings;
  readonly onOpen: () => void;
}) {
  const facts = [
    ...instance.operations.map(
      (operation) =>
        `${operation.label}: ${value.permissions[operation.id] === "allow" ? "allowed" : "asks you"}`,
    ),
    ...(instance.kind === "chat" && value.config.mentions === true ? ["Wakes on @-mentions"] : []),
  ];
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex min-w-0 flex-col text-left hover:text-foreground"
    >
      <span className="flex min-w-0 items-center gap-1.5 text-sm">
        <span className="min-w-0 flex-1 truncate">{instance.name}</span>
        <span className="shrink-0 font-mono text-xs text-muted-foreground">
          t3bot {instance.id}
        </span>
      </span>
      {instance.status !== "ok" && instance.reason !== null ? (
        <span className="line-clamp-2 text-xs text-warning-foreground">{instance.reason}</span>
      ) : null}
      {facts.length > 0 ? (
        <span className="line-clamp-2 text-xs text-muted-foreground">{facts.join(" · ")}</span>
      ) : null}
    </button>
  );
}

interface OpenFile {
  readonly kind: "note" | "skill" | "shared-skill";
  /** The note's file name, or the skill's folder. */
  readonly name: string;
  readonly title: string;
}

function NoteDialog({
  environmentId,
  botId,
  file,
  onClose,
}: {
  readonly environmentId: EnvironmentId;
  readonly botId: string;
  readonly file: OpenFile;
  readonly onClose: () => void;
}) {
  const name = file.kind === "note" ? file.name : "SKILL.md";
  const note = useForkResource<{ name: string; text: string }>(
    environmentId,
    `/bots/note?botId=${encodeURIComponent(botId)}&kind=${file.kind}&name=${encodeURIComponent(file.name)}`,
    (event) => isBotEvent(event) && event.botId === botId,
  );
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogPopup className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{file.title}</DialogTitle>
        </DialogHeader>
        <DialogPanel>
          {note.data ? (
            name.endsWith(".md") ? (
              <ChatMarkdown text={note.data.text} cwd={undefined} className="text-sm" />
            ) : (
              <pre className="text-xs whitespace-pre-wrap wrap-anywhere">{note.data.text}</pre>
            )
          ) : note.error ? (
            <p className="text-sm text-destructive-foreground">{note.error.message}</p>
          ) : (
            <Spinner />
          )}
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}

function QuestionCard({
  environmentId,
  botId,
  question,
}: {
  readonly environmentId: EnvironmentId;
  readonly botId: string;
  readonly question: BotQuestion;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [what, ...rest] = question.text.split("\n\n");
  const details = rest.join("\n\n");
  const answer = async (approve: boolean) => {
    setBusy(true);
    setError(null);
    try {
      await forkRequest(environmentId, "/bots/question/answer", {
        method: "POST",
        body: { botId, questionId: question.id, approve },
      });
    } catch (cause) {
      setError(errorText(cause));
      setBusy(false);
    }
  };
  return (
    <div className="flex flex-col gap-2 rounded-lg border p-3">
      <p className="text-sm">
        Wants to <span className="font-medium">{what}</span>
      </p>
      {details ? (
        <pre className="max-h-48 overflow-y-auto rounded-md bg-muted px-2.5 py-2 text-xs whitespace-pre-wrap wrap-anywhere">
          {details}
        </pre>
      ) : null}
      {error ? <p className="text-xs text-destructive-foreground">{error}</p> : null}
      <div className="flex items-center gap-1.5">
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
          Lapses {new Date(question.expiresAt).toLocaleString()}
        </span>
        <Button size="xs" variant="ghost" disabled={busy} onClick={() => void answer(false)}>
          Decline
        </Button>
        <Button size="xs" disabled={busy} onClick={() => void answer(true)}>
          Approve
        </Button>
      </div>
    </div>
  );
}

/** The modes the bot's provider offers, all when it reports none; `null` is the picker's first. */
function useRuntimeModes(environmentId: EnvironmentId, instanceId: string | null) {
  const settings = useEnvironmentSettings(environmentId);
  const providers =
    useAtomValue(serverEnvironment.providersValueAtom(environmentId)) ?? EMPTY_SERVER_PROVIDERS;
  const resolved =
    instanceId ?? providerInstanceEntriesFor(providers, settings, null)[0]?.instanceId;
  const supported = providers.find(
    (provider) => provider.instanceId === resolved,
  )?.supportedRuntimeModes;
  return supported && supported.length > 0
    ? runtimeModeOptions.filter((mode) => supported.includes(mode))
    : runtimeModeOptions;
}

/** Mirrors the server: a mode the provider lacks runs as the broadest narrower one it has. */
function runtimeModeWithin(wanted: RuntimeMode, modes: ReadonlyArray<RuntimeMode>): RuntimeMode {
  const rank = runtimeModeOptions.indexOf(wanted);
  return modes.findLast((mode) => runtimeModeOptions.indexOf(mode) <= rank) ?? modes[0] ?? wanted;
}

function RuntimeModeSelect({
  modes,
  value,
  onChange,
}: {
  readonly modes: ReadonlyArray<RuntimeMode>;
  readonly value: RuntimeMode;
  readonly onChange: (mode: RuntimeMode) => void;
}) {
  return (
    <Select
      value={value}
      onValueChange={(mode) => {
        if (mode) onChange(mode);
      }}
    >
      <SelectTrigger aria-label="Permission mode" size="sm" className="w-40">
        <SelectValue>{resolveRuntimeModeOption(value).label}</SelectValue>
      </SelectTrigger>
      <SelectPopup>
        {modes.map((mode) => (
          <SelectItem key={mode} value={mode}>
            {resolveRuntimeModeOption(mode).label}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}

const PERMISSION_LABELS: Record<BotPermission, string> = {
  allow: "Allow",
  ask: "Ask me",
};

function PermissionSelect({
  label,
  value,
  onChange,
}: {
  readonly label: string;
  readonly value: BotPermission;
  readonly onChange: (value: BotPermission) => void;
}) {
  return (
    <Select
      value={value}
      onValueChange={(next) => {
        if (next) onChange(next);
      }}
    >
      <SelectTrigger aria-label={label} size="sm">
        <SelectValue>{PERMISSION_LABELS[value]}</SelectValue>
      </SelectTrigger>
      <SelectPopup>
        {(["allow", "ask"] as const).map((permission) => (
          <SelectItem key={permission} value={permission}>
            {PERMISSION_LABELS[permission]}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}

/** A whole number that saves when the field is left or stepped, as T3's own interval fields do. */
function CountField({
  label,
  value,
  min,
  max,
  onCommit,
}: {
  readonly label: string;
  readonly value: number;
  readonly min: number;
  readonly max: number;
  readonly onCommit: (value: number) => void;
}) {
  const [draft, setDraft] = useState<number | null>(value);
  return (
    <NumberField
      value={draft}
      min={min}
      max={max}
      step={1}
      size="sm"
      className="w-32"
      onValueChange={setDraft}
      onValueCommitted={(next) => {
        const whole = next === null ? value : Math.round(next);
        setDraft(whole);
        if (whole !== value) onCommit(whole);
      }}
    >
      <NumberFieldGroup>
        <NumberFieldDecrement aria-label={`Fewer ${label}`} />
        <NumberFieldInput aria-label={label} />
        <NumberFieldIncrement aria-label={`More ${label}`} />
      </NumberFieldGroup>
    </NumberField>
  );
}

const CONNECTOR_OFF: BotConnectorSettings = { enabled: false, permissions: {}, config: {} };

/** Each change saves at once, like T3's own settings dialogs. */
function SettingsDialog({
  environmentId,
  botId,
  name,
  instanceId,
  settings,
  connectors,
  turnsToday,
  onClose,
}: {
  readonly environmentId: EnvironmentId;
  readonly botId: string;
  readonly name: string;
  readonly instanceId: string;
  readonly settings: BotSettings;
  readonly connectors: ReadonlyArray<BotConnectorInstance>;
  readonly turnsToday: number;
  readonly onClose: () => void;
}) {
  const modes = useRuntimeModes(environmentId, instanceId);
  const [current, setCurrent] = useState(settings);
  const [error, setError] = useState<string | null>(null);
  const connectorOf = (id: string) => current.connectors[id] ?? CONNECTOR_OFF;
  /** `connector` names the one instance this change touches; the server keeps the others. */
  const save = async (patch: Partial<BotSettings>, connector?: string) => {
    const before = current;
    const next = { ...current, ...patch };
    setCurrent(next);
    setError(null);
    try {
      await forkRequest(environmentId, "/bots/settings", {
        method: "POST",
        body: {
          botId,
          settings: {
            threads: next.threads,
            turnsPerDay: next.turnsPerDay,
            maxThreads: next.maxThreads,
            runtimeMode: next.runtimeMode,
            ...(connector === undefined
              ? {}
              : { connectors: { [connector]: next.connectors[connector] ?? CONNECTOR_OFF } }),
          },
        },
      });
    } catch (cause) {
      setCurrent(before);
      setError(errorText(cause));
    }
  };
  const saveConnector = (id: string, patch: Partial<BotConnectorSettings>) =>
    save({ connectors: { ...current.connectors, [id]: { ...connectorOf(id), ...patch } } }, id);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogPopup className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{name} settings</DialogTitle>
          <DialogDescription>
            What this bot may do on its own. Changes apply right away.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="flex flex-col gap-4">
            <SettingsGroup>
              <SettingsRow
                title="Permission mode"
                description={resolveRuntimeModeOption(current.runtimeMode).description}
                control={
                  <RuntimeModeSelect
                    modes={modes}
                    value={runtimeModeWithin(current.runtimeMode, modes)}
                    onChange={(runtimeMode) => void save({ runtimeMode })}
                  />
                }
              />
              <SettingsRow
                title="Start and run threads"
                description="Changing its role always asks you."
                control={
                  <PermissionSelect
                    label="Start and run threads"
                    value={current.threads}
                    onChange={(threads) => void save({ threads })}
                  />
                }
              />
              <SettingsRow
                title="Turns a day"
                description={`${turnsToday} used today.`}
                control={
                  <CountField
                    label="turns a day"
                    value={current.turnsPerDay}
                    min={1}
                    max={10_000}
                    onCommit={(turnsPerDay) => void save({ turnsPerDay })}
                  />
                }
              />
              <SettingsRow
                title="Threads at once"
                description="Starting one more asks you."
                control={
                  <CountField
                    label="threads at once"
                    value={current.maxThreads}
                    min={1}
                    max={50}
                    onCommit={(maxThreads) => void save({ maxThreads })}
                  />
                }
              />
            </SettingsGroup>
            <div className="flex flex-col gap-0.5 px-1 pt-2">
              <h3 className="text-sm font-medium">Connectors</h3>
              <p className="text-xs text-muted-foreground">
                {connectors.length > 0
                  ? "Outside systems this bot can use, each through t3bot and its name."
                  : "Outside systems this bot can use. None here yet: chat channels you add in Settings appear here."}
              </p>
            </div>
            {connectors.map((instance) => (
              <ConnectorSection
                key={instance.id}
                botId={botId}
                instance={instance}
                value={connectorOf(instance.id)}
                onChange={(patch) => void saveConnector(instance.id, patch)}
              />
            ))}
            {error ? <p className="text-xs text-destructive-foreground">{error}</p> : null}
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button onClick={onClose}>Done</Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

/** One connector instance: whether the bot uses it, each write's permission, and its kind's own rows. */
function ConnectorSection({
  botId,
  instance,
  value,
  onChange,
}: {
  readonly botId: string;
  readonly instance: BotConnectorInstance;
  readonly value: BotConnectorSettings;
  readonly onChange: (patch: Partial<BotConnectorSettings>) => void;
}) {
  const chat = instance.kind === "chat";
  return (
    <section className="flex flex-col gap-2">
      <h3 className="px-1 text-xs font-medium text-muted-foreground">{instance.name}</h3>
      <SettingsGroup>
        <SettingsRow
          title={`Use ${instance.name}`}
          description={
            instance.status !== "ok" && instance.reason !== null
              ? `Now: ${instance.reason}.`
              : chat
                ? `Read and send as you with t3bot ${instance.id}. Others see only you.`
                : `Its command is t3bot ${instance.id}.`
          }
          control={
            <Switch
              aria-label={`Use ${instance.name}`}
              checked={value.enabled}
              onCheckedChange={(enabled) => onChange({ enabled })}
            />
          }
        />
        {value.enabled
          ? instance.operations.map((operation) => (
              <SettingsRow
                key={operation.id}
                title={operation.label}
                control={
                  <PermissionSelect
                    label={`${operation.label} in ${instance.name}`}
                    value={value.permissions[operation.id] ?? "ask"}
                    onChange={(permission) =>
                      onChange({
                        permissions: { ...value.permissions, [operation.id]: permission },
                      })
                    }
                  />
                }
              />
            ))
          : null}
        {value.enabled && chat ? (
          <ChatRows botId={botId} instance={instance} value={value} onChange={onChange} />
        ) : null}
      </SettingsGroup>
    </section>
  );
}

function ChatRows({
  botId,
  instance,
  value,
  onChange,
}: {
  readonly botId: string;
  readonly instance: BotConnectorInstance;
  readonly value: BotConnectorSettings;
  readonly onChange: (patch: Partial<BotConnectorSettings>) => void;
}) {
  const saved = typeof value.config.signature === "string" ? value.config.signature : "";
  const mentions = value.config.mentions === true;
  const [signature, setSignature] = useState(saved);
  const mentionBot = instance.info.mentionBot as { id: string; name: string } | null | undefined;
  const holder = mentionBot != null && mentionBot.id !== botId ? mentionBot.name : null;
  const setConfig = (patch: Record<string, unknown>) =>
    onChange({ config: { signature: saved, mentions, ...patch } });
  return (
    <>
      <SettingsRow
        title="Signature"
        description="Added on its own line to what it sends; {bot} is its name. Empty sends as written."
        control={
          <Input
            aria-label={`Signature in ${instance.name}`}
            value={signature}
            maxLength={200}
            placeholder="None"
            onChange={(event) => setSignature(event.target.value)}
            onBlur={() => {
              if (signature !== saved) setConfig({ signature });
            }}
            className="w-48"
          />
        }
      />
      <SettingsRow
        title="Wake on my @-mentions"
        description={
          holder !== null && !mentions
            ? `One bot per channel. ${holder} has them now; turning this on moves them here.`
            : "One bot per channel."
        }
        control={
          <Switch
            aria-label={`Wake on my @-mentions in ${instance.name}`}
            checked={mentions}
            onCheckedChange={(next) => setConfig({ mentions: next })}
          />
        }
      />
    </>
  );
}

const FOLLOW_LABELS = {
  now: "when it stops",
  attention: "when it fails or needs someone",
  routine: "only at its routines",
} as const;

function ThreadLink({
  thread,
  onOpen,
  onHandBack,
  busy,
}: {
  readonly thread: BotNotebook["threads"][number];
  readonly onOpen: (threadId: string) => void;
  readonly onHandBack: (threadId: string) => void;
  readonly busy: boolean;
}) {
  return (
    <div className="flex min-w-0 items-center gap-1.5 ps-6 text-xs text-muted-foreground">
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              onClick={() => onOpen(thread.threadId)}
              className="flex min-w-0 flex-1 items-center gap-1.5 text-left hover:text-foreground"
            />
          }
        >
          <MessageSquareIcon className="size-3 shrink-0" />
          <span className="min-w-0 flex-1 truncate">{thread.title ?? "Untitled thread"}</span>
        </TooltipTrigger>
        <TooltipPopup side="top">Wakes the bot {FOLLOW_LABELS[thread.follow]}</TooltipPopup>
      </Tooltip>
      {thread.takenOver ? (
        <Button
          size="xs"
          variant="outline"
          disabled={busy}
          onClick={() => onHandBack(thread.threadId)}
        >
          Hand back
        </Button>
      ) : null}
    </div>
  );
}

function RoleEditor({
  environmentId,
  botId,
  role,
}: {
  readonly environmentId: EnvironmentId;
  readonly botId: string;
  readonly role: string;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const value = draft ?? role;
  const cancel = () => {
    setDraft(null);
    setError(null);
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await forkRequest(environmentId, "/bots/role", {
        method: "POST",
        body: { botId, role: value },
      });
      setDraft(null);
    } catch (cause) {
      setError(errorText(cause));
    }
    setSaving(false);
  };

  if (draft === null) {
    return (
      <NotebookSection
        title="Role"
        action={
          <IconAction label="Edit role" onClick={() => setDraft(role)}>
            <PencilIcon />
          </IconAction>
        }
      >
        {role.trim() === "" ? (
          <p className="text-xs text-muted-foreground">
            Not set. Say what this bot is responsible for and its rules.
          </p>
        ) : (
          <ClampedText text={role} lines={4} className="text-sm" />
        )}
      </NotebookSection>
    );
  }

  return (
    <NotebookSection title="Role">
      <Textarea
        autoFocus
        value={value}
        placeholder="What this bot is responsible for, and its rules. The bot changes it only with your approval."
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") cancel();
        }}
        className="min-h-32"
      />
      {error ? <p className="text-xs text-destructive-foreground">{error}</p> : null}
      <div className="flex justify-end gap-1.5">
        <Button size="xs" variant="ghost" onClick={cancel}>
          Cancel
        </Button>
        <Button size="xs" disabled={saving || draft === role} onClick={() => void save()}>
          Save
        </Button>
      </div>
    </NotebookSection>
  );
}

function DeleteBotDialog({
  environmentId,
  botId,
  name,
  onClose,
}: {
  readonly environmentId: EnvironmentId;
  readonly botId: string;
  readonly name: string;
  readonly onClose: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const remove = async () => {
    setDeleting(true);
    try {
      await forkRequest(environmentId, "/bots/delete", { method: "POST", body: { botId } });
      onClose();
    } catch (cause) {
      setError(cause instanceof ForkApiError ? cause.message : errorText(cause));
      setDeleting(false);
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogPopup className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Delete {name}?</DialogTitle>
        </DialogHeader>
        <DialogPanel>
          <p className="text-sm text-muted-foreground">
            Its chat and role are deleted. Its threads stay as ordinary threads.
          </p>
          {error ? <p className="mt-2 text-xs text-destructive-foreground">{error}</p> : null}
        </DialogPanel>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="destructive" disabled={deleting} onClick={() => void remove()}>
            Delete
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
