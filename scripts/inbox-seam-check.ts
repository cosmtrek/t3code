// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - A plain maintenance script, run by hand after each upstream sync.
/**
 * Checks that the inbox fork still plugs into upstream after a sync. See "Inbox seams" in FORK.md.
 *
 *   node scripts/inbox-seam-check.ts [--since <old tag> --to <new tag>]
 *   node scripts/inbox-seam-check.ts regen-route-tree
 *
 * Exits non-zero on any failed check, and on a missing or unknown ref.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const repoRoot = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..");

interface Check {
  readonly name: string;
  readonly file: string;
  readonly ok: (text: string) => boolean;
  readonly fix: string;
}

/** The text between `start` and the first `end` after it, or "" when `start` is missing. */
const between = (text: string, start: string, end: string) => {
  const from = text.indexOf(start);
  if (from === -1) return "";
  const to = text.indexOf(end, from + start.length);
  return text.slice(from, to === -1 ? undefined : to);
};

const SEAM_FILES = [
  "apps/server/src/server.ts",
  "apps/web/src/components/settings/settingsSearch.ts",
  "apps/web/src/components/settings/SettingsSidebarNav.tsx",
  "apps/web/src/components/sidebar/SidebarChrome.tsx",
  "apps/web/src/routeTree.gen.ts",
  "package.json",
];

/** Quoted either way, as formatters and generators differ. */
const quoted = (value: string) =>
  new RegExp(`["'\`]${value.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}["'\`]`);

/** Each `fullPath: '<path>'` block in the generated tree, with the route import it loads. */
function generatedRoutes(text: string, fullPath: string): string[] {
  const block = new RegExp(
    `fullPath:\\s*["']${fullPath.replace(/[/$]/g, "\\$&")}["']\\s*preLoaderRoute:\\s*typeof\\s+(\\w+)`,
    "g",
  );
  return [...text.matchAll(block)].map((match) => match[1]!);
}

const OUR_ROUTES = [
  { fullPath: "/inbox", file: "_chat.inbox", importName: "ChatInboxRouteImport" },
  {
    fullPath: "/settings/channels",
    file: "_chat.settings.channels",
    importName: "ChatSettingsChannelsRouteImport",
  },
] as const;

const routeImported = (text: string, route: (typeof OUR_ROUTES)[number]) =>
  new RegExp(
    `import \\{ Route as ${route.importName} \\} from ["']\\./routes/${route.file.replace(/\./g, "\\.")}["']`,
  ).test(text);

