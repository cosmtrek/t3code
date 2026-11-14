import type { EnvironmentId } from "@t3tools/contracts";
import { CheckIcon, ChevronRightIcon, CopyIcon, PlusIcon, XIcon } from "lucide-react";
import { useState, type ReactNode } from "react";

import { SettingsPageContainer, SettingsSection } from "../../components/settings/settingsLayout";
import { useSettingsScope } from "../../components/settings/SettingsScopeContext";
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
import type { ChannelKind, ChannelView } from "../types";
import { useForkResource } from "../useForkResource";

const STEP_LABELS: Readonly<Record<ChannelView["steps"][number]["id"], string>> = {
  token: "Read token file",
  connect: "Reach adapter",
  auth: "Token accepted",
  protocol: "Protocol version",
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
  const single = environmentIds.length === 1;

  return (
    <SettingsPageContainer>
      {environmentIds.map((environmentId) => (
        <EnvironmentChannels
          key={environmentId}
          environmentId={environmentId}
          title={single ? "Channels" : labelOf(environmentId)}
          editable={single}
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
    (event) => event.type === "channels",
  );
  const [openId, setOpenId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const channels = resource.data?.channels ?? [];

  return (
    <SettingsSection
      title={title}
      id={editable ? "channels" : undefined}
      headerAction={
        editable ? null : (
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
      {editable && resource.data !== null ? (
        <p className="px-3 pt-2.5 text-xs text-muted-foreground sm:px-4">
          Each environment connects to adapters running on its own machine. The inbox shows the
          enabled ones.
        </p>
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
      {editable && resource.data !== null ? (
        adding ? (
          <ChannelForm
            environmentId={environmentId}
            onDone={(created) => {
              setAdding(false);
              if (created) setOpenId(created);
            }}
          />
        ) : (
          <div className="border-t border-border/60 px-3 py-2.5 sm:px-4">
            <Button size="sm" variant="outline" onClick={() => setAdding(true)}>
              <PlusIcon />
              Add channel
            </Button>
          </div>
        )
      ) : null}
    </SettingsSection>
  );
}

function channelSummary(channel: ChannelView): string {
  const parts: string[] = [CHANNEL_STATUS_LABELS[channel.status]];
  if (TIMED_STATUSES.has(channel.status)) {
    parts[0] = `${parts[0]} for ${formatSpan(Date.now() - Date.parse(channel.statusSince))}`;
  }
  if (channel.health) {
    parts.push(`adapter ${channel.health.adapterVersion}`, `protocol ${channel.health.protocol}`);
    if (channel.status === "online") parts.push(`synced ${formatSince(channel.health.lastSyncAt)}`);
  }
  return parts.join(" · ");
}

function Notice({ children }: { readonly children: ReactNode }) {
  return <p className="px-3 py-2.5 text-sm text-muted-foreground sm:px-4">{children}</p>;
}

function Field({
  label,
  hint,
  error,
  children,
}: {
  readonly label: string;
  readonly hint?: ReactNode;
  readonly error?: string | null;
  readonly children: ReactNode;
}) {
  return (
    <label className="flex min-w-0 flex-col gap-1.5">
      <span className="text-xs font-medium text-foreground">{label}</span>
      {children}
      {error ? (
        <span className="text-xs text-destructive-foreground">{error}</span>
      ) : hint ? (
        <span className="text-xs text-muted-foreground">{hint}</span>
      ) : null}
    </label>
  );
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

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
      onDone(id.trim());
    } catch (cause) {
      setError(
        cause instanceof ForkApiError ? cause : new ForkApiError(0, "unknown", errorText(cause)),
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <form
      className="flex flex-col gap-3 border-t border-border/60 px-3 py-3 sm:px-4"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <h3 className="text-sm font-medium">Add channel</h3>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Kind">
          <Select value={kind} onValueChange={(value) => value && setKind(value as ChannelKind)}>
            <SelectTrigger aria-label="Channel kind" size="sm">
              <SelectValue>{kind === "example" ? "Example (made-up data)" : "Adapter"}</SelectValue>
            </SelectTrigger>
            <SelectPopup>
              <SelectItem value="http-adapter">Adapter</SelectItem>
              <SelectItem value="example">Example (made-up data)</SelectItem>
            </SelectPopup>
          </Select>
        </Field>
        <Field
          label="Id"
          hint="Lowercase letters, digits, and dashes. It cannot change later."
          error={fieldError("id")}
        >
          <Input size="sm" value={id} onChange={(event) => setId(event.target.value)} required />
        </Field>
        <Field label="Name" error={fieldError("name")}>
          <Input
            size="sm"
            value={name}
            onChange={(event) => setName(event.target.value)}
            required
          />
        </Field>
        {kind === "http-adapter" ? (
          <>
            <Field
              label="Adapter address"
              hint="Only this machine: 127.0.0.1, ::1, or localhost."
              error={fieldError("baseUrl")}
            >
              <Input
                size="sm"
                value={baseUrl}
                onChange={(event) => setBaseUrl(event.target.value)}
              />
            </Field>
            <Field
              label="Token file"
              hint="Absolute or starting with ~/. The adapter's documentation names it."
              error={fieldError("tokenFile")}
            >
              <Input
                size="sm"
                value={tokenFile}
                placeholder="~/.config/adapter/token"
                onChange={(event) => setTokenFile(event.target.value)}
              />
            </Field>
          </>
        ) : null}
      </div>
      {error && !error.field ? (
        <p className="text-xs text-destructive-foreground">{error.message}</p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" size="sm" disabled={saving}>
          {saving ? "Adding…" : "Add channel"}
        </Button>
        <Button type="button" size="sm" variant="outline" onClick={() => onDone(null)}>
          Cancel
        </Button>
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
  const [busy, setBusy] = useState<"save" | "test" | "remove" | null>(null);
  const [error, setError] = useState<ForkApiError | null>(null);
  const [tested, setTested] = useState<ChannelView | null>(null);
  const dirty =
    name !== channel.name || baseUrl !== channel.baseUrl || tokenFile !== channel.tokenFile;
  const shown = tested ?? channel;
  const fieldError = (field: string) => (error?.field === field ? error.message : null);

  const run = async (kind: "save" | "test" | "remove", action: () => Promise<void>) => {
    setBusy(kind);
    setError(null);
    try {
      await action();
    } catch (cause) {
      setError(
        cause instanceof ForkApiError ? cause : new ForkApiError(0, "unknown", errorText(cause)),
      );
    } finally {
      setBusy(null);
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

  return (
    <div className="flex flex-col gap-4 px-3 pb-4 sm:px-4">
      {editable ? (
        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between gap-3">
            <span className="text-sm">Enabled</span>
            <Switch
              checked={channel.enabled}
              disabled={busy !== null}
              aria-label="Enabled"
              onCheckedChange={(checked) => void save(Boolean(checked))}
            />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Name" error={fieldError("name")}>
              <Input size="sm" value={name} onChange={(event) => setName(event.target.value)} />
            </Field>
            {channel.kind === "http-adapter" ? (
              <>
                <Field
                  label="Adapter address"
                  hint="Only this machine: 127.0.0.1, ::1, or localhost."
                  error={fieldError("baseUrl")}
                >
                  <Input
                    size="sm"
                    value={baseUrl}
                    onChange={(event) => setBaseUrl(event.target.value)}
                  />
                </Field>
                <Field
                  label="Token file"
                  hint="The adapter writes the token here; T3 Code never shows it."
                  error={fieldError("tokenFile")}
                >
                  <Input
                    size="sm"
                    value={tokenFile}
                    placeholder="~/.config/adapter/token"
                    onChange={(event) => setTokenFile(event.target.value)}
                  />
                </Field>
              </>
            ) : (
              <p className="self-end text-xs text-muted-foreground">
                The built-in example serves made-up conversations for trying the inbox.
              </p>
            )}
          </div>
          <div className="flex flex-wrap gap-2">
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
                  setTested(
                    await forkRequest<ChannelView>(environmentId, "/channels/test", {
                      method: "POST",
                      body: { channelId: channel.id },
                    }),
                  );
                })
              }
            >
              {busy === "test" ? "Testing…" : "Test connection"}
            </Button>
            <Button
              size="sm"
              variant="ghost-destructive"
              disabled={busy !== null}
              onClick={() =>
                void run("remove", async () => {
                  await forkRequest(environmentId, "/channels/remove", {
                    method: "POST",
                    body: { channelId: channel.id },
                  });
                  onRemoved();
                })
              }
            >
              Remove
            </Button>
          </div>
          {error && !error.field ? (
            <p className="text-xs text-destructive-foreground">{error.message}</p>
          ) : null}
        </div>
      ) : null}

      {shown.enabled && shown.steps.length > 0 ? (
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
                <span className="break-words text-muted-foreground">: {step.detail}</span>
              </span>
            </li>
          ))}
        </ol>
      ) : null}
      {shown.tokenWarning ? <p className="text-xs text-warning">{shown.tokenWarning}</p> : null}

      <AdapterInfo channel={shown} />
    </div>
  );
}

function AdapterInfo({ channel }: { readonly channel: ChannelView }) {
  const { health, config } = channel;
  if (!health && !config) return null;
  return (
    <div className="flex flex-col gap-3 rounded-md border border-border/60 p-3">
      <p className="text-xs text-muted-foreground">
        Provided by the adapter; change these in the adapter's own configuration.
      </p>
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
