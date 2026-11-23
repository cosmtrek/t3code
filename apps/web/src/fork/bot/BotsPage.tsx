import { ThreadId, type EnvironmentId, type ModelSelection } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import {
  BotIcon,
  EllipsisIcon,
  MessageSquareIcon,
  PlusIcon,
  SquareArrowOutUpRightIcon,
} from "lucide-react";
import { useState, type ReactNode } from "react";

import ChatMarkdown from "../../components/ChatMarkdown";
import { Button } from "../../components/ui/button";
import {
  Dialog,
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
import { Input } from "../../components/ui/input";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../../components/ui/menu";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../../components/ui/select";
import { SidebarInset } from "../../components/ui/sidebar";
import { Spinner } from "../../components/ui/spinner";
import { Textarea } from "../../components/ui/textarea";
import { cn } from "../../lib/utils";
import { useEnvironments } from "../../state/environments";
import { ForkApiError, forkRequest } from "../forkApiAccess";
import { DelegateModelPicker } from "../inbox/DelegateDialog";
import { PaneHeader } from "../inbox/PaneHeader";
import { ReplyBox, useSendKey } from "../inbox/ReplyBox";
import { formatSince } from "../presentation";
import type { BotChatMessage, BotDetail, BotNotebook, BotSummary } from "../types";
import { useForkResource, type ForkEvent } from "../useForkResource";

const ENVIRONMENT_STORAGE_KEY = "t3code:bots-environment";
const BOT_STORAGE_KEY = "t3code:bots-selected";

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
                  <SelectTrigger aria-label="Environment" size="xs" className="w-auto min-w-0">
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

  return (
    <div className="flex min-h-0 flex-1">
      <aside className="flex w-60 shrink-0 flex-col border-r max-md:hidden">
        <PaneHeader edge="list">
          <h1 className="min-w-0 flex-1 truncate px-1 text-sm font-medium">Bots</h1>
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
                  {candidate.working
                    ? "Working…"
                    : candidate.lastMessage
                      ? candidate.lastMessage.text.replace(/[`*_#>]/g, "")
                      : "New"}
                </span>
              </span>
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
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canCreate = name.trim() !== "" && !submitting;

  const submit = async () => {
    setSubmitting(true);
    setError(null);
    try {
      const result = await forkRequest<{ botId: string }>(environmentId, "/bots/create", {
        method: "POST",
        body: { name, modelSelection: model },
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
          </DialogHeader>
          <DialogPanel>
            <div className="flex flex-col gap-3">
              <label className="flex flex-col gap-1.5 text-sm">
                Name
                <Input
                  autoFocus
                  value={name}
                  maxLength={60}
                  placeholder="Release Watcher"
                  onChange={(event) => setName(event.target.value)}
                />
              </label>
              <div className="flex flex-col gap-1.5 text-sm">
                Model
                <div className="flex">
                  <DelegateModelPicker
                    environmentId={environmentId}
                    projectId={null}
                    selection={model}
                    onChange={setModel}
                  />
                </div>
              </div>
              <p className="text-xs text-muted-foreground">
                Tell it its job in the chat once it is created.
              </p>
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
  const sendKey = useSendKey();
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const data = detail.data;
  const workThreadId = data?.bot.workThreadId ?? null;

  const send = async () => {
    const message = text.trim();
    if (message === "" || sending) return;
    setSending(true);
    setError(null);
    try {
      await forkRequest(environmentId, "/bots/send", {
        method: "POST",
        body: { botId, text: message },
      });
      setText("");
      await detail.refresh();
    } catch (cause) {
      setError(errorText(cause));
    }
    setSending(false);
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
      <section className="flex min-w-0 flex-1 flex-col">
        <PaneHeader edge="detail">
          {data ? <BotAvatar name={data.bot.name} /> : null}
          <h2 className="min-w-0 flex-1 truncate px-1 text-sm font-medium">
            {data?.bot.name ?? ""}
          </h2>
          {data?.working ? (
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
              <MenuItem disabled={workThreadId === null} onClick={openWorkThread}>
                <SquareArrowOutUpRightIcon />
                Open work thread
              </MenuItem>
              <MenuItem variant="destructive" onClick={() => setDeleting(true)}>
                Delete bot
              </MenuItem>
            </MenuPopup>
          </Menu>
        </PaneHeader>
        {/* Reversed, so the newest message stays in view as messages arrive. */}
        <div className="flex min-h-0 flex-1 scrollbar-gutter-both flex-col-reverse overflow-y-auto">
          <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-4 py-6">
            {data?.chat.length === 0 ? (
              <p className="py-10 text-center text-sm text-muted-foreground">
                Tell {data.bot.name} what it is responsible for.
              </p>
            ) : null}
            {data?.chat.map((message) => (
              <ChatLine key={message.id} message={message} />
            ))}
          </div>
        </div>
        <form
          className="mx-auto w-full max-w-3xl px-4 pb-4"
          onSubmit={(event) => {
            event.preventDefault();
            void send();
          }}
        >
          <ReplyBox
            value={text}
            placeholder={data ? `Message ${data.bot.name}` : ""}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (sendKey.isSend(event)) {
                event.preventDefault();
                void send();
              }
            }}
            status={error ? <span className="text-destructive-foreground">{error}</span> : null}
            sending={sending}
            canSend={text.trim() !== ""}
          />
        </form>
      </section>
      {data ? (
        <NotebookPanel
          environmentId={environmentId}
          botId={data.bot.id}
          role={data.role}
          notebook={data.notebook}
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

function ChatLine({ message }: { readonly message: BotChatMessage }) {
  if (message.role === "user") {
    return (
      <div className="flex flex-col items-end gap-1">
        <div className="max-w-[85%] rounded-2xl bg-secondary px-3.5 py-2 text-sm whitespace-pre-wrap wrap-anywhere">
          {message.text}
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
  return <ChatMarkdown text={message.text} cwd={undefined} className="text-sm" />;
}

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
  children,
}: {
  readonly title: string;
  readonly children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-1.5 border-b px-3 py-3 last:border-b-0">
      <h3 className="text-xs font-medium text-muted-foreground">{title}</h3>
      {children}
    </section>
  );
}

function NotebookPanel({
  environmentId,
  botId,
  role,
  notebook,
}: {
  readonly environmentId: EnvironmentId;
  readonly botId: string;
  readonly role: string;
  readonly notebook: BotNotebook;
}) {
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const openThread = (threadId: string) =>
    void navigate({
      to: "/$environmentId/$threadId",
      params: { environmentId, threadId: ThreadId.make(threadId) },
    });
  const runNow = async (routineId: number) => {
    setError(null);
    try {
      await forkRequest(environmentId, "/bots/routine/run", {
        method: "POST",
        body: { botId, routineId },
      });
    } catch (cause) {
      setError(errorText(cause));
    }
  };
  const open = notebook.items.filter((item) => item.status !== "done" && !item.setAside);
  const goals = notebook.goals.filter((goal) => !goal.done);
  const itemRows = (goalId: number | null) =>
    open
      .filter((item) => item.goalId === goalId)
      .map((item) => (
        <div key={item.id} className="flex flex-col gap-0.5">
          <div className="flex min-w-0 items-baseline gap-1.5 text-sm">
            <span className="shrink-0 text-xs text-muted-foreground tabular-nums">#{item.id}</span>
            <span className="min-w-0 flex-1 truncate">{item.title}</span>
            {item.status === "waiting" ? (
              <span className="shrink-0 text-xs text-muted-foreground">waiting</span>
            ) : null}
          </div>
          {item.note ? (
            <p className="ps-6 text-xs text-muted-foreground wrap-anywhere">{item.note}</p>
          ) : null}
          {notebook.threads
            .filter((thread) => thread.itemId === item.id)
            .map((thread) => (
              <ThreadLink key={thread.threadId} thread={thread} onOpen={openThread} />
            ))}
        </div>
      ));
  const loose = itemRows(null);
  const unlinked = notebook.threads.filter((thread) => thread.itemId === null);

  return (
    <aside className="flex w-80 shrink-0 flex-col border-l max-xl:hidden">
      <PaneHeader edge="detail">
        <h2 className="truncate px-1 text-sm font-medium">Notebook</h2>
      </PaneHeader>
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        {error ? <p className="px-3 pt-2 text-xs text-destructive-foreground">{error}</p> : null}
        <NotebookSection title="Goals and items">
          {goals.length === 0 && loose.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              None yet. Tell the bot what to take care of.
            </p>
          ) : null}
          {goals.map((goal) => (
            <div key={goal.id} className="flex flex-col gap-1.5 rounded-md border p-2">
              <span className="text-sm font-medium">{goal.title}</span>
              {itemRows(goal.id)}
            </div>
          ))}
          {loose}
          {unlinked.map((thread) => (
            <ThreadLink key={thread.threadId} thread={thread} onOpen={openThread} />
          ))}
        </NotebookSection>
        <NotebookSection title="Routines">
          {notebook.routines.length === 0 ? (
            <p className="text-xs text-muted-foreground">None.</p>
          ) : (
            notebook.routines.map((routine) => (
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
                <Button size="xs" variant="outline" onClick={() => void runNow(routine.id)}>
                  Run now
                </Button>
              </div>
            ))
          )}
        </NotebookSection>
        <NotebookSection title="Memory">
          {notebook.memory.length === 0 ? (
            <p className="text-xs text-muted-foreground">None.</p>
          ) : (
            <ul className="flex flex-col gap-1 text-sm">
              {notebook.memory.map((note) => (
                <li key={note.id} className="wrap-anywhere">
                  {note.text}
                </li>
              ))}
            </ul>
          )}
        </NotebookSection>
        <RoleEditor key={botId} environmentId={environmentId} botId={botId} role={role} />
      </div>
    </aside>
  );
}

function ThreadLink({
  thread,
  onOpen,
}: {
  readonly thread: BotNotebook["threads"][number];
  readonly onOpen: (threadId: string) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onOpen(thread.threadId)}
      className="flex min-w-0 items-center gap-1.5 ps-6 text-left text-xs text-muted-foreground hover:text-foreground"
    >
      <MessageSquareIcon className="size-3 shrink-0" />
      <span className="min-w-0 flex-1 truncate">{thread.title ?? "Untitled thread"}</span>
      <span className="shrink-0">{thread.follow}</span>
    </button>
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

  return (
    <NotebookSection title="Role">
      <Textarea
        value={value}
        placeholder="What this bot is responsible for, and its rules. Only you edit it."
        onChange={(event) => setDraft(event.target.value)}
        className="min-h-32"
      />
      {error ? <p className="text-xs text-destructive-foreground">{error}</p> : null}
      {draft !== null && draft !== role ? (
        <div className="flex justify-end gap-1.5">
          <Button size="xs" variant="ghost" onClick={() => setDraft(null)}>
            Discard
          </Button>
          <Button size="xs" disabled={saving} onClick={() => void save()}>
            Save
          </Button>
        </div>
      ) : null}
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
  const remove = async () => {
    try {
      await forkRequest(environmentId, "/bots/delete", { method: "POST", body: { botId } });
      onClose();
    } catch (cause) {
      setError(cause instanceof ForkApiError ? cause.message : errorText(cause));
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
          <Button variant="destructive" onClick={() => void remove()}>
            Delete
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