const seams: ReadonlyArray<Check> = [
  {
    name: "ForkExtensions.layer is merged into layerMakeRoutes",
    file: "apps/server/src/server.ts",
    ok: (text) =>
      text.includes('import * as ForkExtensions from "./fork/layer.ts"') &&
      between(text, "const layerMakeRoutes = Layer.mergeAll(", "\n);").includes(
        "ForkExtensions.layer",
      ),
    fix: "Add `ForkExtensions.layer` next to `GuestHttp.layer` in the routes Layer.mergeAll.",
  },
  {
    name: "ForkSidebarItems sits in the sidebar footer",
    file: "apps/web/src/components/sidebar/SidebarChrome.tsx",
    ok: (text) =>
      text.includes("<ForkSidebarItems") && text.includes("~/fork/inbox/ForkSidebarItems"),
    fix: "Render `<ForkSidebarItems onNavigate={closeMobileSidebar} />` beside the Pull requests item.",
  },
  {
    name: "settingsSearch spreads the fork's settings tables",
    file: "apps/web/src/components/settings/settingsSearch.ts",
    ok: (text) =>
      ["| ForkSettingsPath", "...FORK_SETTINGS_LABELS", "...FORK_SETTINGS_NAV_PATHS"].every(
        (part) => text.includes(part),
      ) &&
      text.includes("...FORK_SETTINGS_SEARCH_ITEMS") &&
      text.includes("...FORK_SETTINGS_CATEGORY_SCOPES"),
    fix: "Re-add the union member and the four spreads from apps/web/src/fork/registry.ts.",
  },
  {
    name: "SettingsSidebarNav spreads the fork's icons",
    file: "apps/web/src/components/settings/SettingsSidebarNav.tsx",
    ok: (text) => text.includes("...FORK_SETTINGS_ICONS"),
    fix: "Spread `FORK_SETTINGS_ICONS` into SETTINGS_SECTION_ICONS.",
  },
  {
    name: "The /inbox route file renders the inbox",
    file: "apps/web/src/routes/_chat.inbox.tsx",
    ok: (text) => text.includes("../fork/inbox/InboxPage") && quoted("/_chat/inbox").test(text),
    fix: 'Restore the thin route: createFileRoute("/_chat/inbox") with InboxPage.',
  },
  {
    name: "The /settings/channels route file renders the panel",
    file: "apps/web/src/routes/_chat.settings.channels.tsx",
    ok: (text) =>
      text.includes("../fork/channels/ChannelsSettingsPanel") &&
      quoted("/_chat/settings/channels").test(text),
    fix: 'Restore the thin route: createFileRoute("/_chat/settings/channels") with the panel.',
  },
  ...OUR_ROUTES.map((route): Check => ({
    name: `routeTree.gen.ts has the ${route.fullPath} route`,
    file: "apps/web/src/routeTree.gen.ts",
    ok: (text) =>
      routeImported(text, route) &&
      generatedRoutes(text, route.fullPath).includes(route.importName),
    fix: "Run `node scripts/inbox-seam-check.ts regen-route-tree` and commit the result.",
  })),
  {
    name: "package.json keeps the fork:inbox-seam-check script",
    file: "package.json",
    ok: (text) =>
      (JSON.parse(text) as { scripts?: Record<string, string> }).scripts?.[
        "fork:inbox-seam-check"
      ] === "node scripts/inbox-seam-check.ts",
    fix: 'Add "fork:inbox-seam-check": "node scripts/inbox-seam-check.ts" to the root scripts.',
  },
];

