import type { EnvironmentId } from "@t3tools/contracts";
import { CheckIcon, ChevronRightIcon, CopyIcon, PlusIcon, XIcon } from "lucide-react";
import { useState, type ReactNode } from "react";

import {
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from "../../components/settings/settingsLayout";
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
import { Input } from "../../components/ui/input";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../../components/ui/select";
import { Switch } from "../../components/ui/switch";
import { useEnvironments } from "../../state/environments";
import { ForkApiError, forkRequest } from "../forkApiAccess";
import {
  CHANNEL_STATUS_LABELS,
  ChannelStatusDot,
  TIMED_STATUSES,
  formatSince,
  formatSpan,
} from "../presentation";
import {
  toChannelTestResult,
  type ChannelKind,
  type ChannelTestResult,
  type ChannelView,
  type ExampleSimulation,
} from "../types";
import { useForkResource } from "../useForkResource";

const STEP_LABELS: Readonly<Record<ChannelView["steps"][number]["id"], string>> = {
  token: "Token file",
  connect: "Reach adapter",
  auth: "Token accepted",
  protocol: "Protocol",
  login: "Signed in",
  online: "Collector running",
};

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
  const [openId, setOpenId] = useState<string | null>(null);
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
            disabled={resource.data === null || adding}
            onClick={() => setAdding(true)}
          >
            <PlusIcon className="size-3" />
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
      {editable && adding ? (
        <ChannelForm
          environmentId={environmentId}
          onDone={(created) => {
            setAdding(false);
            if (created) setOpenId(created);
          }}
        />
      ) : null}
      {channels.map((channel) => (
        <div key={channel.id} className="border-t border-border/60 first:border-t-0">
          <button
            type="button"
            className="flex w-full min-w-0 items-center gap-3 px-3 py-2.5 text-left sm:px-4"
            aria-expanded={openId === channel.id}
            onClick={() => setOpenId(openId === channel.id ? null : channel.id)}
          >
            <ChannelStatusDot status={channel.status} />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium">{channel.name}</span>
              <span className="block truncate text-xs text-muted-foreground">
                {channelSummary(channel)}
              </span>
            </span>
            <ChevronRightIcon
              className={
                openId === channel.id
                  ? "size-4 shrink-0 rotate-90 text-muted-foreground"
                  : "size-4 shrink-0 text-muted-foreground"
              }
            />
          </button>
          {openId === channel.id ? (
            <ChannelDetail
              environmentId={environmentId}
              channel={channel}
              editable={editable}
              onRemoved={() => setOpenId(null)}
            />
          ) : null}
        </div>
      ))}
    </SettingsSection>
  );
}

/** "Online · synced just now"; versions live in the adapter details only. */
function channelSummary(channel: ChannelView): string {
  const status = CHANNEL_STATUS_LABELS[channel.status];
  if (TIMED_STATUSES.has(channel.status)) {
    return `${status} for ${formatSpan(Date.now() - Date.parse(channel.statusSince))}`;
  }
  if (channel.status === "online" && channel.health) {
    return `${status} · synced ${formatSince(channel.health.lastSyncAt)}`;
  }
  return status;
}

function Notice({ children }: { readonly children: ReactNode }) {
  return <p className="px-3 py-2.5 text-sm text-muted-foreground sm:px-4">{children}</p>;
}

/** A field as a settings row: label and constraint on the left, control on the right. */
function FieldRow({
  title,
  hint,
  error,
  children,
}: {
  readonly title: string;
  readonly hint?: string;
  readonly error?: string | null;
  readonly children: ReactNode;
}) {
  return (
    <SettingsRow
      title={title}
      description={
        error ? <span className="text-destructive-foreground">{error}</span> : (hint ?? null)
      }
      control={<div className="w-full @min-[32rem]/settings-row:w-64">{children}</div>}
    />
  );
}

function toForkError(error: unknown): ForkApiError {
  if (error instanceof ForkApiError) return error;
  return new ForkApiError(0, "unknown", error instanceof Error ? error.message : String(error));
}

const SIMULATION_LABELS: Readonly<Record<ExampleSimulation, string>> = {
  online: "Online",
  needs_login: "Sign-in needed",
  collector_stopped: "Collector stopped",
  unreachable: "Adapter unreachable",
  incompatible: "Protocol mismatch",
};

