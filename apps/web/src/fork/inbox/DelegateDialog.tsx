import { useAtomValue } from "@effect/atom-react";
import { ProjectId, ThreadId, type EnvironmentId, type ModelSelection } from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import { useNavigate } from "@tanstack/react-router";
import { ChevronDownIcon, FolderGit2Icon, FolderGitIcon, FolderIcon } from "lucide-react";
import { useState, type ReactNode } from "react";

import { ComposerControl, ComposerSelectControl } from "../../components/chat/ComposerControl";
import {
  ComposerEffortColumn,
  describeComposerEffort,
} from "../../components/chat/ComposerModelEffort";
import { ProviderModelPicker } from "../../components/chat/ProviderModelPicker";
import type { TraitsSelectionInput } from "../../components/chat/TraitsPicker";
import { ComposerContextLabel } from "../../components/ComposerContextLabel";
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
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from "../../components/ui/menu";
import { MiddleTruncate } from "../../components/ui/middle-truncate";
import { Select, SelectItem, SelectPopup } from "../../components/ui/select";
import { WorktreeBaseBranchPicker } from "../../components/WorktreeBaseBranchPicker";
import { useClientSettings, useEnvironmentSettings } from "../../hooks/useSettings";
import { getCustomModelOptionsByInstance } from "../../modelSelection";
import { providerInstanceEntriesFor } from "../../providerInstances";
import { useEnvironmentQuery } from "../../state/query";
import { EMPTY_SERVER_PROVIDERS, serverEnvironment } from "../../state/server";
import { vcsEnvironment } from "../../state/vcs";
import { ForkApiError } from "@t3tools/fork-client/http";
import { forkRequest } from "../forkApiAccess";
import type {
  ConversationKind,
  DelegateOptions,
  DelegationScope,
  InboxMessage,
  WorkspaceStrategy,
} from "../types";
import { useForkResource } from "../useForkResource";
import { anchorOf, defaultScope, gistOf, nameOrUnknown, quoteOfMessage } from "./inboxView";
import { ReplyBox, useSendKey } from "./ReplyBox";

type WorkspaceMode = WorkspaceStrategy["type"];

const WORKSPACE_MODE_LABELS: Readonly<Record<WorkspaceMode, string>> = {
  root: "Project checkout",
  worktree: "New worktree",
  existing_worktree: "Existing worktree",
};

const SCOPE_LABELS: Readonly<Record<DelegationScope, string>> = {
  chain: "This message and its replies",
  range: "From this message on",
};

const LATEST = "";

export interface DelegateTarget {
  readonly channelId: string;
  readonly conversation: {
    readonly id: string;
    readonly name: string;
    readonly kind: ConversationKind;
  };
  readonly message: InboxMessage;
  /** What the chat shows after the message, for where a range ends. */
  readonly later: ReadonlyArray<InboxMessage>;
  /** The scope it was delegated with before. */
  readonly scope?: DelegationScope | null;
}

