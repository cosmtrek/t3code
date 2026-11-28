// @effect-diagnostics-next-line nodeBuiltinImport:off - Token cache stamps require fractional mtimeMs, which FileSystem.FileInfo does not expose.
import * as NodeFSP from "node:fs/promises";
// @effect-diagnostics-next-line nodeBuiltinImport:off - Synchronous address validation retains the host's native path syntax.
import * as NodePath from "node:path";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";
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

const parseJson = (text: string): unknown => JSON.parse(text);
const encodeFile = (file: ChannelsFile) => `${JSON.stringify(file, null, 2)}\n`;
const decodeChannelsFile = Schema.decodeUnknownExit(ChannelsFile);

const EXAMPLE_CHANNEL: ChannelConfigEntry = {
  id: "example",
  kind: "example",
  name: "Example channel",
  baseUrl: "",
  tokenFile: "",
  enabled: false,
};

/** The example channel is built in: listed from the start, switched off, and never removed. */
const DEFAULT_CHANNELS_FILE: ChannelsFile = { version: 1, channels: [EXAMPLE_CHANNEL] };

const CHANNEL_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/;

export class ChannelFileError extends Schema.TaggedError<ChannelFileError>()("ChannelFileError", {
  message: Schema.String,
  cause: Schema.Defect(),
}) {}

const isChannelFileError = Schema.is(ChannelFileError);

export class ChannelConfigError extends Schema.TaggedError<ChannelConfigError>()(
  "ChannelConfigError",
  {
    message: Schema.String,
    field: Schema.optional(Schema.Literals(["id", "name", "baseUrl", "tokenFile"])),
  },
) {}

export const isChannelConfigError = Schema.is(ChannelConfigError);

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
    throw new ChannelConfigError({
      message: "Enter a full address, such as http://127.0.0.1:7341.",
      field: "baseUrl",
    });
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ChannelConfigError({
      message: "The address must start with http:// or https://.",
      field: "baseUrl",
    });
  }
  if (!LOOPBACK_HOSTS.has(url.hostname)) {
    throw new ChannelConfigError({
      message: "Adapters must listen on this machine: use 127.0.0.1, ::1, or localhost.",
      field: "baseUrl",
    });
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new ChannelConfigError({
      message: "The address cannot carry credentials, a query, or a hash.",
      field: "baseUrl",
    });
  }
  return url.origin + url.pathname.replace(/\/+$/, "");
}

/**
 * The base every request goes to. `localhost` becomes 127.0.0.1 so a resolver that maps it
 * elsewhere never receives the token.
 */
export function resolveLoopbackBase(raw: string): string {
  const url = new URL(validateLoopbackBaseUrl(raw));
  if (url.hostname === "localhost") url.hostname = "127.0.0.1";
  return url.origin + url.pathname.replace(/\/+$/, "");
}

/** `~` expands to the home directory; anything else must already be absolute. */
function resolveTokenFilePath(raw: string, home: string): string {
  const trimmed = raw.trim();
  const expanded =
    trimmed === "~"
      ? home
      : trimmed.startsWith("~/")
        ? NodePath.join(home, trimmed.slice(2))
        : trimmed;
  if (!NodePath.isAbsolute(expanded)) {
    throw new ChannelConfigError({
      message: "The token file path must be absolute or start with ~/.",
      field: "tokenFile",
    });
  }
  return NodePath.normalize(expanded);
}

/** The adapter's address and token file, checked as a channel's would be. */
export function validateAdapterAddress(draft: {
  readonly baseUrl: string;
  readonly tokenFile: string;
}): { readonly baseUrl: string; readonly tokenFile: string } {
  const tokenFile = draft.tokenFile.trim();
  if (tokenFile.length > 0 && tokenFile !== "~" && !tokenFile.startsWith("~/"))
    resolveTokenFilePath(tokenFile, "");
  return { baseUrl: validateLoopbackBaseUrl(draft.baseUrl), tokenFile };
}

/** An id from the name, unique among `taken`; a name with no latin letters becomes "channel". */
export function channelIdFor(name: string, taken: ReadonlySet<string>): string {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 32)
      .replace(/-+$/, "") || "channel";
  if (!taken.has(base)) return base;
  for (let suffix = 2; ; suffix += 1) {
    const id = `${base}-${suffix}`;
    if (!taken.has(id)) return id;
  }
}

export function validateChannelEntry(entry: ChannelConfigEntry): ChannelConfigEntry {
  if (!CHANNEL_ID_PATTERN.test(entry.id)) {
    throw new ChannelConfigError({
      message: "Use lowercase letters, digits, and dashes for the id (up to 40 characters).",
      field: "id",
    });
  }
  const name = entry.name.trim();
  if (name.length === 0 || name.length > 80) {
    throw new ChannelConfigError({
      message: "Give the channel a name of up to 80 characters.",
      field: "name",
    });
  }
  if (entry.kind === "example") return { ...entry, name, baseUrl: "", tokenFile: "" };
  return { ...entry, name, ...validateAdapterAddress(entry) };
}

