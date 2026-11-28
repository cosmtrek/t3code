import { useAtomValue } from "@effect/atom-react";
import {
  ThreadId,
  type EnvironmentId,
  type ModelSelection,
  type RuntimeMode,
} from "@t3tools/contracts";
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { useNavigate, useSearch } from "@tanstack/react-router";
import {
  BotMessageSquareIcon,
  ArrowUpToLineIcon,
  CheckIcon,
  CopyIcon,
  EllipsisIcon,
  ExternalLinkIcon,
  FileTextIcon,
  IdCardIcon,
  PauseIcon,
  PencilIcon,
  PlayIcon,
  SettingsIcon,
  Trash2Icon,
} from "lucide-react";
import {
  Fragment,
  useEffect,
  useEffectEvent,
  useId,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
} from "react";

import {
  resolveRuntimeModeOption,
  runtimeModeOptions,
} from "../../components/chat/runtimeModeConfig";
import { AssistantSelectionToolbar } from "../../components/chat/AssistantSelectionToolbar";
import ChatMarkdown from "../../components/ChatMarkdown";
import { MessageCopyButton } from "../../components/chat/MessageCopyButton";
import { MESSAGE_HEADING_LEVEL } from "../../components/chat/TimelineRowParts";
import { HtmlRenderFrame } from "../../components/chat/HtmlRenderFrame";
import { BotFilePanel, useBotFiles } from "./BotFilePanel";
import { Alert, AlertAction, AlertDescription } from "../../components/ui/alert";
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
import {
  SETTINGS_PICKER_TRIGGER_CLASSNAME,
  SettingResetButton,
  SettingsRow,
} from "../../components/settings/settingsLayout";
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
import { formatWorkingTimerNow } from "../../components/chat/TimelineWorkGroupRows.logic";
import { tickTextContent } from "../../lib/tickTextContent";
import { Switch } from "../../components/ui/switch";
import { Textarea } from "../../components/ui/textarea";
import { WorkEntryIcon } from "../../components/chat/TimelineToolActivityIcon";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../components/ui/tooltip";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { useEnvironmentSettings } from "../../hooks/useSettings";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import { cn } from "../../lib/utils";
import { providerInstanceEntriesFor } from "../../providerInstances";
import { useEnvironments } from "../../state/environments";
import { EMPTY_SERVER_PROVIDERS, serverEnvironment } from "../../state/server";
import { ForkApiError } from "@t3tools/fork-client/http";
import { forkRequest } from "../forkApiAccess";
import { DelegateModelPicker } from "../inbox/DelegateDialog";
import { IconAction } from "../inbox/IconAction";
import { requestConfirmDialog } from "../../confirmDialog";
import { PaneHeader } from "../inbox/PaneHeader";
import { formatSince, formatSpan, useFormatTimestamp } from "../presentation";
import type {
  BotActivity,
  BotConnectorInstance,
  BotConnectorSettings,
  BotDetail,
  BotNotebook,
  BotPermission,
  BotQuestion,
  BotSettings,
  BotSummary,
  PendingBotMessage,
  ShownBotMessage,
} from "@t3tools/fork-client/bots";
import {
  pendingBotMessage,
  startsChatBreak,
  withPendingMessages,
} from "@t3tools/fork-client/bots";
import { TimelineSystemDivider } from "../../components/chat/TimelineSystemDivider";
import { useProject, useQuietThreadShell } from "../../state/entities";
import { botStep } from "./botStep";
import { subscribeToForkEvents, useForkResource, type ForkEvent } from "../useForkResource";
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

export interface BotsSearch {
  readonly environmentId?: EnvironmentId;
  readonly botId?: string;
}

/** The sidebar opens a bot by its link; the page reopens the last one opened. */
export function rememberBot(environmentId: string, botId: string) {
  store(ENVIRONMENT_STORAGE_KEY, environmentId);
  store(BOT_STORAGE_KEY, botId);
}

