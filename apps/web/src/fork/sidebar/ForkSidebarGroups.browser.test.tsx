import { EnvironmentId, ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import type { BotSummary } from "@t3tools/fork-client/bots";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import "~/index.css";
import { render } from "../../../test/render";
import { useEnvironmentProviders } from "../../state/environments";
import { removeLocalStorageItem } from "../../hooks/useLocalStorage";
import { useInboxOverviews } from "../inbox/useInboxOverviews";
import { ForkSidebarGroups } from "./ForkSidebarGroups";
import { SIDEBAR_INBOX_ROWS } from "./sidebarAttention";

vi.mock("../inbox/useInboxOverviews", () => ({ useInboxOverviews: vi.fn() }));
vi.mock("../../state/entities", () => ({ useQuietThreadShells: () => [] }));
vi.mock("../../state/environments", () => ({
  useEnvironmentProviders: vi.fn(),
  useEnvironmentMachines: () => new Map(),
}));
vi.mock("../../components/ui/sidebar", () => ({
  useSidebar: () => ({ isMobile: false, setOpenMobile: vi.fn() }),
}));
vi.mock("../bot/BotsPage", () => ({
  rememberBot: vi.fn(),
  CreateBotDialog: () => (
    <div role="dialog" aria-label="New bot">
      Create a bot
    </div>
  ),
}));

const environmentId = EnvironmentId.make("sidebar-test");
const bot: BotSummary = {
  id: "bot",
  name: "Release watcher",
  modelSelection: {
    instanceId: ProviderInstanceId.make("missing-provider"),
    model: "full-model-name",
  },
  working: false,
  paused: false,
  lastMessage: { role: "user", text: "Check the release", createdAt: "2026-11-28T00:00:00Z" },
  unread: 0,
  questions: 0,
  workThreadId: null,
};

function setup(count = 0) {
  vi.mocked(useEnvironmentProviders).mockReset().mockReturnValue(new Map());
  removeLocalStorageItem("t3code:fork-sidebar-bots-collapsed");
  removeLocalStorageItem("t3code:fork-sidebar-inbox-collapsed");
  vi.mocked(useInboxOverviews)
    .mockReset()
    .mockReturnValue([
      {
        environmentId,
        label: "Remote machine",
        unreadCount: count,
        channels: [
          {
            id: "channel",
            name: "Channel",
            kind: "example",
            status: "online",
            statusSince: "2026-11-28T00:00:00Z",
            lastSyncAt: null,
            selfName: null,
            access: { read: true, send: true, stale: false },
            capabilities: [],
            unreadCount: count,
            error: null,
            attention: {
              delegations: [],
              conversations: Array.from({ length: count }, (_, i) => ({
                id: String(i),
                channelId: "channel",
                kind: "dm",
                name: `Conversation ${i}`,
                lastActivityAt: "2026-11-28T00:00:00Z",
                lastMessage: null,
                unread: true,
                mentioned: false,
                readThroughAt: null,
                muted: false,
              })),
            },
          },
        ],
      },
    ]);
}

it("toggles whole headers and keeps their action buttons independent", async () => {
  setup();
  await using screen = await render(
    <ForkSidebarGroups
      bots={[{ environmentId, label: "Remote machine", bots: [bot] }]}
      projectScope={[]}
    />,
  );
  const bots = screen.getByRole("button", { name: /^Bots/ });
  await bots.click();
  await expect.element(bots).toHaveAttribute("aria-expanded", "false");
  expect(screen.router?.state.location.pathname).toBe("/");
  await screen.getByRole("button", { name: "New bot", exact: true }).click();
  await expect.element(screen.getByRole("dialog", { name: "New bot" })).toBeVisible();
  await expect.element(bots).toHaveAttribute("aria-expanded", "false");
  await bots.click();
  await expect.element(screen.getByText("You: Check the release", { exact: true })).toBeVisible();
  const inbox = screen.getByRole("button", { name: /^Inbox/ });
  await inbox.click();
  await expect.element(inbox).toHaveAttribute("aria-expanded", "false");
  await screen.getByRole("button", { name: "Open Inbox", exact: true }).click();
  await expect.poll(() => screen.router?.state.location.pathname).toBe("/inbox");
  await expect.element(inbox).toHaveAttribute("aria-expanded", "false");
});

it.each([0, 1, SIDEBAR_INBOX_ROWS, SIDEBAR_INBOX_ROWS + 1])(
  "offers the complete inbox at the correct boundary: %s",
  async (count) => {
    setup(count);
    await using screen = await render(<ForkSidebarGroups bots={[]} projectScope={[]} />);
    const footer = screen.getByRole("button", {
      name: count === 0 ? "All conversations" : "1 more",
      exact: true,
    });
    if (count === 0 || count > SIDEBAR_INBOX_ROWS) {
      await footer.click();
      await expect.poll(() => screen.router?.state.location.pathname).toBe("/inbox");
    } else {
      await expect.element(footer).not.toBeInTheDocument();
      await expect
        .element(screen.getByRole("button", { name: "All conversations", exact: true }))
        .not.toBeInTheDocument();
    }
  },
);

it("reveals full bot context on hover even when its provider is unavailable", async () => {
  setup();
  const text = "Full message detail ".repeat(30);
  await using screen = await render(
    <ForkSidebarGroups
      bots={[
        {
          environmentId,
          label: "Remote machine with a long full environment name",
          bots: [{ ...bot, lastMessage: { ...bot.lastMessage!, text }, paused: true }],
        },
      ]}
      projectScope={[]}
    />,
  );
  const row = screen.getByRole("button", { name: /Release watcher/ });
  await row.hover();
  await expect.poll(() => document.querySelector('[data-slot="tooltip-popup"]')).not.toBeNull();
  const tooltip = page.elementLocator(document.querySelector('[data-slot="tooltip-popup"]')!);
  await expect.element(tooltip).toBeVisible();
  await expect
    .element(tooltip.getByText("Remote machine with a long full environment name"))
    .toBeVisible();
  await expect.element(tooltip.getByText("full-model-name")).toBeVisible();
  await expect.element(tooltip.getByText("Paused", { exact: true })).toBeVisible();
  await expect.element(tooltip.getByText(`You: ${text}`, { exact: true })).toBeVisible();
});

it("resolves the provider within the bot's environment and keeps its icon beside the preview", async () => {
  setup();
  const provider = {
    instanceId: bot.modelSelection.instanceId,
    driver: ProviderDriverKind.make("codex"),
    displayName: "Remote Codex",
    accentColor: "#123456",
    enabled: true,
    installed: true,
    version: null,
    status: "ready" as const,
    auth: { status: "authenticated" as const },
    checkedAt: "2026-11-28T00:00:00Z",
    models: [
      { slug: bot.modelSelection.model, name: "Remote model", isCustom: false, capabilities: {} },
    ],
    slashCommands: [],
    skills: [],
  };
  vi.mocked(useEnvironmentProviders).mockReturnValue(
    new Map([
      [
        EnvironmentId.make("another-environment"),
        [{ ...provider, models: [{ ...provider.models[0]!, name: "Wrong model" }] }],
      ],
      [environmentId, [provider]],
    ]),
  );
  await using screen = await render(
    <ForkSidebarGroups
      bots={[{ environmentId, label: "Remote machine", bots: [bot] }]}
      projectScope={[]}
    />,
  );
  const row = screen.getByRole("button", { name: /Release watcher/ });
  expect(row.element().querySelector("[data-provider-accent-color]")).not.toBeNull();
  await row.hover();
  await expect.poll(() => document.querySelector('[data-slot="tooltip-popup"]')).not.toBeNull();
  const tooltip = page.elementLocator(document.querySelector('[data-slot="tooltip-popup"]')!);
  await expect.element(tooltip.getByText(/Remote model/)).toBeVisible();
  await expect.element(tooltip.getByText(/Wrong model/)).not.toBeInTheDocument();
});

it.each([
  { name: "question", changes: { questions: 1 }, previewClass: "text-foreground/85" },
  { name: "unread", changes: { unread: 1 }, previewClass: "text-foreground/85" },
  {
    name: "error",
    changes: { unread: 1, lastMessage: { ...bot.lastMessage!, role: "error" as const } },
    previewClass: "text-error-foreground",
  },
  { name: "empty", changes: { lastMessage: null }, previewClass: "italic" },
  { name: "paused", changes: { paused: true }, previewClass: "text-secondary-label" },
  { name: "working", changes: { working: true }, previewClass: "text-secondary-label" },
])("renders the bot's $name state", async ({ name, changes, previewClass }) => {
  setup();
  await using screen = await render(
    <ForkSidebarGroups
      bots={[{ environmentId, label: "Hidden environment prefix", bots: [{ ...bot, ...changes }] }]}
      projectScope={[]}
    />,
  );
  const preview = screen.getByText(
    name === "empty"
      ? "No messages yet"
      : name === "error"
        ? "Check the release"
        : "You: Check the release",
    { exact: true },
  );
  await expect.element(preview).toHaveClass(previewClass);
  await expect.element(screen.getByText(/Hidden environment prefix/)).not.toBeInTheDocument();
  if (name === "paused")
    await expect
      .element(screen.getByRole("button", { name: /Release watcher/ }))
      .toHaveClass("opacity-60");
  if (name === "working")
    await expect
      .element(screen.getByText("Release watcher", { exact: true }))
      .toHaveClass("text-muted-foreground");
});

it("narrows bots and inbox to the environments of the chosen projects", async () => {
  setup(1);
  const other = EnvironmentId.make("other-environment");
  const listings = [
    { environmentId, label: "Remote machine", bots: [bot] },
    {
      environmentId: other,
      label: "Other machine",
      bots: [{ ...bot, id: "other", name: "Other bot" }],
    },
  ];
  await using screen = await render(
    <ForkSidebarGroups
      bots={listings}
      projectScope={[{ memberProjectRefs: [{ environmentId: other }] }]}
    />,
  );
  await expect.element(screen.getByRole("button", { name: /Other bot/ })).toBeVisible();
  await expect
    .element(screen.getByRole("button", { name: /Release watcher/ }))
    .not.toBeInTheDocument();
  await expect.element(screen.getByRole("button", { name: /^Inbox/ })).not.toBeInTheDocument();
});