export function DelegateDialog({
  environmentId,
  target,
  onClose,
  onDelegated,
}: {
  readonly environmentId: EnvironmentId;
  readonly target: DelegateTarget;
  readonly onClose: () => void;
  /** A new thread started; the delegation it belongs to. */
  readonly onDelegated: (delegationId: string) => void;
}) {
  const navigate = useNavigate();
  const [scope, setScope] = useState<DelegationScope>(
    target.scope ?? defaultScope(target.conversation.kind),
  );
  const [untilMessageId, setUntilMessageId] = useState(LATEST);
  const anchorMessageId = anchorOf(target.message, scope);
  const query = new URLSearchParams({
    channelId: target.channelId,
    conversationId: target.conversation.id,
    anchorMessageId,
  });
  const options = useForkResource<DelegateOptions>(
    environmentId,
    `/inbox/delegate-options?${query.toString()}`,
    () => false,
  );
  const [forceNew, setForceNew] = useState(false);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [model, setModel] = useState<ModelSelection | null>(null);
  const [note, setNote] = useState("");
  const [workspaceMode, setWorkspaceMode] = useState<WorkspaceMode | null>(null);
  const [baseRef, setBaseRef] = useState<string | null>(null);
  const [placeOpen, setPlaceOpen] = useState(false);
  const [startFromOrigin, setStartFromOrigin] = useState(false);
  const [worktreePath, setWorktreePath] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const sendKey = useSendKey();
  const data = options.data;
  const untilMessage = target.later.find((message) => message.id === untilMessageId) ?? null;
  const replyCount = target.message.rootId == null ? (target.message.replyCount ?? 0) : 0;
  const scopeLabel =
    scope === "chain"
      ? replyCount > 0
        ? `With ${replyCount} ${replyCount === 1 ? "reply" : "replies"}`
        : "With its replies"
      : target.later.length === 0
        ? "From here on"
        : `${(untilMessage === null ? target.later.length : target.later.indexOf(untilMessage) + 1) + 1} messages from here`;
  const chosenProject = projectId ?? data?.defaultProjectId ?? data?.projects[0]?.id ?? null;
  const project = data?.projects.find((candidate) => candidate.id === chosenProject) ?? null;
  const chosenModel = model ?? project?.defaultModel ?? null;
  // The last thread's checkout belongs to its project; another project starts in its own.
  const defaultWorkspace: WorkspaceStrategy =
    data && chosenProject === data.defaultProjectId
      ? data.defaultWorkspaceStrategy
      : { type: "root" };
  const chosenMode = workspaceMode ?? defaultWorkspace.type;
  const refs = useEnvironmentQuery(
    // Existing worktrees are listed in the workspace menu; read them once it opens.
    project && (chosenMode !== "root" || placeOpen)
      ? vcsEnvironment.listRefs({
          environmentId,
          input: { cwd: project.workspaceRoot, refKind: "local", limit: 200 },
        })
      : null,
  ).data?.refs;
  const worktrees = [
    ...(defaultWorkspace.type === "existing_worktree"
      ? [{ path: defaultWorkspace.worktreePath, branch: null as string | null }]
      : []),
    ...(refs ?? []).flatMap((ref) =>
      ref.worktreePath && ref.worktreePath !== project?.workspaceRoot
        ? [{ path: ref.worktreePath, branch: ref.name }]
        : [],
    ),
  ].filter((entry, index, all) => all.findIndex((other) => other.path === entry.path) === index);
  const chosenWorktreePath =
    worktreePath ??
    (defaultWorkspace.type === "existing_worktree"
      ? defaultWorkspace.worktreePath
      : (worktrees[0]?.path ?? null));
  const chosenBaseRef = baseRef ?? refs?.find((ref) => ref.current)?.name ?? "main";
  const workspaceStrategy: WorkspaceStrategy | null =
    chosenMode === "root"
      ? { type: "root" }
      : chosenMode === "worktree"
        ? {
            type: "worktree",
            baseRef: chosenBaseRef,
            startFromOrigin,
          }
        : chosenWorktreePath === null
          ? null
          : { type: "existing_worktree", worktreePath: chosenWorktreePath };

  const openThread = (threadId: string) => {
    onClose();
    void navigate({
      to: "/$environmentId/$threadId",
      params: { environmentId, threadId: ThreadId.make(threadId) },
    });
  };

  const submit = async () => {
    if (chosenProject === null || workspaceStrategy === null) return;
    setSubmitting(true);
    setError(null);
    try {
      const result = await forkRequest<{
        threadId: string;
        existing: boolean;
        delegationId: string;
      }>(environmentId, "/inbox/delegate", {
        method: "POST",
        body: {
          channelId: target.channelId,
          conversationId: target.conversation.id,
          anchorMessageId,
          pickedMessageId: target.message.id,
          scope,
          ...(scope === "range" && untilMessageId !== LATEST ? { untilMessageId } : {}),
          projectId: chosenProject,
          note,
          modelSelection: model,
          workspaceStrategy,
          replaceThreadId: forceNew ? (data?.existing?.threadId ?? null) : null,
        },
      });
      setSubmitting(false);
      if (result.existing) openThread(result.threadId);
      else onDelegated(result.delegationId);
    } catch (cause) {
      setSubmitting(false);
      setError(
        cause instanceof ForkApiError && cause.code === "scope_too_long"
          ? `${cause.message} Choose fewer messages.`
          : cause instanceof Error
            ? cause.message
            : String(cause),
      );
    }
  };

  const existing = data?.existing ?? null;
  const askAboutExisting = existing !== null && !forceNew;
  const canDelegate =
    !submitting &&
    data !== null &&
    chosenProject !== null &&
    chosenModel !== null &&
    workspaceStrategy !== null;

  const quote = (
    <div className="min-w-0 border-s-2 border-border ps-3 text-sm">
      <p className="truncate">
        <span className="font-medium">{nameOrUnknown(target.message.author.name)}</span>
        {target.conversation.kind === "dm" ? null : (
          <span className="text-muted-foreground">
            {" · "}
            {nameOrUnknown(target.conversation.name)}
          </span>
        )}
      </p>
      <p className="truncate">{gistOf(target.message)}</p>
      {data !== null && !askAboutExisting ? (
        <div className="-ms-1.75 mt-1 flex min-w-0 flex-wrap items-center gap-0.5">
          <Select value={scope} onValueChange={(value) => value && setScope(value)}>
            <ComposerSelectControl size="xs" aria-label="Messages">
              <ComposerContextLabel>{scopeLabel}</ComposerContextLabel>
              <ChevronDownIcon data-composer-control-chevron className="opacity-60" />
            </ComposerSelectControl>
            <SelectPopup align="start">
              {(Object.keys(SCOPE_LABELS) as DelegationScope[]).map((option) => (
                <SelectItem key={option} value={option}>
                  {SCOPE_LABELS[option]}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
          {scope === "range" && target.later.length > 0 ? (
            <Select
              value={untilMessageId}
              onValueChange={(value) => value !== null && setUntilMessageId(value)}
            >
              <ComposerSelectControl size="xs" className="min-w-0 shrink" aria-label="Through">
                <ComposerContextLabel>
                  {untilMessage === null
                    ? "through the latest"
                    : `through ${quoteOfMessage(untilMessage)}`}
                </ComposerContextLabel>
                <ChevronDownIcon data-composer-control-chevron className="opacity-60" />
              </ComposerSelectControl>
              <SelectPopup align="start">
                <SelectItem value={LATEST}>The latest message</SelectItem>
                {[target.message, ...target.later].map((message) => (
                  <SelectItem key={message.id} value={message.id}>
                    {quoteOfMessage(message)}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          ) : null}
        </div>
      ) : null}
    </div>
  );

  let body: ReactNode;
  if (options.error) {
    body = <p className="text-sm text-destructive-foreground">{options.error.message}</p>;
  } else if (data === null) {
    body = <p className="text-sm text-muted-foreground">Loading…</p>;
  } else if (askAboutExisting) {
    body = (
      <p className="text-sm">
        {existing.status === "archived"
          ? "These messages' thread is archived. Open it, or start a new one."
          : `These messages already have a thread${existing.title ? `: ${existing.title}` : ""}.`}
      </p>
    );
  } else if (data.projects.length === 0) {
    body = (
      <p className="text-sm text-muted-foreground">Add a project in this environment first.</p>
    );
  } else {
    const place = (
      <Menu open={placeOpen} onOpenChange={setPlaceOpen}>
        <MenuTrigger
          render={<ComposerControl size="xs" className="min-w-0 shrink" />}
          aria-label="Project and workspace"
        >
          {chosenMode === "root" ? (
            <FolderIcon className="size-3" />
          ) : (
            <FolderGit2Icon className="size-3" />
          )}
          <ComposerContextLabel>
            {project?.title}
            {chosenMode === "root" ? null : (
              <span className="text-muted-foreground">
                {" · "}
                {chosenMode === "worktree"
                  ? "New worktree"
                  : (worktrees.find((entry) => entry.path === chosenWorktreePath)?.branch ??
                    "Worktree")}
              </span>
            )}
          </ComposerContextLabel>
          <ChevronDownIcon data-composer-control-chevron className="opacity-60" />
        </MenuTrigger>
        <MenuPopup align="start" side="bottom" className="w-[min(21rem,calc(100vw-2rem))]">
          <MenuGroup>
            <MenuGroupLabel>Project</MenuGroupLabel>
            <MenuRadioGroup
              value={chosenProject ?? ""}
              onValueChange={(value) => {
                setProjectId(value as string);
                setWorkspaceMode(null);
                setBaseRef(null);
                setWorktreePath(null);
              }}
            >
              {data.projects.map((candidate) => (
                <MenuRadioItem key={candidate.id} value={candidate.id} closeOnClick>
                  <span className="min-w-0 truncate">{candidate.title}</span>
                </MenuRadioItem>
              ))}
            </MenuRadioGroup>
          </MenuGroup>
          <MenuSeparator />
          <MenuGroup>
            <MenuGroupLabel>Workspace</MenuGroupLabel>
            <MenuRadioGroup
              value={chosenMode === "existing_worktree" ? (chosenWorktreePath ?? "") : chosenMode}
              onValueChange={(value) => {
                if (value === "root" || value === "worktree") {
                  setWorkspaceMode(value);
                  return;
                }
                setWorkspaceMode("existing_worktree");
                setWorktreePath(value as string);
              }}
            >
              <MenuRadioItem value="root" closeOnClick>
                <span className="flex min-w-0 items-center gap-1.5">
                  <FolderIcon className="size-3" />
                  {WORKSPACE_MODE_LABELS.root}
                </span>
              </MenuRadioItem>
              <MenuRadioItem value="worktree" closeOnClick>
                <span className="flex min-w-0 items-center gap-1.5">
                  <FolderGit2Icon className="size-3" />
                  {WORKSPACE_MODE_LABELS.worktree}
                </span>
              </MenuRadioItem>
              {worktrees.map((entry) => (
                <MenuRadioItem key={entry.path} value={entry.path} closeOnClick>
                  <span className="flex min-w-0 items-center gap-1.5">
                    <FolderGitIcon className="size-3" />
                    <MiddleTruncate value={entry.branch ?? entry.path} />
                  </span>
                </MenuRadioItem>
              ))}
            </MenuRadioGroup>
          </MenuGroup>
        </MenuPopup>
      </Menu>
    );
    body = (
      <div className="flex flex-col gap-1.5">
        <ReplyBox
          aria-label="Request"
          value={note}
          autoFocus
          placeholder="What should the agent do? Leave blank to have it read and report back."
          onChange={(event) => setNote(event.target.value)}
          onKeyDown={(event) => {
            if (sendKey.isSend(event)) {
              event.preventDefault();
              event.currentTarget.form?.requestSubmit();
            }
          }}
          status={error ? <span className="text-destructive-foreground">{error}</span> : null}
          actions={
            <DelegateModelPicker
              environmentId={environmentId}
              projectId={chosenProject}
              selection={chosenModel}
              onChange={setModel}
            />
          }
          sending={submitting}
          canSend={canDelegate}
          sendLabel="Delegate"
        />
        <div className="flex min-w-0 items-center gap-0.5 px-1.5">
          {place}
          {chosenMode === "worktree" && project ? (
            <WorktreeBaseBranchPicker
              key={project.id}
              environmentId={environmentId}
              cwd={project.workspaceRoot}
              value={chosenBaseRef}
              onValueChange={setBaseRef}
              startFromOrigin={startFromOrigin}
              onStartFromOriginChange={setStartFromOrigin}
              compact
            />
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogPopup className="sm:max-w-xl">
        <form
          className="flex min-h-0 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            if (canDelegate) void submit();
          }}
        >
          <DialogHeader>
            <DialogTitle>Delegate</DialogTitle>
          </DialogHeader>
          <DialogPanel>
            <div className="flex flex-col gap-3">
              {quote}
              {body}
            </div>
          </DialogPanel>
          {askAboutExisting ? (
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setForceNew(true)}>
                Start a new thread
              </Button>
              <Button type="button" onClick={() => openThread(existing.threadId)}>
                {existing.status === "archived" ? "Open archived thread" : "Open thread"}
              </Button>
            </DialogFooter>
          ) : null}
        </form>
      </DialogPopup>
    </Dialog>
  );
}

/** T3 Code's own model picker, with the model's effort levels docked beside it as in the composer. */
export function DelegateModelPicker({
  environmentId,
  projectId,
  selection,
  triggerClassName,
  onChange,
}: {
  readonly environmentId: EnvironmentId;
  readonly projectId: string | null;
  readonly selection: ModelSelection | null;
  readonly triggerClassName?: string;
  readonly onChange: (selection: ModelSelection) => void;
}) {
  const settings = useEnvironmentSettings(environmentId);
  const effortDisplay = useClientSettings((client) => client.effortDisplay);
  const providers =
    useAtomValue(serverEnvironment.providersValueAtom(environmentId)) ?? EMPTY_SERVER_PROVIDERS;
  const entries = providerInstanceEntriesFor(
    providers,
    settings,
    projectId === null ? null : ProjectId.make(projectId),
  );
  const instanceId = selection?.instanceId ?? entries[0]?.instanceId ?? null;
  if (instanceId === null) {
    return <span className="px-2 text-xs text-muted-foreground">No providers</span>;
  }
  const entry = entries.find((candidate) => candidate.instanceId === instanceId);
  const model = selection?.model ?? "";
  const traits: TraitsSelectionInput | null = entry
    ? {
        provider: entry.driverKind,
        instanceId: entry.instanceId,
        models: entry.models,
        model,
        modelOptions: selection?.options ?? [],
        allowPromptInjectedEffort: false,
        onModelOptionsChange: (options) =>
          onChange(createModelSelection(instanceId, model, options)),
      }
    : null;
  const effort = describeComposerEffort(traits, effortDisplay, "sm");
  return (
    <ProviderModelPicker
      environmentId={environmentId}
      activeInstanceId={instanceId}
      model={model}
      lockedProvider={null}
      instanceEntries={entries}
      modelOptionsByInstance={getCustomModelOptionsByInstance(
        settings,
        providers,
        instanceId,
        model,
      )}
      isComposerOwned={false}
      popupAlign="end"
      {...(triggerClassName === undefined ? {} : { triggerClassName })}
      triggerSuffix={effort.suffix}
      triggerDetail={effort.detail}
      effortColumn={<ComposerEffortColumn traits={traits} />}
      onInstanceModelChange={(nextInstanceId, nextModel) =>
        onChange(createModelSelection(nextInstanceId, nextModel))
      }
    />
  );
}
