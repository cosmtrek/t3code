import { ThreadId, type EnvironmentId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useState, type ReactNode } from "react";

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
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../../components/ui/select";
import { Input } from "../../components/ui/input";
import { Textarea } from "../../components/ui/textarea";
import { WorktreeBaseBranchPicker } from "../../components/WorktreeBaseBranchPicker";
import { useEnvironmentQuery } from "../../state/query";
import { vcsEnvironment } from "../../state/vcs";
import { ForkApiError, forkRequest } from "../forkApiAccess";
import type {
  ConversationKind,
  DelegateOptions,
  DelegationScope,
  InboxMessage,
  ModelChoice,
  WorkspaceStrategy,
} from "../types";
import { useForkResource } from "../useForkResource";
import { anchorOf, defaultScope, nameOrUnknown, quoteOfMessage } from "./inboxView";

const modelKey = (choice: ModelChoice | null) =>
  choice === null ? "" : `${choice.instanceId}\u0000${choice.model}`;

type WorkspaceMode = WorkspaceStrategy["type"];

const WORKSPACE_MODE_LABELS: Readonly<Record<WorkspaceMode, string>> = {
  root: "Project checkout",
  worktree: "New worktree",
  existing_worktree: "Existing worktree",
};

function parseModelKey(key: string): ModelChoice | null {
  const [instanceId, model] = key.split("\u0000");
  return instanceId && model ? { instanceId, model } : null;
}

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
  const [templateId, setTemplateId] = useState<string | null>(null);
  const [model, setModel] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [workspaceMode, setWorkspaceMode] = useState<WorkspaceMode | null>(null);
  const [baseRef, setBaseRef] = useState<string | null>(null);
  const [newBranch, setNewBranch] = useState("");
  const [startFromOrigin, setStartFromOrigin] = useState(false);
  const [worktreePath, setWorktreePath] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const data = options.data;
  const chosenProject = projectId ?? data?.defaultProjectId ?? data?.projects[0]?.id ?? null;
  const project = data?.projects.find((candidate) => candidate.id === chosenProject) ?? null;
  const chosenTemplate = templateId ?? data?.templates[0]?.id ?? null;
  const defaultModel = modelKey(project?.defaultModel ?? null);
  const chosenModel = model ?? defaultModel;
  // The last thread's checkout belongs to its project; another project starts in its own.
  const defaultWorkspace: WorkspaceStrategy =
    data && chosenProject === data.defaultProjectId
      ? data.defaultWorkspaceStrategy
      : { type: "root" };
  const chosenMode = workspaceMode ?? defaultWorkspace.type;
  const refs = useEnvironmentQuery(
    project && chosenMode !== "root"
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
            ...(newBranch.trim() ? { branch: newBranch.trim() } : {}),
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
    if (chosenProject === null || chosenTemplate === null || workspaceStrategy === null) return;
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
          scope,
          ...(scope === "range" && untilMessageId !== LATEST ? { untilMessageId } : {}),
          projectId: chosenProject,
          templateId: chosenTemplate,
          note,
          modelSelection: chosenModel === defaultModel ? null : parseModelKey(chosenModel),
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
  } else if (data.templates.length === 0) {
    body = (
      <p className="text-sm text-muted-foreground">
        The adapter offers no delegate templates. Add one in the adapter's configuration.
      </p>
    );
  } else if (data.projects.length === 0) {
    body = (
      <p className="text-sm text-muted-foreground">Add a project in this environment first.</p>
    );
  } else {
    body = (
      <div className="flex flex-col gap-3">
        <Labeled label="Messages">
          <Select value={scope} onValueChange={(value) => value && setScope(value)}>
            <SelectTrigger aria-label="Messages" size="sm">
              <SelectValue>{SCOPE_LABELS[scope]}</SelectValue>
            </SelectTrigger>
            <SelectPopup>
              {(Object.keys(SCOPE_LABELS) as DelegationScope[]).map((option) => (
                <SelectItem key={option} value={option}>
                  {SCOPE_LABELS[option]}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </Labeled>
        {scope === "range" && target.later.length > 0 ? (
          <Labeled label="Through">
            <Select
              value={untilMessageId}
              onValueChange={(value) => value !== null && setUntilMessageId(value)}
            >
              <SelectTrigger aria-label="Through" size="sm">
                <SelectValue>
                  {untilMessageId === LATEST
                    ? "The latest message"
                    : quoteOfMessage(
                        target.later.find((message) => message.id === untilMessageId) ??
                          target.message,
                      )}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup>
                <SelectItem value={LATEST}>The latest message</SelectItem>
                {[target.message, ...target.later].map((message) => (
                  <SelectItem key={message.id} value={message.id}>
                    {quoteOfMessage(message)}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          </Labeled>
        ) : null}
        <Labeled label="Project">
          <Select
            value={chosenProject ?? ""}
            onValueChange={(value) => {
              if (!value) return;
              setProjectId(value);
              setBaseRef(null);
              setWorktreePath(null);
            }}
          >
            <SelectTrigger aria-label="Project" size="sm">
              <SelectValue>{project?.title}</SelectValue>
            </SelectTrigger>
            <SelectPopup>
              {data.projects.map((candidate) => (
                <SelectItem key={candidate.id} value={candidate.id}>
                  {candidate.title}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </Labeled>
        <Labeled label="Workspace">
          <Select
            value={chosenMode}
            onValueChange={(value) => value && setWorkspaceMode(value as WorkspaceMode)}
          >
            <SelectTrigger aria-label="Workspace" size="sm">
              <SelectValue>{WORKSPACE_MODE_LABELS[chosenMode]}</SelectValue>
            </SelectTrigger>
            <SelectPopup>
              {(Object.keys(WORKSPACE_MODE_LABELS) as WorkspaceMode[]).map((mode) => (
                <SelectItem key={mode} value={mode}>
                  {WORKSPACE_MODE_LABELS[mode]}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </Labeled>
        {chosenMode === "worktree" && project ? (
          <>
            <Labeled label="Base branch" group>
              <WorktreeBaseBranchPicker
                key={project.id}
                environmentId={environmentId}
                cwd={project.workspaceRoot}
                value={chosenBaseRef}
                onValueChange={setBaseRef}
                startFromOrigin={startFromOrigin}
                onStartFromOriginChange={setStartFromOrigin}
              />
            </Labeled>
            <Labeled label="New branch (optional)">
              <Input
                value={newBranch}
                placeholder="A temporary branch when left empty"
                onChange={(event) => setNewBranch(event.target.value)}
              />
            </Labeled>
          </>
        ) : null}
        {chosenMode === "existing_worktree" ? (
          <Labeled label="Worktree">
            {worktrees.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                {refs === undefined ? "Loading…" : "This project has no other worktrees."}
              </p>
            ) : (
              <Select
                value={chosenWorktreePath ?? ""}
                onValueChange={(value) => value && setWorktreePath(value)}
              >
                <SelectTrigger aria-label="Worktree" size="sm">
                  <SelectValue>{chosenWorktreePath}</SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  {worktrees.map((entry) => (
                    <SelectItem key={entry.path} value={entry.path}>
                      {entry.branch ? `${entry.branch} · ` : ""}
                      {entry.path}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            )}
          </Labeled>
        ) : null}
        <Labeled label="How">
          <Select
            value={chosenTemplate ?? ""}
            onValueChange={(value) => value && setTemplateId(value)}
          >
            <SelectTrigger aria-label="Template" size="sm">
              <SelectValue>
                {data.templates.find((template) => template.id === chosenTemplate)?.name}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup>
              {data.templates.map((template) => (
                <SelectItem key={template.id} value={template.id}>
                  {template.name}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </Labeled>
        <Labeled label="Model">
          <Select value={chosenModel} onValueChange={(value) => value !== null && setModel(value)}>
            <SelectTrigger aria-label="Model" size="sm">
              <SelectValue>
                {modelLabel(data, parseModelKey(chosenModel)) ?? "Choose a model"}
                {chosenModel !== "" && chosenModel === defaultModel ? " (default)" : ""}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup>
              {data.providers.flatMap((provider) =>
                provider.models.map((candidate) => {
                  const key = modelKey({ instanceId: provider.instanceId, model: candidate.slug });
                  return (
                    <SelectItem key={key} value={key}>
                      {provider.name} · {candidate.name}
                      {key === defaultModel ? " (default)" : ""}
                    </SelectItem>
                  );
                }),
              )}
            </SelectPopup>
          </Select>
        </Labeled>
        <Labeled label="Note (optional)">
          <Textarea
            value={note}
            rows={3}
            placeholder="Anything the agent should know"
            onChange={(event) => setNote(event.target.value)}
          />
        </Labeled>
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
      <DialogPopup className="sm:max-w-lg">
        <form
          className="flex min-h-0 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <DialogHeader>
            <DialogTitle>Delegate to a thread</DialogTitle>
            <DialogDescription>
              <span className="line-clamp-2">
                {nameOrUnknown(target.conversation.name)}: {quoteOfMessage(target.message)}
              </span>
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            {body}
            {error ? <p className="mt-3 text-sm text-destructive-foreground">{error}</p> : null}
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            {askAboutExisting ? (
              <>
                <Button type="button" variant="outline" onClick={() => setForceNew(true)}>
                  Start a new thread
                </Button>
                <Button type="button" onClick={() => openThread(existing.threadId)}>
                  {existing.status === "archived" ? "Open archived thread" : "Open thread"}
                </Button>
              </>
            ) : (
              <Button
                type="submit"
                disabled={
                  submitting ||
                  data === null ||
                  chosenProject === null ||
                  chosenTemplate === null ||
                  chosenModel === "" ||
                  workspaceStrategy === null
                }
              >
                {submitting ? "Starting…" : "Delegate"}
              </Button>
            )}
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}

function modelLabel(data: DelegateOptions, choice: ModelChoice | null): string | null {
  if (choice === null) return null;
  const provider = data.providers.find((candidate) => candidate.instanceId === choice.instanceId);
  const model = provider?.models.find((candidate) => candidate.slug === choice.model);
  return provider ? `${provider.name} · ${model?.name ?? choice.model}` : choice.model;
}

function Labeled({
  label,
  group = false,
  children,
}: {
  readonly label: string;
  /** Several controls: a label would forward its clicks to the first one. */
  readonly group?: boolean;
  readonly children: ReactNode;
}) {
  const Element = group ? "div" : "label";
  return (
    <Element className="flex min-w-0 flex-col gap-1.5">
      <span className="text-xs font-medium">{label}</span>
      {children}
    </Element>
  );
}
