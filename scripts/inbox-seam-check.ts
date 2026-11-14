// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - A plain maintenance script, run by hand after each upstream sync.
/**
 * Checks that the inbox fork still plugs into upstream after a sync. See "Inbox seams" in FORK.md.
 *
 *   node scripts/inbox-seam-check.ts [--since <old tag> --to <new tag>]
 *   node scripts/inbox-seam-check.ts regen-route-tree
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const root = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..");
const read = (file: string) => {
  try {
    return NodeFS.readFileSync(NodePath.join(root, file), "utf8");
  } catch {
    return null;
  }
};

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
      !between(text, "SETTINGS_DEVICE_ONLY_PATHS", "]);").includes('"/settings/channels"'),
    fix: "Upstream made it device-only, which hides the environment picker Channels needs.",
  },
];

function routeCollisions(): string[] {
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

function runChecks(title: string, checks: ReadonlyArray<Check>): number {
  let failures = 0;
  console.log(`\n${title}`);
  for (const check of checks) {
    const text = read(check.file);
    const ok = text !== null && check.ok(text);
    console.log(`  ${ok ? "ok  " : "FAIL"} ${check.name}`);
    if (!ok) {
      failures += 1;
      console.log(
        `       ${text === null ? "missing file" : "in"} ${check.file}\n       ${check.fix}`,
      );
    }
  }
  return failures;
}

async function regenerateRouteTree() {
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
  if (args[0] === "regen-route-tree") return regenerateRouteTree();
  let failures = runChecks("Seams", seams);
  failures += runChecks("Upstream symbols the fork uses", symbols);
  failures += runChecks("Paths the fork claims", claims);
  const collisions = routeCollisions();
  for (const collision of collisions) console.log(`  FAIL ${collision}`);
  failures += collisions.length;

  const since = args[args.indexOf("--since") + 1];
  const to = args.includes("--to") ? args[args.indexOf("--to") + 1] : "HEAD";
  if (args.includes("--since") && since) {
    const log = NodeChildProcess.spawnSync(
      "git",
      ["log", "--oneline", `${since}..${to}`, "--", ...SEAM_FILES],
      { cwd: root, encoding: "utf8" },
    );
    console.log(`\nUpstream changes to seam files in ${since}..${to}:`);
    console.log(log.stdout.trim() || "  none");
  }
  console.log(failures === 0 ? "\nAll inbox seams are in place." : `\n${failures} problem(s).`);
  process.exitCode = failures === 0 ? 0 : 1;
}

await main();