const ADDRESS_HINT = "127.0.0.1, ::1, or localhost";
const TOKEN_FILE_HINT = "Absolute path or ~/…";

function ChannelForm({
  environmentId,
  onDone,
}: {
  readonly environmentId: EnvironmentId;
  readonly onDone: (createdId: string | null) => void;
}) {
  const [kind, setKind] = useState<ChannelKind>("http-adapter");
  const [id, setId] = useState("");
  const [name, setName] = useState("");
  const [baseUrl, setBaseUrl] = useState("http://127.0.0.1:");
  const [tokenFile, setTokenFile] = useState("");
  const [error, setError] = useState<ForkApiError | null>(null);
  const [saving, setSaving] = useState(false);
  const fieldError = (field: string) => (error?.field === field ? error.message : null);

  const submit = async () => {
    setSaving(true);
    setError(null);
    try {
      await forkRequest(environmentId, "/channels/save", {
        method: "POST",
        body: {
          create: true,
          channel: { id: id.trim(), kind, name, baseUrl, tokenFile, enabled: true },
        },
      });
      setSaving(false);
      onDone(id.trim());
    } catch (cause) {
      setSaving(false);
      setError(toForkError(cause));
    }
  };

  return (
    <form
      className="flex flex-col"
      aria-label="Add channel"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <FieldRow title="Kind">
        <Select value={kind} onValueChange={(value) => value && setKind(value as ChannelKind)}>
          <SelectTrigger aria-label="Channel kind" size="sm">
            <SelectValue>{kind === "example" ? "Example (made-up data)" : "Adapter"}</SelectValue>
          </SelectTrigger>
          <SelectPopup>
            <SelectItem value="http-adapter">Adapter</SelectItem>
            <SelectItem value="example">Example (made-up data)</SelectItem>
          </SelectPopup>
        </Select>
      </FieldRow>
      <FieldRow title="ID" hint="a–z, 0–9 and -. Can't be changed later." error={fieldError("id")}>
        <Input
          size="sm"
          aria-label="ID"
          value={id}
          onChange={(event) => setId(event.target.value)}
          required
        />
      </FieldRow>
      <FieldRow title="Name" error={fieldError("name")}>
        <Input
          size="sm"
          aria-label="Name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          required
        />
      </FieldRow>
      {kind === "http-adapter" ? (
        <>
          <FieldRow title="Adapter address" hint={ADDRESS_HINT} error={fieldError("baseUrl")}>
            <Input
              size="sm"
              aria-label="Adapter address"
              value={baseUrl}
              onChange={(event) => setBaseUrl(event.target.value)}
            />
          </FieldRow>
          <FieldRow title="Token file" hint={TOKEN_FILE_HINT} error={fieldError("tokenFile")}>
            <Input
              size="sm"
              aria-label="Token file"
              value={tokenFile}
              placeholder="~/.config/adapter/token"
              onChange={(event) => setTokenFile(event.target.value)}
            />
          </FieldRow>
        </>
      ) : null}
      <div className="flex flex-wrap items-center gap-2 px-3 pt-1 pb-3 sm:px-4">
        <Button type="submit" size="sm" disabled={saving}>
          {saving ? "Adding…" : "Add channel"}
        </Button>
        <Button type="button" size="sm" variant="outline" onClick={() => onDone(null)}>
          Cancel
        </Button>
        {error && !error.field ? (
          <p className="text-xs text-destructive-foreground">{error.message}</p>
        ) : null}
      </div>
    </form>
  );
}