const fileError = (error: PlatformError.PlatformError) =>
  new ChannelFileError({
    message: error.cause instanceof Error ? error.cause.message : error.message,
    cause: error,
  });

export const readChannelsFile = Effect.fn("ChannelConfig.read")(function* (filePath: string) {
  const fs = yield* FileSystem.FileSystem;
  const text = yield* fs.readFileString(filePath).pipe(
    Effect.catchIf(
      (error) => error.reason._tag === "NotFound",
      () => Effect.succeed(null),
    ),
    Effect.mapError(fileError),
  );
  if (text === null) return DEFAULT_CHANNELS_FILE;
  return yield* Effect.try({
    try: () => {
      const exit = decodeChannelsFile(parseJson(text));
      if (exit._tag === "Failure")
        throw new ChannelFileError({
          message: `${filePath} is not a valid channels file.`,
          cause: exit,
        });
      for (const entry of exit.value.channels) {
        try {
          validateChannelEntry(entry);
        } catch (error) {
          throw new ChannelFileError({
            message: `${filePath}: channel "${entry.id}": ${(error as Error).message}`,
            cause: error,
          });
        }
      }
      if (exit.value.channels.some((entry) => entry.kind === "example")) return exit.value;
      const taken = new Set(exit.value.channels.map((entry) => entry.id));
      return {
        ...exit.value,
        channels: [
          { ...EXAMPLE_CHANNEL, id: channelIdFor(EXAMPLE_CHANNEL.id, taken) },
          ...exit.value.channels,
        ],
      };
    },
    catch: (cause) =>
      isChannelFileError(cause)
        ? cause
        : new ChannelFileError({
            message: cause instanceof Error ? cause.message : String(cause),
            cause,
          }),
  });
});

export const writeChannelsFile = Effect.fn("ChannelConfig.write")(function* (
  filePath: string,
  file: ChannelsFile,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const now = yield* Clock.currentTimeMillis;
  yield* fs.makeDirectory(path.dirname(filePath), { recursive: true });
  const pid = yield* Effect.sync(() => process.pid);
  const temporary = `${filePath}.${pid}.${now}.tmp`;
  // Cancellation must not leave a partial replacement or a temporary file behind.
  yield* Effect.uninterruptibleMask((restore) =>
    restore(fs.writeFileString(temporary, encodeFile(file), { mode: 0o600 })).pipe(
      Effect.andThen(fs.rename(temporary, filePath)),
      Effect.ensuring(fs.remove(temporary, { force: true }).pipe(Effect.ignore)),
    ),
  );
}, Effect.mapError(fileError));

export type TokenReadResult =
  | { readonly ok: true; readonly token: string; readonly warning: string | null }
  | { readonly ok: false; readonly reason: string };

interface CachedToken {
  readonly stamp: string;
  readonly result: TokenReadResult;
}

/** Reads a one-line token file, cached by mtime, size, and mode. */
export const createTokenReader = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const home = yield* HostProcess.HomeDirectory;
  const platform = yield* HostProcess.Platform;
  const cache = new Map<string, CachedToken>();
  return Effect.fn("ChannelConfig.readToken")(function* (
    raw: string,
  ): Effect.fn.Return<TokenReadResult> {
    if (raw.trim().length === 0) return { ok: false, reason: "No token file is set." };
    const resolved = yield* Effect.try({
      try: () => resolveTokenFilePath(raw, home),
      catch: (error) => error as ChannelConfigError,
    }).pipe(Effect.result);
    if (resolved._tag === "Failure")
      return { ok: false, reason: (resolved.failure as Error).message };
    const filePath = resolved.success;
    const unreadable = (error: PlatformError.PlatformError | ChannelFileError) => {
      const cause = error.cause as { code?: string } | undefined;
      return `${filePath} cannot be read (${cause?.code ?? "unknown error"}).`;
    };
    const statResult = yield* Effect.tryPromise({
      try: () => NodeFSP.stat(filePath),
      catch: (cause) =>
        new ChannelFileError({ message: "The token file could not be inspected.", cause }),
    }).pipe(Effect.result);
    if (statResult._tag === "Failure")
      return {
        ok: false,
        reason:
          (statResult.failure.cause as NodeJS.ErrnoException).code === "ENOENT"
            ? `${filePath} does not exist.`
            : unreadable(statResult.failure),
      };
    const stat = statResult.success;
    const stamp = `${stat.mtimeMs}:${stat.size}:${stat.mode}`;
    const cached = cache.get(filePath);
    if (cached?.stamp === stamp) return cached.result;
    const read = yield* fs.readFileString(filePath).pipe(Effect.result);
    let result: TokenReadResult;
    if (read._tag === "Failure") result = { ok: false, reason: unreadable(read.failure) };
    else {
      const token = read.success.trim();
      const loose = platform !== "win32" && (stat.mode & 0o077) !== 0;
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
    }
    cache.set(filePath, { stamp, result });
    return result;
  });
});
