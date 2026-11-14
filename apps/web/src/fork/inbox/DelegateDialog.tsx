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
import { Textarea } from "../../components/ui/textarea";
import { ForkApiError, forkRequest } from "../forkApiAccess";
import type { DelegateOptions, InboxItem, ModelChoice } from "../types";
import { useForkResource } from "../useForkResource";

const modelKey = (choice: ModelChoice | null) =>
  choice === null ? "" : `${choice.instanceId}\u0000${choice.model}`;

function parseModelKey(key: string): ModelChoice | null {
  const [instanceId, model] = key.split("\u0000");
  return instanceId && model ? { instanceId, model } : null;
}

export function DelegateDialog({
  environmentId,
  item,
  onClose,
}: {
  readonly environmentId: EnvironmentId;
  readonly item: InboxItem;
  readonly onClose: () => void;
}) {
  const navigate = useNavigate();
  const query = new URLSearchParams({
    channelId: item.channelId,
    conversationId: item.conversationId,
    topicId: item.topicId,
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
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const data = options.data;
  const chosenProject = projectId ?? data?.defaultProjectId ?? data?.projects[0]?.id ?? null;
  const project = data?.projects.find((candidate) => candidate.id === chosenProject) ?? null;
  const chosenTemplate = templateId ?? data?.templates[0]?.id ?? null;
  const defaultModel = modelKey(project?.defaultModel ?? null);
  const chosenModel = model ?? defaultModel;

  const openThread = (threadId: string) => {
    onClose();
    void navigate({
      to: "/$environmentId/$threadId",
      params: { environmentId, threadId: ThreadId.make(threadId) },
    });
  };

  const submit = async () => {
    if (chosenProject === null || chosenTemplate === null) return;
    setSubmitting(true);
    setError(null);
    try {
      const result = await forkRequest<{ threadId: string; existing: boolean }>(
        environmentId,
        "/inbox/delegate",
        {
          method: "POST",
          body: {
            channelId: item.channelId,
            conversationId: item.conversationId,
            topicId: item.topicId,
            projectId: chosenProject,
            templateId: chosenTemplate,
            note,
            modelSelection: chosenModel === defaultModel ? null : parseModelKey(chosenModel),
            forceNew,
          },
        },
      );
      if (result.existing) openThread(result.threadId);
      else onClose();
    } catch (cause) {
      setError(
        cause instanceof ForkApiError || cause instanceof Error ? cause.message : String(cause),
      );
    } finally {
      setSubmitting(false);
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
          ? "This topic's thread is archived. Open it, or start a new one."
          : `This topic already has a thread${existing.title ? `: ${existing.title}` : ""}.`}
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
        <Labeled label="Project">
          <Select
            value={chosenProject ?? ""}
            onValueChange={(value) => value && setProjectId(value)}
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
              </SelectValue>
            </SelectTrigger>
            <SelectPopup>
              {data.providers.flatMap((provider) =>
                provider.models.map((candidate) => {
                  const key = modelKey({ instanceId: provider.instanceId, model: candidate.slug });
                  return (
                    <SelectItem key={key} value={key}>
                      {provider.name} · {candidate.name}
                      {key === defaultModel ? " (project default)" : ""}
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
                {item.conversationName}: {item.preview}
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
                  chosenModel === ""
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

function Labeled({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <label className="flex min-w-0 flex-col gap-1.5">
      <span className="text-xs font-medium">{label}</span>
      {children}
    </label>
  );
}