export function BotsPage() {
  const search = useSearch({ from: "/_chat/bots" });
  const { environments } = useEnvironments();
  const chosen = search.environmentId ?? readStored(ENVIRONMENT_STORAGE_KEY);
  // Every known environment, so a reconnect does not unmount the page and its open dialog.
  const environment =
    environments.find((candidate) => candidate.environmentId === chosen) ?? environments[0] ?? null;

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none">
      <div className="flex min-h-0 flex-1 flex-col bg-background">
        {environment ? (
          <EnvironmentBots
            key={environment.environmentId}
            environmentId={environment.environmentId}
            botId={search.botId ?? readStored(BOT_STORAGE_KEY)}
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
        <BotMessageSquareIcon />
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
  botId,
}: {
  readonly environmentId: EnvironmentId;
  readonly botId: string | null;
}) {
  const navigate = useNavigate();
  const listing = useForkResource<{ bots: ReadonlyArray<BotSummary> }>(
    environmentId,
    "/bots",
    isBotEvent,
  );
  const [creating, setCreating] = useState(false);
  const bots = listing.data?.bots ?? [];
  const bot = bots.find((candidate) => candidate.id === botId) ?? bots[0] ?? null;
  const unsupported = listing.error?.status === 404;

  if (bot) {
    return (
      <div className="relative flex min-h-0 flex-1">
        <BotChat key={bot.id} environmentId={environmentId} botId={bot.id} />
      </div>
    );
  }
  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <PaneHeader edge="list">
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
      {creating ? (
        <CreateBotDialog
          environmentId={environmentId}
          onClose={() => setCreating(false)}
          onCreated={(createdId) => {
            setCreating(false);
            rememberBot(environmentId, createdId);
            void navigate({ to: "/bots", search: { environmentId, botId: createdId } });
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

export function CreateBotDialog({
  environmentId,
  onClose,
  onCreated,
}: {
  readonly environmentId: EnvironmentId;
  readonly onClose: () => void;
  readonly onCreated: (botId: string) => void;
}) {
  const briefHintId = useId();
  const [name, setName] = useState("");
  const [brief, setBrief] = useState("");
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
      const trimmedBrief = brief.trim();
      const result = await forkRequest<{ botId: string }>(environmentId, "/bots/create", {
        method: "POST",
        body: {
          name,
          modelSelection: model,
          runtimeMode,
          ...(trimmedBrief === "" ? {} : { brief: trimmedBrief }),
        },
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
            <DialogDescription>Describe its job now or later in the chat.</DialogDescription>
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
              <div>
                <label className="block">
                  <span className="mb-1.5 flex items-baseline justify-between gap-2 text-xs">
                    <span className="font-medium text-foreground">What should it do?</span>
                    <span className="text-muted-foreground" aria-hidden>
                      Optional
                    </span>
                  </span>
                  <Textarea
                    aria-describedby={briefHintId}
                    rows={3}
                    value={brief}
                    placeholder="Watch for new releases, open a thread to run the upgrade checklist, and ask me before merging."
                    onChange={(event) => setBrief(event.target.value)}
                  />
                </label>
                <p id={briefHintId} className="mt-1 text-2xs text-muted-foreground">
                  Sent as the first message. The bot can propose role rules for your approval and
                  save details to memory.
                </p>
              </div>
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
  const formatTimestamp = useFormatTimestamp();
  const detail = useForkResource<BotDetail>(
    environmentId,
    `/bots/bot?botId=${encodeURIComponent(botId)}`,
    (event) => isBotEvent(event) && event.botId === botId,
  );
  const composerRef = useRef<BotComposerHandle>(null);
  const [chatViewport, setChatViewport] = useState<HTMLDivElement | null>(null);
  const [pending, setPending] = useState<ReadonlyArray<PendingBotMessage>>([]);
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
  const cwd = data?.workspacePath;
  const files = useBotFiles(environmentId, botId, workThreadId, cwd);
  const [fileOpenedOverlay, setFileOpenedOverlay] = useState(false);
  const openFileInPanel = (path: string, line?: number) => {
    if (!wide && !notebookOpen) setFileOpenedOverlay(true);
    files.open(path, line);
    setNotebookOpen(true);
  };
  // Pushed between reads; a newer read carries the line too, so it wins.
  const [pushed, setPushed] = useState<{
    readonly read: BotDetail | null;
    readonly activity: BotActivity;
  } | null>(null);
  const onActivity = useEffectEvent((activity: BotActivity) => setPushed({ read: data, activity }));
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- follows the server's live status line for this bot's turn
  useEffect(
    () =>
      subscribeToForkEvents(environmentId, (event) => {
        if (
          event.type === "bot-activity" &&
          event.botId === botId &&
          event.text !== undefined &&
          event.threadId !== undefined
        ) {
          onActivity({
            text: event.text,
            threadId: event.threadId,
            ...(event.step === undefined ? {} : { step: event.step }),
          });
        }
      }),
    [environmentId, botId],
  );
  const activity =
    pushed !== null && pushed.read === data ? pushed.activity : (data?.activity ?? null);

  const chat = withPendingMessages(data?.chat ?? [], pending);
  // The server starts the bot's turn before it answers, so the message shows before that.
  const send = (message: string) => {
    const entry = pendingBotMessage(message, data?.chat ?? []);
    const shown = new Set(chat.map((line) => line.id));
    setPending((current) => [...current.filter((other) => shown.has(other.key)), entry]);
    setError(null);
    forkRequest(environmentId, "/bots/send", {
      method: "POST",
      body: { botId, text: entry.text },
    }).then(
      () => void detail.refresh(),
      (cause: unknown) => {
        setError(errorText(cause));
        setPending((current) =>
          current.map((other) => (other === entry ? { ...other, failed: true } : other)),
        );
      },
    );
  };
  const retry = (entry: PendingBotMessage) => {
    setPending((current) => current.filter((other) => other !== entry));
    send(entry.text);
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

  const openThread = (threadId: string) =>
    void navigate({
      to: "/$environmentId/$threadId",
      params: { environmentId, threadId: ThreadId.make(threadId) },
    });
  const openWorkThread = () => {
    if (workThreadId !== null) openThread(workThreadId);
  };

  return (
    <>
      <section className="flex min-w-72 flex-1 flex-col">
        <PaneHeader edge="list">
          {data ? <BotAvatar name={data.bot.name} /> : null}
          <h2 className="min-w-0 flex-1 truncate px-1 text-sm font-medium">
            {data?.bot.name ?? ""}
          </h2>
          <Menu>
            <MenuTrigger
              render={<Button size="icon-xs" variant="ghost" aria-label="Bot actions" />}
            >
              <EllipsisIcon />
            </MenuTrigger>
            <MenuPopup align="end">
              <MenuItem
                disabled={notebookOpen && files.selected === null}
                onClick={() => {
                  files.showProfile();
                  setFileOpenedOverlay(false);
                  setNotebookOpen(true);
                }}
              >
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
            {chat.map((message, index) => (
              <Fragment key={message.id}>
                {startsChatBreak(chat[index - 1], message) ? (
                  <TimelineSystemDivider label={formatTimestamp(message.createdAt)} />
                ) : null}
                <ChatLine
                  message={message}
                  environmentId={environmentId}
                  botId={botId}
                  workThreadId={workThreadId}
                  cwd={cwd}
                  onOpenFileInPanel={openFileInPanel}
                  onRetry={retry}
                />
              </Fragment>
            ))}
            {data?.questions.map((question) => (
              <QuestionCard
                key={question.id}
                environmentId={environmentId}
                botId={botId}
                question={question}
              />
            ))}
            {data?.workingSince ? (
              <WorkingRow
                environmentId={environmentId}
                since={data.workingSince}
                activity={activity}
                onOpen={activity === null ? null : () => openThread(activity.threadId)}
              />
            ) : null}
          </div>
        </div>
        <div className="mx-auto w-full max-w-3xl px-4 pb-4" onClickCapture={revealOnCitationClick}>
          {data?.bot.paused ? (
            <Alert variant="warning" className="mb-2">
              <PauseIcon />
              <AlertDescription>
                Paused. New messages and routines wait until you resume.
              </AlertDescription>
              <AlertAction>
                <Button size="xs" variant="outline" onClick={() => void setPaused(false)}>
                  Resume
                </Button>
              </AlertAction>
            </Alert>
          ) : null}
          <BotComposer
            ref={composerRef}
            draftKey={`${environmentId}:${botId}`}
            placeholder={data ? `Message ${data.bot.name}` : ""}
            status={error ? <span className="text-destructive-foreground">{error}</span> : null}
            onSend={send}
          />
        </div>
      </section>
      {data && notebookOpen ? (
        <BotFilePanel
          files={files}
          cwd={cwd}
          name={data.bot.name}
          hasThread={workThreadId !== null}
          overlay={!wide}
          onHide={() => {
            setNotebookOpen(false);
            setFileOpenedOverlay(false);
          }}
          onCloseFile={(id) => {
            if (files.close(id) === 0 && !wide && fileOpenedOverlay) {
              setNotebookOpen(false);
              setFileOpenedOverlay(false);
            }
          }}
        >
          <NotebookPanel
            environmentId={environmentId}
            detail={data}
            onOpenSettings={() => setEditingSettings(true)}
          />
        </BotFilePanel>
      ) : null}
      {editingSettings && data ? (
        <SettingsDialog
          key={data.bot.id}
          environmentId={environmentId}
          bot={data.bot}
          connectors={data.connectors}
          onDelete={() => {
            setEditingSettings(false);
            setDeleting(true);
          }}
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

/** The bot at work, as the thread timeline's working row, with its latest step under it. */
function WorkingRow({
  environmentId,
  since,
  activity,
  onOpen,
}: {
  readonly environmentId: EnvironmentId;
  readonly since: string;
  readonly activity: BotActivity | null;
  /** Opens the thread the step comes from. */
  readonly onOpen: (() => void) | null;
}) {
  const thread = useQuietThreadShell(
    activity === null ? null : scopeThreadRef(environmentId, ThreadId.make(activity.threadId)),
  );
  const project = useProject(
    thread === null ? null : scopeProjectRef(environmentId, thread.projectId),
  );
  const root = thread?.worktreePath ?? project?.workspaceRoot ?? undefined;
  const step = activity === null ? null : botStep(activity.step, root);
  return (
    <div className="flex min-w-0 flex-col gap-1 px-1 text-sm text-muted-foreground">
      <span className="tabular-nums">
        Working for{" "}
        <span ref={tickTextContent(() => formatWorkingTimerNow(since, environmentId), true)} />
      </span>
      {activity ? (
        <button
          type="button"
          disabled={onOpen === null}
          onClick={onOpen ?? undefined}
          className="group flex w-fit max-w-full min-w-0 items-center gap-2 text-left text-xs enabled:hover:text-foreground"
        >
          <WorkEntryIcon
            name={step?.icon ?? "message-circle"}
            className="size-3.5 shrink-0 opacity-70"
          />
          <span
            // The full step only when the label is cut off, and only over the text itself.
            onPointerEnter={(event) => {
              const label = event.currentTarget;
              label.title = label.scrollWidth > label.clientWidth ? (label.textContent ?? "") : "";
            }}
            className="min-w-0 truncate text-foreground/75 group-enabled:group-hover:text-foreground"
          >
            {step?.label ?? activity.text}
          </span>
          <span className="hidden shrink-0 text-muted-foreground group-enabled:group-hover:inline">
            Open thread
          </span>
        </button>
      ) : null}
    </div>
  );
}

/** Drawn as a thread's timeline draws its messages, so the two read the same. */
function ChatLine({
  message,
  environmentId,
  botId,
  workThreadId,
  cwd,
  onOpenFileInPanel,
  onRetry,
}: {
  readonly message: ShownBotMessage;
  readonly environmentId: EnvironmentId;
  readonly botId: string;
  /** Where the bot wrote its replies: images and files they name load through it. */
  readonly workThreadId: string | null;
  readonly cwd: string | undefined;
  readonly onOpenFileInPanel: (path: string, line?: number) => void;
  readonly onRetry: (entry: PendingBotMessage) => void;
}) {
  if (message.role === "user") {
    const pending = message.pending;
    const waiting = message.turnRunId === null;
    return (
      <div className="group flex flex-col items-end gap-1">
        <div className="max-w-[80%] min-w-0 rounded-2xl bg-message p-3 text-message-foreground">
          {/* As a thread draws a user message, so citations show as their cards. */}
          <ChatMarkdown
            text={message.text}
            cwd={cwd}
            onOpenFileInPanel={onOpenFileInPanel}
            environmentId={environmentId}
            className="text-message-foreground user-message-markdown"
            lineBreaks
            parseRawHtml={false}
            extensions={USER_MESSAGE_MARKDOWN}
          />
        </div>
        {pending?.failed ? (
          <span className="flex items-center gap-1 pe-1 text-xs text-destructive-foreground">
            Not sent
            <Button size="xs" variant="ghost" onClick={() => onRetry(pending)}>
              Retry
            </Button>
          </span>
        ) : waiting ? (
          <span className="pe-1 text-xs text-muted-foreground">Waiting for the bot</span>
        ) : (
          <MessageMeta text={message.text} createdAt={message.createdAt} />
        )}
      </div>
    );
  }
  if (message.role === "error") {
    return <p className="px-1 text-sm text-destructive-foreground">{message.text}</p>;
  }
  return (
    <div className="group flex min-w-0 flex-col gap-3 px-1">
      {message.renders?.map((render) => (
        <div key={render.attachmentId} className="html-preview-lane min-w-0">
          <HtmlRenderFrame
            environmentId={environmentId}
            htmlRender={render}
            threadRef={undefined}
          />
        </div>
      ))}
      {message.text === "" ? null : (
        <div className="flex flex-col gap-1.5">
          <div
            data-assistant-citation-source={message.id}
            data-assistant-citation-environment={environmentId}
            data-assistant-citation-thread={botId}
          >
            <ChatMarkdown
              text={message.text}
              cwd={cwd}
              onOpenFileInPanel={onOpenFileInPanel}
              environmentId={environmentId}
              threadRef={
                workThreadId === null
                  ? undefined
                  : scopeThreadRef(environmentId, ThreadId.make(workThreadId))
              }
              headingLevelOffset={MESSAGE_HEADING_LEVEL}
            />
          </div>
          <MessageMeta text={message.text} createdAt={message.createdAt} />
        </div>
      )}
    </div>
  );
}

/** Copy and the time, on hover as the timeline shows them; always shown on touch screens. */
function MessageMeta({ text, createdAt }: { readonly text: string; readonly createdAt: string }) {
  const formatTimestamp = useFormatTimestamp();
  return (
    <div className="flex items-center gap-2 pe-1 opacity-0 transition-opacity duration-200 group-hover:opacity-100 focus-within:opacity-100 pointer-coarse:opacity-100">
      <MessageCopyButton text={text} variant="ghost" />
      <span className="text-xs text-muted-foreground tabular-nums">
        {formatTimestamp(createdAt)}
      </span>
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

/** "3h", as the sidebar dates threads. */
const shortSince = (iso: string) => formatSpan(Date.now() - Date.parse(iso));

/** A clickable profile row; the negative margin keeps its text aligned with plain rows. */
const PROFILE_ROW =
  "-mx-1.5 min-w-0 cursor-pointer rounded-md px-1.5 py-1 text-left outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset";

function NotebookSection({
  title,
  count,
  hint,
  action,
  children,
}: {
  readonly title: string;
  readonly count?: number;
  /** Who writes this part, shown beside its title. */
  readonly hint?: string;
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
          {hint ? <span className="font-normal text-muted-foreground">{hint}</span> : null}
        </h3>
        {action}
      </div>
      {children}
    </section>
  );
}

/** A narrow panel: headings stay below the section titles and paragraphs close; `!` beats the unlayered chat-markdown rules. */
const PROFILE_MARKDOWN =
  "text-sm [&_:is(h1,h2,h3,h4,h5,h6)]:mt-3! [&_:is(h1,h2,h3,h4,h5,h6)]:mb-1! [&_:is(h1,h2,h3,h4,h5,h6)]:text-sm! [&_:is(p,ul,ol)]:my-1.5! [&>:first-child]:mt-0!";

/** Long content shows its start under a fade; "Show more" appears only when something is cut. */
function Collapsed({ children }: { readonly children: ReactNode }) {
  const [expanded, setExpanded] = useState(false);
  const [cut, setCut] = useState(false);
  return (
    <div className="flex flex-col items-start gap-1">
      <div
        ref={(node) => {
          if (node && !expanded) setCut(node.scrollHeight > node.clientHeight + 1);
        }}
        className={cn(
          "w-full min-w-0",
          !expanded && "max-h-44 overflow-hidden",
          !expanded && cut && "mask-b-from-50%",
        )}
      >
        {children}
      </div>
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

/** Memory past this many notes waits behind "Show all"; the bot keeps it short by design. */
const MEMORY_SHOWN = 5;

function MemoryList({
  memory,
  busy,
  onForget,
  onMoveToRole,
}: {
  readonly memory: BotNotebook["memory"];
  readonly busy: boolean;
  readonly onForget: (id: number) => void;
  readonly onMoveToRole: (id: number) => void;
}) {
  const [all, setAll] = useState(false);
  const shown = all ? memory : memory.slice(0, MEMORY_SHOWN);
  return (
    <>
      <ul className="-mx-1.5 flex flex-col">
        {shown.map((note) => (
          <MemoryRow
            key={note.id}
            text={note.text}
            busy={busy}
            onForget={() => onForget(note.id)}
            onMoveToRole={() => onMoveToRole(note.id)}
          />
        ))}
      </ul>
      {memory.length > MEMORY_SHOWN ? (
        <button
          type="button"
          onClick={() => setAll(!all)}
          className="self-start text-xs text-muted-foreground hover:text-foreground"
        >
          {all ? "Show fewer" : `Show all ${memory.length}`}
        </button>
      ) : null}
    </>
  );
}

/** Text past two lines opens on a click; nothing changes when it already fits. */
function ClampedLines({ text, className }: { readonly text: string; readonly className?: string }) {
  const [expanded, setExpanded] = useState(false);
  const [cut, setCut] = useState(false);
  return (
    <p
      ref={(node) => {
        if (node && !expanded) setCut(node.scrollHeight > node.clientHeight + 1);
      }}
      onClick={cut || expanded ? () => setExpanded(!expanded) : undefined}
      className={cn(
        "min-w-0 whitespace-pre-wrap wrap-anywhere",
        !expanded && "line-clamp-2",
        (cut || expanded) && "cursor-pointer",
        className,
      )}
    >
      {text}
    </p>
  );
}

/** One remembered fact, with a way to forget it or move a rule filed here into the role. */
function MemoryRow({
  text,
  busy,
  onForget,
  onMoveToRole,
}: {
  readonly text: string;
  readonly busy: boolean;
  readonly onForget: () => void;
  readonly onMoveToRole: () => void;
}) {
  return (
    <li className="group/memory flex min-w-0 items-start gap-1 rounded-md py-1 ps-1.5 pe-0.5 hover:bg-accent">
      <span
        aria-hidden
        className="mt-[calc(0.5lh-2px)] size-1 shrink-0 rounded-full bg-muted-foreground/50"
      />
      <ClampedLines text={text} className="flex-1 ps-1 text-xs leading-relaxed" />
      <span className="-my-0.5 flex opacity-0 group-hover/memory:opacity-100 focus-within:opacity-100 pointer-coarse:opacity-100">
        <IconAction label="Move to role: it is a rule" disabled={busy} onClick={onMoveToRole}>
          <ArrowUpToLineIcon />
        </IconAction>
        <IconAction label="Forget" disabled={busy} onClick={onForget}>
          <Trash2Icon />
        </IconAction>
      </span>
    </li>
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
  onOpenSettings,
}: {
  readonly environmentId: EnvironmentId;
  readonly detail: BotDetail;
  readonly onOpenSettings: () => void;
}) {
  const navigate = useNavigate();
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
  const forget = async (memoryId: number) => {
    const message = "Forget this memory? The bot will no longer know it.";
    const confirmed =
      (await requestConfirmDialog(message, { variant: "destructive" })) ?? window.confirm(message);
    if (confirmed) await post(`memory:${memoryId}`, "/bots/memory/forget", { memoryId });
  };
  const open = notebook.items.filter((item) => item.status !== "done" && !item.setAside);
  const setAside = notebook.items.filter((item) => item.status !== "done" && item.setAside);
  // Threads outside an item never leave the notebook, so a finished one folds away.
  const unlinked = notebook.threads.filter(
    (thread) => thread.itemId === null && (ACTIVE_RUN.has(thread.status) || thread.takenOver),
  );
  const finished = notebook.threads.filter(
    (thread) => thread.itemId === null && !ACTIVE_RUN.has(thread.status) && !thread.takenOver,
  );
  const connectors = detail.connectors.filter(
    (instance) => detail.bot.settings.connectors[instance.id]?.enabled === true,
  );
  const empty = [
    open.length === 0 && unlinked.length === 0 && finished.length === 0 && "No work",
    notebook.routines.length === 0 && "No routines",
    notebook.memory.length === 0 && "No memory",
    detail.notes.length === 0 && "No notes",
    detail.skills.length === 0 && "No skills",
    connectors.length === 0 && "No connectors",
  ].filter((label) => label !== false);

  return (
    <>
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        {error ? <p className="px-3 pt-2 text-xs text-destructive-foreground">{error}</p> : null}
        <RoleEditor key={botId} environmentId={environmentId} botId={botId} role={role} />
        {open.length > 0 || unlinked.length > 0 || finished.length > 0 ? (
          <NotebookSection title="Work" count={open.length + unlinked.length}>
            {open.map((item) => (
              <div key={item.id} className="flex flex-col gap-1 pb-1">
                <div className="flex min-w-0 items-center gap-2 text-sm">
                  <span className="min-w-0 flex-1 truncate">{item.title}</span>
                  {item.status === "waiting" ? (
                    <Badge size="sm" variant="warning">
                      Waiting
                    </Badge>
                  ) : null}
                  <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                    {shortSince(item.updatedAt)}
                  </span>
                </div>
                {item.note ? (
                  <ClampedLines text={item.note} className="text-xs text-muted-foreground" />
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
            {finished.length > 0 ? (
              <FinishedThreads
                threads={finished}
                onOpen={openThread}
                onHandBack={handBack}
                busy={pending !== null}
              />
            ) : null}
          </NotebookSection>
        ) : null}
        {setAside.length > 0 ? (
          <NotebookSection title="Set aside" count={setAside.length}>
            {setAside.map((item) => (
              <div
                key={item.id}

                className="flex min-w-0 items-center gap-1.5 text-sm"
              >
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
                <IconAction
                  label="Run now"
                  disabled={pending !== null}
                  onClick={() => runNow(routine.id)}
                >
                  <PlayIcon />
                </IconAction>
              </div>
            ))}
          </NotebookSection>
        ) : null}
        {notebook.memory.length > 0 ? (
          <NotebookSection title="Memory" count={notebook.memory.length} hint="· facts it found">
            <MemoryList
              memory={notebook.memory}
              busy={pending !== null}
              onForget={forget}
              onMoveToRole={(memoryId) =>
                void post(`memory:${memoryId}`, "/bots/memory/to-role", { memoryId })
              }
            />
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
                className={cn(PROFILE_ROW, "flex items-center gap-1.5 text-sm")}
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
                className={cn(PROFILE_ROW, "flex flex-col")}
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
    </>
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
    <button type="button" onClick={onOpen} className={cn(PROFILE_ROW, "flex flex-col")}>
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
  bot,
  connectors,
  onDelete,
  onClose,
}: {
  readonly environmentId: EnvironmentId;
  readonly bot: BotDetail["bot"];
  readonly connectors: ReadonlyArray<BotConnectorInstance>;
  readonly onDelete: () => void;
  readonly onClose: () => void;
}) {
  const [current, setCurrent] = useState({
    name: bot.name,
    modelSelection: bot.modelSelection,
    settings: bot.settings,
  });
  const modes = useRuntimeModes(environmentId, current.modelSelection.instanceId);
  const [error, setError] = useState<string | null>(null);
  const settings = current.settings;
  const connectorOf = (id: string) => settings.connectors[id] ?? CONNECTOR_OFF;
  /** `connector` names the one instance this change touches; the server keeps the others. */
  const save = async (
    patch: Partial<BotSettings> & { name?: string; modelSelection?: ModelSelection },
    connector?: string,
  ) => {
    const { name, modelSelection, ...settingsPatch } = patch;
    const before = current;
    const next = {
      name: name ?? current.name,
      modelSelection: modelSelection ?? current.modelSelection,
      settings: { ...current.settings, ...settingsPatch },
    };
    setCurrent(next);
    setError(null);
    try {
      await forkRequest(environmentId, "/bots/settings", {
        method: "POST",
        body: {
          botId: bot.id,
          ...(name === undefined ? {} : { name }),
          ...(modelSelection === undefined ? {} : { modelSelection }),
          settings: {
            turnsPerDay: next.settings.turnsPerDay,
            maxThreads: next.settings.maxThreads,
            runtimeMode: next.settings.runtimeMode,
            threadModel: next.settings.threadModel,
            ...(connector === undefined
              ? {}
              : {
                  connectors: { [connector]: next.settings.connectors[connector] ?? CONNECTOR_OFF },
                }),
          },
        },
      });
    } catch (cause) {
      setCurrent(before);
      setError(errorText(cause));
    }
  };
  const saveConnector = (id: string, patch: Partial<BotConnectorSettings>) =>
    save({ connectors: { ...settings.connectors, [id]: { ...connectorOf(id), ...patch } } }, id);
  const rename = (input: HTMLInputElement) => {
    const name = input.value.trim();
    if (name === current.name) return;
    if (name === "") {
      input.value = current.name;
      return;
    }
    void save({ name });
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogPopup className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{current.name} settings</DialogTitle>
          <DialogDescription>Changes apply right away.</DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="flex flex-col gap-4">
            <SettingsHeading title="Bot" />
            <SettingsGroup>
              <SettingsRow
                title="Name"
                control={
                  <Input
                    size="sm"
                    className="w-full sm:w-56"
                    aria-label="Bot name"
                    maxLength={60}
                    defaultValue={current.name}
                    onBlur={(event) => rename(event.currentTarget)}
                    onKeyDown={(event) => {
                      if (event.nativeEvent.isComposing || event.keyCode === 229) return;
                      if (event.key === "Enter") event.currentTarget.blur();
                    }}
                  />
                }
              />
              <SettingsRow
                title="Model"
                description="Its own turns: reading, planning, and replying to you."
                control={
                  <DelegateModelPicker
                    environmentId={environmentId}
                    projectId={null}
                    selection={current.modelSelection}
                    triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
                    onChange={(modelSelection) => void save({ modelSelection })}
                  />
                }
              />
              <SettingsRow
                title="Threads it starts"
                description={
                  settings.threadModel === null
                    ? "Same as its own model. It can still pick another for a thread."
                    : "It can still pick another for a thread."
                }
                resetAction={
                  settings.threadModel !== null ? (
                    <SettingResetButton
                      ariaLabel="Use its own model for threads it starts"
                      onClick={() => void save({ threadModel: null })}
                    />
                  ) : null
                }
                control={
                  <DelegateModelPicker
                    environmentId={environmentId}
                    projectId={null}
                    selection={settings.threadModel ?? current.modelSelection}
                    triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
                    onChange={(threadModel) => void save({ threadModel })}
                  />
                }
              />
            </SettingsGroup>
            <SettingsHeading title="Permissions" />
            <SettingsGroup>
              <SettingsRow
                title="Permission mode"
                description={resolveRuntimeModeOption(settings.runtimeMode).description}
                control={
                  <RuntimeModeSelect
                    modes={modes}
                    value={runtimeModeWithin(settings.runtimeMode, modes)}
                    onChange={(runtimeMode) => void save({ runtimeMode })}
                  />
                }
              />
              <SettingsRow
                title="Turns a day"
                description={`${bot.turnsToday} used today.`}
                control={
                  <CountField
                    label="turns a day"
                    value={settings.turnsPerDay}
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
                    value={settings.maxThreads}
                    min={1}
                    max={50}
                    onCommit={(maxThreads) => void save({ maxThreads })}
                  />
                }
              />
            </SettingsGroup>
            <SettingsHeading
              title="Connectors"
              description={
                connectors.length > 0
                  ? "Outside systems this bot can use, each through t3bot and its name."
                  : "Outside systems this bot can use. None here yet: chat channels you add in Settings appear here."
              }
            />
            {connectors.map((instance) => (
              <ConnectorSection
                key={instance.id}
                botId={bot.id}
                instance={instance}
                value={connectorOf(instance.id)}
                onChange={(patch) => void saveConnector(instance.id, patch)}
              />
            ))}
            <SettingsHeading title="Danger" />
            <SettingsGroup>
              <SettingsRow
                title="Delete bot"
                description="Threads it started stay."
                control={
                  <Button size="sm" variant="destructive-outline" onClick={onDelete}>
                    <Trash2Icon />
                    Delete
                  </Button>
                }
              />
            </SettingsGroup>
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

function SettingsHeading({
  title,
  description,
}: {
  readonly title: string;
  readonly description?: string;
}) {
  return (
    <div className="flex flex-col gap-0.5 px-1 pt-2 first:pt-0">
      <h3 className="text-sm font-medium">{title}</h3>
      {description ? <p className="text-xs text-muted-foreground">{description}</p> : null}
    </div>
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

const ACTIVE_RUN = new Set(["preparing", "queued", "starting", "running", "waiting"]);
const STOPPED_RUN = new Set(["failed", "interrupted", "cancelled"]);

/** Finished threads outside an item, newest first, behind one line until asked for. */
function FinishedThreads({
  threads,
  ...rest
}: {
  readonly threads: BotNotebook["threads"];
  readonly onOpen: (threadId: string) => void;
  readonly onHandBack: (threadId: string) => void;
  readonly busy: boolean;
}) {
  const [shown, setShown] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setShown(!shown)}
        className="self-start text-xs text-muted-foreground hover:text-foreground"
      >
        {shown ? "Hide finished threads" : `${threads.length} finished threads`}
      </button>
      {shown
        ? threads
            .toReversed()
            .map((thread) => <ThreadLink key={thread.threadId} thread={thread} {...rest} />)
        : null}
    </>
  );
}

/** A thread under its item: whether it still runs, and when it started. */
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
  const active = ACTIVE_RUN.has(thread.status);
  const stopped = STOPPED_RUN.has(thread.status);
  return (
    <div className="flex min-w-0 items-center gap-2 text-xs">
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              onClick={() => onOpen(thread.threadId)}
              className={cn(
                "flex min-w-0 flex-1 items-center gap-2 text-left hover:text-foreground",
                active ? "text-foreground" : "text-muted-foreground",
              )}
            />
          }
        >
          <span
            aria-hidden
            className={cn(
              "size-1.5 shrink-0 rounded-full",
              active ? "bg-info" : stopped ? "bg-destructive" : "bg-muted-foreground/40",
            )}
          />
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
      ) : active ? (
        <span className="shrink-0 text-info-foreground">Working</span>
      ) : stopped ? (
        <span className="shrink-0 text-destructive-foreground">Stopped</span>
      ) : (
        <span className="shrink-0 text-muted-foreground tabular-nums">
          {shortSince(thread.createdAt)}
        </span>
      )}
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
        hint="· set by you"
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
          <Collapsed>
            <ChatMarkdown
              text={role}
              cwd={undefined}
              headingLevelOffset={3}
              className={PROFILE_MARKDOWN}
            />
          </Collapsed>
        )}
      </NotebookSection>
    );
  }

  return (
    <NotebookSection title="Role" hint="· set by you">
      <Textarea
        autoFocus
        value={value}
        placeholder="What this bot is responsible for, and its rules. The bot changes it only with your approval."
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") cancel();
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && draft !== role) {
            event.preventDefault();
            void save();
          }
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
            Its chat, notebook, and role are deleted. Threads it started stay as ordinary threads.
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