const symbols: ReadonlyArray<Check> = [
  {
    name: "ThreadMessageIntake.launchThread",
    file: "apps/server/src/orchestration-v2/ThreadMessageIntake.ts",
    ok: (text) => /export const launchThread\b/.test(text),
    fix: "Delegation launches threads through it (apps/server/src/fork/inbox/operations.ts).",
  },
  {
    name: "authenticateMediaRequest",
    file: "apps/server/src/auth/http.ts",
    ok: (text) => /export const authenticateMediaRequest\b/.test(text),
    fix: "Every /api/fork route authenticates with it (apps/server/src/fork/http.ts).",
  },
  {
    name: 'OrchestrationV2CreationSource still has "server"',
    file: "packages/contracts/src/orchestrationV2.ts",
    ok: (text) =>
      between(text, "export const OrchestrationV2CreationSource", "]);").includes('"server"'),
    fix: 'Delegated threads use creationSource "server"; pick the closest remaining value.',
  },
  {
    name: "resolveDeviceHubAccess",
    file: "packages/client-runtime/src/state/deviceHubAccess.ts",
    ok: (text) => /export const resolveDeviceHubAccess\b/.test(text),
    fix: "apps/web/src/fork/forkApiAccess.ts mints tickets with it; follow its rename there.",
  },
  {
    name: "environmentSession.preparedConnectionValueAtom",
    file: "packages/client-runtime/src/state/session.ts",
    ok: (text) => text.includes("preparedConnectionValueAtom"),
    fix: "apps/web/src/fork/forkApiAccess.ts reads each environment's connection from it.",
  },
  {
    name: "useSettingsScope",
    file: "apps/web/src/components/settings/SettingsScopeContext.tsx",
    ok: (text) => /export function useSettingsScope\b/.test(text),
    fix: "apps/web/src/fork/channels/ChannelsSettingsPanel.tsx picks environments with it.",
  },
  {
    name: "SETTINGS_NAV_GROUPS",
    file: "apps/web/src/components/settings/settingsSearch.ts",
    ok: (text) =>
      /export const SETTINGS_NAV_GROUPS\b/.test(text) && text.includes('heading: "Connections"'),
    fix: "Channels is listed in the Connections group; move the spread with it.",
  },
  {
    name: "ThreadManagementService.streamDomainEvents starts at the latest event",
    file: "apps/server/src/orchestration-v2/Orchestrator.ts",
    ok: (text) =>
      between(text, "streamDomainEvents: Stream.unwrap(", "),").includes("latestSequence()"),
    fix: "apps/server/src/fork/inbox/linkedThreads.ts must not replay history; start it at the latest sequence there.",
  },
  {
    name: "ThreadManagementService exposes streamDomainEvents",
    file: "apps/server/src/orchestration-v2/ThreadManagementService.ts",
    ok: (text) => text.includes("streamDomainEvents: orchestrator.streamDomainEvents"),
    fix: "apps/server/src/fork/layer.ts follows linked threads through it.",
  },
  {
    name: "resolveThreadStatusPill",
    file: "apps/web/src/components/Sidebar.logic.ts",
    ok: (text) => /export function resolveThreadStatusPill\b/.test(text),
    fix: "The inbox's thread card shows the sidebar's status label (apps/web/src/fork/inbox/TopicDetail.tsx).",
  },
  {
    name: "useThreadShell",
    file: "apps/web/src/state/entities.ts",
    ok: (text) => /export function useThreadShell\b/.test(text),
    fix: "The thread card reads the linked thread's live state with it (TopicDetail.tsx).",
  },
  {
    name: "useNowMinute",
    file: "apps/web/src/hooks/useNowMinute.ts",
    ok: (text) => /export function useNowMinute\b/.test(text),
    fix: "Wait labels and the overdue highlight tick with it (InboxList.tsx, InboxPage.tsx).",
  },
  {
    name: "@legendapp/list in the web app",
    file: "apps/web/package.json",
    ok: (text) => text.includes('"@legendapp/list"'),
    fix: "The inbox list is a LegendList (InboxList.tsx); follow the web app's list component.",
  },
  {
    name: "formatRelativeElapsed",
    file: "apps/web/src/timestampFormat.ts",
    ok: (text) => /export function formatRelativeElapsed\b/.test(text),
    fix: "apps/web/src/fork/presentation.tsx formats spans like the sidebar with it.",
  },
  {
    name: "SETTINGS_DEVICE_ONLY_PATHS",
    file: "apps/web/src/components/settings/SettingsScopeSentence.tsx",
    ok: (text) => /export const SETTINGS_DEVICE_ONLY_PATHS\b/.test(text),
    fix: "Channels relies on the scope sentence; check how settings pick environments now.",
  },
];

const claims: ReadonlyArray<Check> = [
  {
    name: "/settings/channels is not device-only upstream",
    file: "apps/web/src/components/settings/SettingsScopeSentence.tsx",
    ok: (text) =>
      !quoted("/settings/channels").test(between(text, "SETTINGS_DEVICE_ONLY_PATHS", "]);")),
    fix: "Upstream made it device-only, which hides the environment picker Channels needs.",
  },
  ...OUR_ROUTES.map((route): Check => ({
    name: `Only the fork's route serves ${route.fullPath}`,
    file: "apps/web/src/routeTree.gen.ts",
    ok: (text) => generatedRoutes(text, route.fullPath).every((name) => name === route.importName),
    fix: `Upstream added its own ${route.fullPath}; move the fork's route to a free path.`,
  })),
];

function routeCollisions(root: string): string[] {
  const found: string[] = [];
  const routes = NodeFS.readdirSync(NodePath.join(root, "apps/web/src/routes"));
  const ours = new Set(["_chat.inbox.tsx", "_chat.settings.channels.tsx"]);
  for (const file of routes) {
    if (ours.has(file)) continue;
    if (/(^|\.)inbox(\.|$)|settings\.channels/.test(file)) {
      found.push(`apps/web/src/routes/${file} also claims /inbox or /settings/channels`);
    }
  }
  const output = NodeChildProcess.spawnSync(
    "git",
    ["grep", "-l", "/api/fork", "--", "apps/server/src", ":!apps/server/src/fork"],
    { cwd: root, encoding: "utf8" },
  );
  for (const file of output.stdout.split("\n").filter(Boolean)) {
    found.push(`${file} mentions /api/fork outside apps/server/src/fork`);
  }
  return found;
}

