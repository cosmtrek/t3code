/**
 * The bot tool's client: reads the bot's token and the server's current address, then posts the
 * command to the running server. Plain Node builds run it from the written `t3bot.mjs`, single
 * executables through `<t3> __bot-tool`.
 */
type ReadFileSync = (path: string | number, encoding: "utf8") => string;

// Serialized into `t3bot.mjs` with toString(), so it may use only its arguments and globals.
export async function runBotTool(
  botsDir: string,
  stateDir: string,
  argv: ReadonlyArray<string>,
  readFileSync: ReadFileSync,
): Promise<void> {
  const args = [...argv];
  let bot: string | undefined;
  if (args[0] === "--bot") {
    bot = args[1];
    args.splice(0, 2);
  } else if (args[0]?.startsWith("--bot=")) {
    bot = args[0].slice("--bot=".length);
    args.splice(0, 1);
  }
  const fail = (message: string): never => {
    process.stderr.write(`t3bot: ${message}\n`);
    process.exit(1);
  };
  if (!bot) return fail("missing --bot <id>");
  let token: string;
  let origin: string;
  try {
    token = readFileSync(`${botsDir}/${bot}/token`, "utf8").trim();
    origin = JSON.parse(readFileSync(`${stateDir}/server-runtime.json`, "utf8")).origin;
  } catch (error) {
    return fail(`cannot reach the T3 server: ${(error as Error).message}`);
  }
  const stdin = args.includes("-") && !process.stdin.isTTY ? readFileSync(0, "utf8") : "";
  let response: Response;
  try {
    response = await fetch(new URL("/api/fork/bots/tool", origin), {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ bot, argv: args, stdin }),
    });
  } catch (error) {
    return fail(`cannot reach the T3 server: ${(error as Error).message}`);
  }
  const status = response.status;
  const body = (await response
    .json()
    .catch(() => ({ message: `the server answered ${status}` }))) as {
    message?: string;
    output?: unknown;
  };
  if (!response.ok) return fail(body.message ?? `the server answered ${status}`);
  const output = String(body.output ?? "");
  process.stdout.write(output.endsWith("\n") ? output : `${output}\n`);
}