function ChannelDetail({
  environmentId,
  channel,
  editable,
  onRemoved,
}: {
  readonly environmentId: EnvironmentId;
  readonly channel: ChannelView;
  readonly editable: boolean;
  readonly onRemoved: () => void;
}) {
  const [name, setName] = useState(channel.name);
  const [baseUrl, setBaseUrl] = useState(channel.baseUrl);
  const [tokenFile, setTokenFile] = useState(channel.tokenFile);
  const [busy, setBusy] = useState<"save" | "test" | "remove" | "simulate" | null>(null);
  const [error, setError] = useState<ForkApiError | null>(null);
  const [tested, setTested] = useState<ChannelTestResult | null>(null);
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const dirty =
    name !== channel.name || baseUrl !== channel.baseUrl || tokenFile !== channel.tokenFile;
  const shown = tested ?? channel;
  const fieldError = (field: string) => (error?.field === field ? error.message : null);

  const run = async (
    kind: "save" | "test" | "remove" | "simulate",
    action: () => Promise<void>,
  ) => {
    setBusy(kind);
    setError(null);
    try {
      await action();
      setBusy(null);
    } catch (cause) {
      setBusy(null);
      setError(toForkError(cause));
    }
  };
  const save = (enabled: boolean) =>
    run("save", async () => {
      await forkRequest(environmentId, "/channels/save", {
        method: "POST",
        body: {
          create: false,
          channel: { id: channel.id, kind: channel.kind, name, baseUrl, tokenFile, enabled },
        },
      });
      setTested(null);
    });
  const remove = () =>
    run("remove", async () => {
      await forkRequest(environmentId, "/channels/remove", {
        method: "POST",
        body: { channelId: channel.id },
      });
      onRemoved();
    });

  return (
    <div className="flex flex-col pb-3">
      {editable ? (
        <>
          <SettingsRow
            title="Enabled"
            control={
              <Switch
                checked={channel.enabled}
                disabled={busy !== null}
                aria-label="Enabled"
                onCheckedChange={(checked) => void save(Boolean(checked))}
              />
            }
          />
          <FieldRow title="Name" error={fieldError("name")}>
            <Input
              size="sm"
              aria-label="Name"
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </FieldRow>
          {channel.kind === "http-adapter" ? (
            <>
              <FieldRow title="Adapter address" hint={ADDRESS_HINT} error={fieldError("baseUrl")}>
                <Input
                  size="sm"
                  aria-label="Adapter address"
                  value={baseUrl}
                  onChange={(event) => setBaseUrl(event.target.value)}
                />
              </FieldRow>
              <FieldRow title="Token file" hint={TOKEN_FILE_HINT} error={fieldError("tokenFile")}>
                <Input
                  size="sm"
                  aria-label="Token file"
                  value={tokenFile}
                  placeholder="~/.config/adapter/token"
                  onChange={(event) => setTokenFile(event.target.value)}
                />
              </FieldRow>
            </>
          ) : (
            <FieldRow title="Simulate status">
              <Select
                value={channel.simulation ?? "online"}
                disabled={busy !== null}
                onValueChange={(value) => {
                  if (!value) return;
                  void run("simulate", async () => {
                    await forkRequest(environmentId, "/channels/simulate", {
                      method: "POST",
                      body: { channelId: channel.id, simulation: value },
                    });
                    setTested(null);
                  });
                }}
              >
                <SelectTrigger aria-label="Simulate status" size="sm">
                  <SelectValue>{SIMULATION_LABELS[channel.simulation ?? "online"]}</SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  {Object.entries(SIMULATION_LABELS).map(([value, label]) => (
                    <SelectItem key={value} value={value}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </FieldRow>
          )}
          <div className="flex flex-wrap items-center gap-2 px-3 py-2 sm:px-4">
            <Button
              size="sm"
              disabled={!dirty || busy !== null}
              onClick={() => void save(channel.enabled)}
            >
              {busy === "save" ? "Saving…" : "Save"}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={busy !== null || !channel.enabled}
              onClick={() =>
                void run("test", async () => {
                  const result = await forkRequest<ChannelView>(environmentId, "/channels/test", {
                    method: "POST",
                    body: { channelId: channel.id },
                  });
                  setTested(toChannelTestResult(result));
                })
              }
            >
              {busy === "test" ? "Testing…" : "Test connection"}
            </Button>
            <Button
              size="sm"
              variant="ghost-destructive"
              disabled={busy !== null}
              onClick={() => setConfirmingRemove(true)}
            >
              Remove
            </Button>
          </div>
          {error && !error.field ? (
            <p className="px-3 text-xs text-destructive-foreground sm:px-4">{error.message}</p>
          ) : null}
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
                    void remove();
                  }}
                >
                  Remove channel
                </Button>
              </AlertDialogFooter>
            </AlertDialogPopup>
          </AlertDialog>
        </>
      ) : null}

      <div className="flex flex-col gap-3 px-3 pt-2 sm:px-4">
        {channel.enabled && shown.steps.length > 0 ? (
          <ol className="flex flex-col gap-1.5" aria-label="Connection check">
            {shown.steps.map((step) => (
              <li key={step.id} className="flex min-w-0 items-start gap-2 text-xs">
                {step.ok ? (
                  <CheckIcon className="mt-0.5 size-3.5 shrink-0 text-success" />
                ) : (
                  <XIcon className="mt-0.5 size-3.5 shrink-0 text-destructive-foreground" />
                )}
                <span className="min-w-0">
                  <span className="font-medium">{STEP_LABELS[step.id]}</span>
                  {step.detail ? (
                    <span
                      className={
                        step.ok
                          ? "text-muted-foreground"
                          : "break-words text-destructive-foreground"
                      }
                    >
                      {step.ok ? ` · ${step.detail}` : `: ${step.detail}`}
                    </span>
                  ) : null}
                </span>
              </li>
            ))}
          </ol>
        ) : null}
        {shown.tokenWarning ? <p className="text-xs text-warning">{shown.tokenWarning}</p> : null}

        <AdapterInfo channel={channel} />
      </div>
    </div>
  );
}

function AdapterInfo({ channel }: { readonly channel: ChannelView }) {
  const { health, config } = channel;
  if (!health && !config) return null;
  return (
    <div className="flex flex-col gap-3 rounded-md border border-border/60 p-3">
      <h3 className="text-xs font-medium text-muted-foreground">From the adapter</h3>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-xs">
        {health ? (
          <>
            <dt className="text-muted-foreground">Account</dt>
            <dd className="truncate">{health.self.name}</dd>
            <dt className="text-muted-foreground">Adapter</dt>
            <dd>
              {health.adapterVersion} · protocol {health.protocol}
            </dd>
            <dt className="text-muted-foreground">Last sync</dt>
            <dd>{formatSince(health.lastSyncAt)}</dd>
          </>
        ) : null}
        {health?.lastError ? (
          <>
            <dt className="text-muted-foreground">Last error</dt>
            <dd className="break-words whitespace-pre-wrap">{health.lastError}</dd>
          </>
        ) : null}
        {health?.logsUrl ? (
          <>
            <dt className="text-muted-foreground">Logs</dt>
            <dd className="flex min-w-0 items-center gap-1">
              <code className="min-w-0 truncate">{health.logsUrl}</code>
              <CopyButton text={health.logsUrl} label="Copy logs address" />
            </dd>
          </>
        ) : null}
      </dl>
      {config ? (
        <>
          <section className="flex flex-col gap-1">
            <h4 className="text-xs font-medium">What counts as relevant</h4>
            <p className="text-xs break-words whitespace-pre-wrap text-muted-foreground">
              {config.relevanceSummary}
            </p>
          </section>
          <section className="flex flex-col gap-1">
            <h4 className="text-xs font-medium">Delegate templates</h4>
            {config.delegateTemplates.length === 0 ? (
              <p className="text-xs text-muted-foreground">None.</p>
            ) : (
              config.delegateTemplates.map((template) => (
                <details key={template.id} className="text-xs">
                  <summary className="cursor-pointer">{template.name}</summary>
                  <pre className="mt-1 overflow-x-auto rounded bg-muted/50 p-2 whitespace-pre-wrap">
                    {template.prompt}
                  </pre>
                </details>
              ))
            )}
          </section>
          <section className="flex flex-col gap-1">
            <h4 className="text-xs font-medium">Default projects</h4>
            {channel.projectMatches.length === 0 ? (
              <p className="text-xs text-muted-foreground">None.</p>
            ) : (
              <ul className="flex flex-col gap-1 text-xs">
                {channel.projectMatches.map((match) => (
                  <li key={match.path} className="flex min-w-0 flex-wrap gap-x-2">
                    <code className="min-w-0 break-all">{match.path}</code>
                    <span className={match.projectId ? "text-success" : "text-muted-foreground"}>
                      {match.projectId ? `Matched: ${match.projectTitle}` : "No T3 project here"}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      ) : null}
    </div>
  );
}

function CopyButton({ text, label }: { readonly text: string; readonly label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      size="icon-xs"
      variant="ghost"
      aria-label={label}
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1_500);
        });
      }}
    >
      {copied ? <CheckIcon /> : <CopyIcon />}
    </Button>
  );
}