function runChecks(
  root: string,
  title: string,
  checks: ReadonlyArray<Check>,
  log: (line: string) => void,
): number {
  let failures = 0;
  log(`\n${title}`);
  for (const check of checks) {
    let text: string | null = null;
    try {
      text = NodeFS.readFileSync(NodePath.join(root, check.file), "utf8");
    } catch {
      text = null;
    }
    let ok = false;
    try {
      ok = text !== null && check.ok(text);
    } catch {
      ok = false;
    }
    log(`  ${ok ? "ok  " : "FAIL"} ${check.name}`);
    if (!ok) {
      failures += 1;
      log(`       ${text === null ? "missing file" : "in"} ${check.file}\n       ${check.fix}`);
    }
  }
  return failures;
}

function gitRefExists(root: string, ref: string): boolean {
  return (
    NodeChildProcess.spawnSync("git", ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], {
      cwd: root,
      encoding: "utf8",
    }).status === 0
  );
}

/** Runs every check against `root`; returns the number of problems. */
export function runSeamCheck(
  root: string,
  args: ReadonlyArray<string>,
  log: (line: string) => void = console.log,
): number {
  let failures = runChecks(root, "Seams", seams, log);
  failures += runChecks(root, "Upstream symbols the fork uses", symbols, log);
  failures += runChecks(root, "Paths the fork claims", claims, log);
  const collisions = routeCollisions(root);
  for (const collision of collisions) log(`  FAIL ${collision}`);
  failures += collisions.length;

  const flag = (name: string) => {
    const index = args.indexOf(name);
    return index === -1 ? undefined : (args[index + 1] ?? "");
  };
  const since = flag("--since");
  const to = flag("--to");
  if (since !== undefined || to !== undefined) {
    if (!since || !to) {
      log("\nFAIL Pass both --since <old upstream tag> and --to <new upstream tag>.");
      failures += 1;
    } else {
      const missing = [since, to].filter((ref) => !gitRefExists(root, ref));
      if (missing.length > 0) {
        log(`\nFAIL Unknown git ref: ${missing.join(", ")}.`);
        failures += 1;
      } else {
        const result = NodeChildProcess.spawnSync(
          "git",
          ["log", "--oneline", `${since}..${to}`, "--", ...SEAM_FILES],
          { cwd: root, encoding: "utf8" },
        );
        if (result.status !== 0) {
          log(`\nFAIL git log ${since}..${to} failed: ${result.stderr.trim()}`);
          failures += 1;
        } else {
          log(`\nUpstream changes to seam files in ${since}..${to}:`);
          log(result.stdout.trim() || "  none");
        }
      }
    }
  }
  log(failures === 0 ? "\nAll inbox seams are in place." : `\n${failures} problem(s).`);
  return failures;
}

async function regenerateRouteTree(root: string) {
  const webRequire = NodeModule.createRequire(NodePath.join(root, "apps/web/package.json"));
  const pluginRequire = NodeModule.createRequire(
    webRequire.resolve("@tanstack/router-plugin/package.json"),
  );
  const generator = (await import(
    NodeURL.pathToFileURL(pluginRequire.resolve("@tanstack/router-generator")).href
  )) as {
    getConfig: (input: object, root: string) => { readonly generatedRouteTree: string };
    Generator: new (input: { config: object; root: string }) => { run: () => Promise<void> };
  };
  const webRoot = NodePath.join(root, "apps/web");
  // Same options as the tanstackRouter plugin in apps/web/vite.config.ts.
  const config = generator.getConfig({ autoCodeSplitting: true }, webRoot);
  await new generator.Generator({ config, root: webRoot }).run();
  console.log(`Regenerated ${NodePath.relative(root, config.generatedRouteTree)}.`);
}

async function main() {
  const args = process.argv.slice(2);
  if (args[0] === "regen-route-tree") return regenerateRouteTree(repoRoot);
  process.exitCode = runSeamCheck(repoRoot, args) === 0 ? 0 : 1;
}

if (import.meta.main) await main();
