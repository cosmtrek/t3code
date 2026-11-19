import type { EnvironmentId } from "@t3tools/contracts";
import { ChevronRightIcon, EllipsisIcon, MessagesSquareIcon, PlusIcon } from "lucide-react";
import { useId, useState, type ReactNode } from "react";

import { EnvironmentRow } from "../../components/settings/EnvironmentRow";
import { SettingsPageContainer, SettingsSection } from "../../components/settings/settingsLayout";
import { useSettingsScope } from "../../components/settings/SettingsScopeContext";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../../components/ui/alert-dialog";
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
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} from "../../components/ui/menu";
import { Switch } from "../../components/ui/switch";
import { namedClipboardTarget, useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { cn } from "../../lib/utils";
import { useEnvironments } from "../../state/environments";
import { ForkApiError, forkRequest } from "../forkApiAccess";
import {
  CHANNEL_STATUS_LABELS,
  ChannelStatusDot,
  TIMED_STATUSES,
  formatSince,
  formatSpan,
} from "../presentation";
import type { ChannelCheckStep, ChannelProbe, ChannelView, ExampleSimulation } from "../types";
import { useForkResource } from "../useForkResource";

const STEP_LABELS: Readonly<Record<ChannelCheckStep["id"], string>> = {
  token: "Token file",
  connect: "Reach adapter",
  auth: "Token accepted",
  protocol: "Protocol",
  login: "Signed in",
  online: "Collector running",
};

const SIMULATION_LABELS: Readonly<Record<ExampleSimulation, string>> = {
  online: "Online",
  needs_login: "Sign-in needed",
  collector_stopped: "Collector stopped",
  unreachable: "Adapter unreachable",
  incompatible: "Protocol mismatch",
};

/** An adapter in these states can be read, so it is worth adding without asking twice. */
const USABLE_STATUSES: ReadonlySet<ChannelProbe["status"]> = new Set([
  "online",
  "needs_login",
  "collector_stopped",
]);

export function ChannelsSettingsPanel() {
  const { scope, search, selectScope } = useSettingsScope();
  const { environments } = useEnvironments();
  const labelOf = (id: EnvironmentId) =>
    environments.find((environment) => environment.environmentId === id)?.label ?? id;
  const editableEnvironment =
    scope.kind === "environment" || scope.kind === "checkout"
      ? scope.environmentId
      : scope.kind === "project"
        ? scope.environmentId
        : null;
  const environmentIds =
    editableEnvironment !== null
      ? [editableEnvironment]
      : scope.kind === "unavailable"
        ? []
        : scope.environmentIds;
  // "All" stays read-only even with one environment: editing needs a chosen environment.
  const editable = editableEnvironment !== null;

  return (
    <SettingsPageContainer>
      {environmentIds.map((environmentId) => (
        <EnvironmentChannels
          key={environmentId}
          environmentId={environmentId}
          title={environmentIds.length === 1 ? "Channels" : labelOf(environmentId)}
          editable={editable}
          onEdit={() => selectScope({ ...search, machine: environmentId })}
        />
      ))}
    </SettingsPageContainer>
  );
}

function EnvironmentChannels({
  environmentId,
  title,
  editable,
  onEdit,
}: {
  readonly environmentId: EnvironmentId;
  readonly title: string;
  readonly editable: boolean;
  readonly onEdit: () => void;
}) {
  const resource = useForkResource<{ readonly channels: ReadonlyArray<ChannelView> }>(
    environmentId,
    "/channels",
    (event) => event.type === "channels" || event.type === "sync",
  );
  const [adding, setAdding] = useState(false);
  const channels = resource.data?.channels ?? [];

  return (
    <SettingsSection
      title={title}
      id={editable ? "channels" : undefined}
      headerAction={
        editable ? (
          <Button
            size="xs"
            variant="ghost-muted"
            disabled={resource.data === null}
            onClick={() => setAdding(true)}
          >
            <PlusIcon />
            Add channel
          </Button>
        ) : (
          <Button size="xs" variant="outline" onClick={onEdit}>
            Edit on this environment
          </Button>
        )
      }
    >
      {resource.error ? (
        <Notice>
          {resource.error.status === 404
            ? "This environment's server does not support channels."
            : resource.error.message}
        </Notice>
      ) : null}
      {resource.data === null && resource.error === null ? <Notice>Loading…</Notice> : null}
      {channels.map((channel) => (
        <ChannelRow
          key={channel.id}
          environmentId={environmentId}
          channel={channel}
          editable={editable}
        />
      ))}
      {editable ? (
        <AdapterDialog
          environmentId={environmentId}
          channel={null}
          open={adding}
          onOpenChange={setAdding}
        />
      ) : null}
    </SettingsSection>
  );
}

function Notice({ children }: { readonly children: ReactNode }) {
  return <p className="px-3 py-2.5 text-sm text-muted-foreground sm:px-4">{children}</p>;
}

/** "Online · Ricko · synced just now"; a failure's cause shows on its own line below. */
function channelSummary(channel: ChannelView): string {
  const status = CHANNEL_STATUS_LABELS[channel.status];
  if (TIMED_STATUSES.has(channel.status)) {
    const span = formatSpan(Date.now() - Date.parse(channel.statusSince));
    return span === "now" ? status : `${status} for ${span}`;
  }
  if (channel.status === "online" && channel.health) {
    return `${status} · ${channel.health.self.name} · synced ${formatSince(channel.health.lastSyncAt)}`;
  }
  return status;
}

function toForkError(error: unknown): ForkApiError {
  if (error instanceof ForkApiError) return error;
  return new ForkApiError(0, "unknown", error instanceof Error ? error.message : String(error));
}

const STEP_ORDER: ReadonlyArray<ChannelCheckStep["id"]> = [
  "token",
  "connect",
  "auth",
  "protocol",
  "login",
  "online",
];

const WHAT_TO_TRY: Readonly<Partial<Record<ChannelView["status"], ReadonlyArray<string>>>> = {
  token_missing: [
    "Start the adapter; it writes the token file when it starts.",
    "Or point the channel at the right file with Edit connection.",
  ],
  unreachable: ["Start the adapter, or fix its address with Edit connection."],
  unauthorized: ["Make sure the token file is the one this adapter wrote."],
  incompatible: ["Update the adapter or T3 Code so both speak the same protocol."],
  needs_login: ["Sign in through the adapter. Reading works meanwhile; sending waits."],
  collector_stopped: ["Restart the adapter's collector. New messages wait until it runs."],
};

type Busy = "toggle" | "check" | "simulate" | "remove";

function ChannelRow({
  environmentId,
  channel,
  editable,
}: {
  readonly environmentId: EnvironmentId;
  readonly channel: ChannelView;
  readonly editable: boolean;
}) {
  const [busy, setBusy] = useState<Busy | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const { copyToClipboard } = useCopyToClipboard({
    target: namedClipboardTarget("channel details"),
  });
  const failure = channel.enabled ? (channel.steps.find((step) => !step.ok) ?? null) : null;
  const isExample = channel.kind === "example";

  const run = async (kind: Busy, path: string, body: unknown) => {
    setBusy(kind);
    setError(null);
    try {
      await forkRequest(environmentId, path, { method: "POST", body });
    } catch (cause) {
      setError(toForkError(cause).message);
    }
    setBusy(null);
  };
  const check = () => void run("check", "/channels/test", { channelId: channel.id });
  const setEnabled = (enabled: boolean) =>
    run("toggle", "/channels/save", {
      create: false,
      channel: {
        id: channel.id,
        kind: channel.kind,
        name: channel.name,
        baseUrl: channel.baseUrl,
        tokenFile: channel.tokenFile,
        enabled,
      },
    });

  return (
    <div className="border-t border-border/60 first:border-t-0">
      <EnvironmentRow
        icon={<MessagesSquareIcon className="size-4" />}
        label={channel.name}
        dimmed={!channel.enabled}
        subtitle={
          <span className="flex min-w-0 items-center gap-1">
            <ChannelStatusDot status={channel.status} className="mr-0.5" />
            <span className="min-w-0 truncate">
              {busy === "check" ? "Checking…" : channelSummary(channel)}
            </span>
            <span aria-hidden className="shrink-0">
              ·
            </span>
            <InlineToggle expanded={detailsOpen} onToggle={() => setDetailsOpen((open) => !open)}>
              Details
            </InlineToggle>
          </span>
        }
        below={
          <>
            {failure?.detail ? (
              <p className="text-xs break-words text-destructive">{failure.detail}</p>
            ) : null}
            {error ? <p className="text-xs break-words text-destructive">{error}</p> : null}
          </>
        }
        detail={
          detailsOpen ? (
            <div className="mt-2 grid gap-3 border-t border-border/50 pt-2 text-xs">
              {failure ? (
                <>
                  <CheckHops steps={channel.steps} />
                  {WHAT_TO_TRY[channel.status] ? (
                    <div>
                      <p className="font-medium text-foreground">What to try</p>
                      <ol className="list-decimal pl-4 text-muted-foreground">
                        {WHAT_TO_TRY[channel.status]?.map((tip) => (
                          <li key={tip}>{tip}</li>
                        ))}
                      </ol>
                    </div>
                  ) : null}
                </>
              ) : null}
              <ChannelFacts channel={channel} />
              {failure ? (
                <div className="flex flex-wrap gap-2">
                  <Button size="xs" variant="outline" disabled={busy !== null} onClick={check}>
                    Check now
                  </Button>
                  <Button
                    size="xs"
                    variant="outline"
                    onClick={() => copyToClipboard(channelDiagnosticsText(channel), undefined)}
                  >
                    Copy diagnostics
                  </Button>
                </div>
              ) : null}
            </div>
          ) : null
        }
      >
        {editable ? (
          <Switch
            size="sm"
            checked={channel.enabled}
            disabled={busy !== null}
            aria-label={`${channel.enabled ? "Switch off" : "Switch on"} ${channel.name}`}
            onCheckedChange={(checked) => void setEnabled(Boolean(checked))}
          />
        ) : null}
        <Menu>
          <MenuTrigger
            render={
              <Button
                type="button"
                variant="ghost-muted"
                size="icon-xs"
                disabled={busy !== null}
                aria-label={`More actions for ${channel.name}`}
              />
            }
          >
            <EllipsisIcon className="size-3.5" />
          </MenuTrigger>
          <MenuPopup align="end">
            {editable && !isExample ? (
              <MenuItem onClick={() => setEditing(true)}>Edit connection…</MenuItem>
            ) : null}
            {editable && isExample && channel.enabled ? (
              <MenuSub>
                <MenuSubTrigger>Simulate</MenuSubTrigger>
                <MenuSubPopup>
                  <MenuRadioGroup
                    value={channel.simulation ?? "online"}
                    onValueChange={(value: string) =>
                      void run("simulate", "/channels/simulate", {
                        channelId: channel.id,
                        simulation: value,
                      })
                    }
                  >
                    {Object.entries(SIMULATION_LABELS).map(([value, label]) => (
                      <MenuRadioItem key={value} value={value}>
                        {label}
                      </MenuRadioItem>
                    ))}
                  </MenuRadioGroup>
                </MenuSubPopup>
              </MenuSub>
            ) : null}
            <MenuItem disabled={!channel.enabled} onClick={check}>
              Check now
            </MenuItem>
            {channel.health?.logsUrl ? (
              <MenuItem onClick={() => copyToClipboard(channel.health?.logsUrl ?? "", undefined)}>
                Copy logs address
              </MenuItem>
            ) : null}
            {editable && !isExample ? (
              <>
                <MenuSeparator />
                <MenuItem variant="destructive" onClick={() => setConfirmingRemove(true)}>
                  Remove channel…
                </MenuItem>
              </>
            ) : null}
          </MenuPopup>
        </Menu>
      </EnvironmentRow>
      {editable && !isExample ? (
        <>
          <AdapterDialog
            environmentId={environmentId}
            channel={channel}
            open={editing}
            onOpenChange={setEditing}
          />
          <AlertDialog open={confirmingRemove} onOpenChange={setConfirmingRemove}>
            <AlertDialogPopup>
              <AlertDialogHeader>
                <AlertDialogTitle>Remove {channel.name}?</AlertDialogTitle>
                <AlertDialogDescription>
                  The inbox stops showing it. Marks and linked threads stay.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
                <Button
                  variant="destructive"
                  onClick={() => {
                    setConfirmingRemove(false);
                    void run("remove", "/channels/remove", { channelId: channel.id });
                  }}
                >
                  Remove channel
                </Button>
              </AlertDialogFooter>
            </AlertDialogPopup>
          </AlertDialog>
        </>
      ) : null}
    </div>
  );
}

/** The subtitle's "Details ›", as Environments draws its Routes and Permissions toggles. */
function InlineToggle({
  expanded,
  onToggle,
  children,
}: {
  readonly expanded: boolean;
  readonly onToggle: () => void;
  readonly children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-expanded={expanded}
      onClick={onToggle}
      className="inline-flex shrink-0 items-center gap-0.5 rounded-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset"
    >
      {children}
      <ChevronRightIcon
        aria-hidden
        className={cn(
          "size-3 shrink-0 transition-transform duration-150 motion-reduce:transition-none",
          expanded && "rotate-90",
        )}
      />
    </button>
  );
}

const HOP_MARK = { ok: "✓", failed: "✕", unchecked: "–" } as const;

/** Every step in order, as the environment diagnosis lists its hops: done, failed, not reached. */
function CheckHops({ steps }: { readonly steps: ReadonlyArray<ChannelCheckStep> }) {
  const byId = new Map(steps.map((step) => [step.id, step] as const));
  return (
    <ol className="grid gap-0.5 text-xs" aria-label="Connection check">
      {STEP_ORDER.map((id) => {
        const step = byId.get(id);
        const result = step === undefined ? "unchecked" : step.ok ? "ok" : "failed";
        return (
          <li
            key={id}
            className={cn(
              "flex gap-2",
              result === "failed" ? "text-destructive" : "text-muted-foreground",
            )}
          >
            <span aria-hidden className="w-3 text-center">
              {HOP_MARK[result]}
            </span>
            <span className={cn(result === "ok" && "text-foreground")}>{STEP_LABELS[id]}</span>
            <span>
              {result === "failed" ? "Failed" : result === "unchecked" ? "Not checked" : ""}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

/** Where the channel connects and what the adapter says it does, in one aligned list. */
function ChannelFacts({ channel }: { readonly channel: ChannelView }) {
  const { health, config } = channel;
  return (
    <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5 text-muted-foreground">
      {channel.kind === "http-adapter" ? (
        <>
          <Fact label="Address" mono>
            {channel.baseUrl}
          </Fact>
          <Fact label="Token file" mono>
            {channel.tokenFile || "None"}
          </Fact>
        </>
      ) : null}
      {health ? (
        <Fact label="Adapter" mono>
          {health.adapterVersion} · protocol {health.protocol}
        </Fact>
      ) : null}
      {health?.lastError ? <Fact label="Last error">{health.lastError}</Fact> : null}
      {health?.logsUrl ? (
        <Fact label="Logs" mono>
          {health.logsUrl}
        </Fact>
      ) : null}
      {channel.tokenWarning ? (
        <Fact label="Warning">
          <span className="text-warning">{channel.tokenWarning}</span>
        </Fact>
      ) : null}
      {config ? (
        <>
          <Fact label="Relevant">{config.relevanceSummary}</Fact>
          <Fact label="Templates">
            {config.delegateTemplates.length === 0
              ? "None"
              : config.delegateTemplates.map((template) => (
                  <details key={template.id}>
                    <summary className="cursor-pointer">{template.name}</summary>
                    <pre className="mt-1 overflow-x-auto rounded bg-muted/50 p-2 whitespace-pre-wrap">
                      {template.prompt}
                    </pre>
                  </details>
                ))}
          </Fact>
          <Fact label="Projects">
            {channel.projectMatches.length === 0
              ? "None"
              : channel.projectMatches.map((match) => (
                  <span key={match.path} className="flex min-w-0 flex-wrap gap-x-2">
                    <span className="font-mono break-all">{match.path}</span>
                    <span className="text-muted-foreground">
                      {match.projectId ? match.projectTitle : "No T3 project here"}
                    </span>
                  </span>
                ))}
          </Fact>
        </>
      ) : null}
    </dl>
  );
}

function Fact({
  label,
  mono = false,
  children,
}: {
  readonly label: string;
  readonly mono?: boolean;
  readonly children: ReactNode;
}) {
  return (
    <div className="contents">
      <dt>{label}</dt>
      <dd
        className={cn(
          "flex min-w-0 flex-col gap-0.5 break-words whitespace-pre-wrap text-foreground",
          mono && "font-mono break-all",
        )}
      >
        {children}
      </dd>
    </div>
  );
}

function channelDiagnosticsText(channel: ChannelView): string {
  const byId = new Map(channel.steps.map((step) => [step.id, step] as const));
  return [
    `${channel.name}: ${CHANNEL_STATUS_LABELS[channel.status]}`,
    ...STEP_ORDER.map((id) => {
      const step = byId.get(id);
      const mark = step === undefined ? "-" : step.ok ? "ok" : "FAILED";
      return `  ${STEP_LABELS[id]}: ${mark}${step?.detail ? ` (${step.detail})` : ""}`;
    }),
    channel.kind === "http-adapter" ? `Address: ${channel.baseUrl}` : null,
    channel.kind === "http-adapter" ? `Token file: ${channel.tokenFile || "none"}` : null,
    channel.health ? `Adapter: ${channel.health.adapterVersion}` : null,
    channel.health?.lastError ? `Last error: ${channel.health.lastError}` : null,
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}

const FORM_FIELDS = new Set(["name", "baseUrl", "tokenFile"]);

/**
 * Adds an adapter, or changes where an existing one is. Either way it checks the adapter first:
 * one that answers is saved at once, and one that does not shows why and can be saved anyway.
 */
function AdapterDialog({
  environmentId,
  channel,
  open,
  onOpenChange,
}: {
  readonly environmentId: EnvironmentId;
  readonly channel: ChannelView | null;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-md">
        {/* Mounted per opening, so the fields start from the channel as it is now. */}
        <AdapterForm
          environmentId={environmentId}
          channel={channel}
          onClose={() => onOpenChange(false)}
        />
      </DialogPopup>
    </Dialog>
  );
}

function AdapterForm({
  environmentId,
  channel,
  onClose,
}: {
  readonly environmentId: EnvironmentId;
  readonly channel: ChannelView | null;
  readonly onClose: () => void;
}) {
  const formId = useId();
  const [name, setName] = useState(channel?.name ?? "");
  const [baseUrl, setBaseUrl] = useState(channel?.baseUrl ?? "");
  const [tokenFile, setTokenFile] = useState(channel?.tokenFile ?? "");
  const [probe, setProbe] = useState<ChannelProbe | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ForkApiError | null>(null);
  const fieldError = (field: string) => (error?.field === field ? error.message : null);
  const creating = channel === null;
  const failed = probe !== null && !USABLE_STATUSES.has(probe.status);

  const edit = (set: (value: string) => void) => (value: string) => {
    set(value);
    setProbe(null);
  };

  const save = async (checked: ChannelProbe | null) => {
    await forkRequest(environmentId, "/channels/save", {
      method: "POST",
      body: {
        create: creating,
        channel: {
          id: channel?.id ?? "",
          kind: "http-adapter",
          name: name.trim() || checked?.config?.displayName || "Channel",
          baseUrl,
          tokenFile,
          enabled: channel?.enabled ?? true,
        },
      },
    });
    onClose();
  };

  const submit = async (anyway: boolean) => {
    setBusy(true);
    setError(null);
    try {
      if (anyway) {
        await save(probe);
      } else {
        const checked = await forkRequest<ChannelProbe>(environmentId, "/channels/probe", {
          method: "POST",
          body: { baseUrl, tokenFile },
        });
        if (USABLE_STATUSES.has(checked.status)) await save(checked);
        else setProbe(checked);
      }
    } catch (cause) {
      setError(toForkError(cause));
    }
    setBusy(false);
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>{creating ? "Add a chat channel" : `Edit ${channel.name}`}</DialogTitle>
        <DialogDescription>
          The adapter runs on this environment and writes a token file for T3 Code to read.
        </DialogDescription>
      </DialogHeader>
      <DialogPanel>
        <form
          id={formId}
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            void submit(false);
          }}
        >
          <Field
            id={`${formId}-address`}
            label="Adapter address"
            error={fieldError("baseUrl")}
            hint="On this machine: 127.0.0.1, ::1, or localhost."
          >
            <Input
              id={`${formId}-address`}
              placeholder="http://127.0.0.1:7341"
              value={baseUrl}
              onChange={(event) => edit(setBaseUrl)(event.target.value)}
              required
              autoFocus
            />
          </Field>
          <Field
            id={`${formId}-token`}
            label="Token file"
            error={fieldError("tokenFile")}
            hint="Absolute, or starting with ~/."
          >
            <Input
              id={`${formId}-token`}
              placeholder="~/.config/adapter/token"
              value={tokenFile}
              onChange={(event) => edit(setTokenFile)(event.target.value)}
            />
          </Field>
          <Field
            id={`${formId}-name`}
            label={creating ? "Name (optional)" : "Name"}
            error={fieldError("name")}
          >
            <Input
              id={`${formId}-name`}
              placeholder={creating ? "The adapter's own name" : undefined}
              value={name}
              onChange={(event) => setName(event.target.value)}
              required={!creating}
            />
          </Field>
          {probe && failed ? (
            <div className="flex flex-col gap-1.5">
              <p className="text-xs break-words text-destructive">
                {probe.steps.find((step) => !step.ok)?.detail}
              </p>
              <CheckHops steps={probe.steps} />
              <p className="text-xs text-muted-foreground">
                {WHAT_TO_TRY[probe.status]?.[0] ?? "Check again, or save it as it is."}
              </p>
            </div>
          ) : null}
          {error && !(error.field && FORM_FIELDS.has(error.field)) ? (
            <p className="text-xs break-words text-destructive-foreground">{error.message}</p>
          ) : null}
        </form>
      </DialogPanel>
      <DialogFooter variant="bare">
        <Button variant="outline" onClick={onClose}>
          Cancel
        </Button>
        {failed ? (
          <Button variant="outline" disabled={busy} onClick={() => void submit(true)}>
            {creating ? "Add anyway" : "Save anyway"}
          </Button>
        ) : null}
        <Button type="submit" form={formId} disabled={busy}>
          {busy ? "Checking…" : failed ? "Check again" : creating ? "Add channel" : "Save"}
        </Button>
      </DialogFooter>
    </>
  );
}

function Field({
  id,
  label,
  hint,
  error,
  children,
}: {
  readonly id: string;
  readonly label: string;
  readonly hint?: string;
  readonly error: string | null;
  readonly children: ReactNode;
}) {
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      {children}
      {error ? (
        <p className="text-xs text-destructive-foreground">{error}</p>
      ) : hint ? (
        <p className="text-xs text-muted-foreground">{hint}</p>
      ) : null}
    </div>
  );
}
