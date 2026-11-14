// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off globalFetch:off extendsNativeError:off - Runs outside the Effect runtime: adapter sockets, timers, and plain callbacks.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as Schema from "effect/Schema";

export const ChannelKind = Schema.Literals(["http-adapter", "example"]);
export type ChannelKind = typeof ChannelKind.Type;

export const ChannelConfigEntry = Schema.Struct({
  id: Schema.String,
  kind: ChannelKind,
  name: Schema.String,
  baseUrl: Schema.String,
  tokenFile: Schema.String,
  enabled: Schema.Boolean,
});
export type ChannelConfigEntry = typeof ChannelConfigEntry.Type;

export const ChannelsFile = Schema.Struct({
  version: Schema.Literal(1),
  channels: Schema.Array(ChannelConfigEntry),
});
export type ChannelsFile = typeof ChannelsFile.Type;

const decodeChannelsFile = Schema.decodeUnknownExit(ChannelsFile);

const EXAMPLE_CHANNEL_ID = "example";

/** The built-in example channel is listed from the start, switched off. */
const DEFAULT_CHANNELS_FILE: ChannelsFile = {
  version: 1,
  channels: [
    {
      id: EXAMPLE_CHANNEL_ID,
      kind: "example",
      name: "Example channel",
      baseUrl: "",
      tokenFile: "",
      enabled: false,
    },
  ],
};

const CHANNEL_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/;

export class ChannelConfigError extends Error {
  readonly field: "id" | "name" | "baseUrl" | "tokenFile" | undefined;
  constructor(message: string, field?: "id" | "name" | "baseUrl" | "tokenFile") {
    super(message);
    this.field = field;
  }
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "[::1]", "::1", "localhost"]);

/**
 * The browser can edit the address and the token file, so the server would otherwise read any
 * file and send it anywhere. Only loopback adapters are reachable.
 */
export function validateLoopbackBaseUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new ChannelConfigError("Enter a full address, such as http://127.0.0.1:7341.", "baseUrl");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ChannelConfigError("The address must start with http:// or https://.", "baseUrl");
  }
  if (!LOOPBACK_HOSTS.has(url.hostname)) {
    throw new ChannelConfigError(
      "Adapters must listen on this machine: use 127.0.0.1, ::1, or localhost.",
      "baseUrl",
    );
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new ChannelConfigError(
      "The address cannot carry credentials, a query, or a hash.",
      "baseUrl",
    );
  }
  return url.origin + url.pathname.replace(/\/+$/, "");
}

/** `~` expands to the home directory; anything else must already be absolute. */
function resolveTokenFilePath(raw: string, home = NodeOS.homedir()): string {
  const trimmed = raw.trim();
  const expanded =
    trimmed === "~"
      ? home
      : trimmed.startsWith("~/")
        ? NodePath.join(home, trimmed.slice(2))
        : trimmed;
  if (!NodePath.isAbsolute(expanded)) {
    throw new ChannelConfigError(
      "The token file path must be absolute or start with ~/.",
      "tokenFile",
    );
  }
  return NodePath.normalize(expanded);
}

export function validateChannelEntry(entry: ChannelConfigEntry): ChannelConfigEntry {
  if (!CHANNEL_ID_PATTERN.test(entry.id)) {
    throw new ChannelConfigError(
      "Use lowercase letters, digits, and dashes for the id (up to 40 characters).",
      "id",
    );
  }
  const name = entry.name.trim();
  if (name.length === 0 || name.length > 80) {
    throw new ChannelConfigError("Give the channel a name of up to 80 characters.", "name");
  }
  if (entry.kind === "example") return { ...entry, name, baseUrl: "", tokenFile: "" };
  const tokenFile = entry.tokenFile.trim();
  if (tokenFile.length > 0) resolveTokenFilePath(tokenFile);
  return { ...entry, name, baseUrl: validateLoopbackBaseUrl(entry.baseUrl), tokenFile };
}

export async function readChannelsFile(filePath: string): Promise<ChannelsFile> {
  let text: string;
  try {
    text = await NodeFSP.readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return DEFAULT_CHANNELS_FILE;
    throw error;
  }
  const exit = decodeChannelsFile(JSON.parse(text));
  if (exit._tag === "Failure") throw new Error(`${filePath} is not a valid channels file.`);
  return exit.value;
}

/** Only the server writes the file, through a rename so a crash never leaves half of it. */
export async function writeChannelsFile(filePath: string, file: ChannelsFile): Promise<void> {
  await NodeFSP.mkdir(NodePath.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await NodeFSP.writeFile(temporary, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
  await NodeFSP.rename(temporary, filePath);
}

export type TokenReadResult =
  | { readonly ok: true; readonly token: string; readonly warning: string | null }
  | { readonly ok: false; readonly reason: string };

interface CachedToken {
  readonly stamp: string;
  readonly result: TokenReadResult;
}

/** Reads a one-line token file, cached by mtime, size, and mode. The token never leaves the server. */
export function createTokenReader() {
  const cache = new Map<string, CachedToken>();
  return async (raw: string): Promise<TokenReadResult> => {
    if (raw.trim().length === 0) return { ok: false, reason: "No token file is set." };
    let filePath: string;
    try {
      filePath = resolveTokenFilePath(raw);
    } catch (error) {
      return { ok: false, reason: (error as Error).message };
    }
    let stat: import("node:fs").Stats;
    try {
      stat = await NodeFSP.stat(filePath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      return {
        ok: false,
        reason:
          code === "ENOENT"
            ? `${filePath} does not exist.`
            : `${filePath} cannot be read (${code ?? "unknown error"}).`,
      };
    }
    const cached = cache.get(filePath);
    const stamp = `${stat.mtimeMs}:${stat.size}:${stat.mode}`;
    if (cached && cached.stamp === stamp) return cached.result;
    let result: TokenReadResult;
    try {
      const token = (await NodeFSP.readFile(filePath, "utf8")).trim();
      // oxlint-disable-next-line t3code/no-global-process-runtime -- plain helper outside Effect; Windows has no mode bits.
      const loose = process.platform !== "win32" && (stat.mode & 0o077) !== 0;
      result =
        token.length === 0 || token.includes("\n")
          ? { ok: false, reason: `${filePath} must hold the token on one line.` }
          : {
              ok: true,
              token,
              warning: loose
                ? `${filePath} is readable by other users; run chmod 600 on it.`
                : null,
            };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      result = { ok: false, reason: `${filePath} cannot be read (${code ?? "unknown error"}).` };
    }
    cache.set(filePath, { stamp, result });
    return result;
  };
}
