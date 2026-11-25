/** Where a bot should write down what the user just told it. */
export type Place = "role" | "memory" | "skill";

export interface BotNotebookCase {
  readonly id: string;
  /** Where the case came from. */
  readonly source: string;
  readonly message: string;
  readonly expect: Place;
}

const misfiled =
  "A bot filed the user's standing rules as memory instead of its role (T3 Code thread, 2026-11-27).";

export const botNotebookCases: ReadonlyArray<BotNotebookCase> = [
  {
    id: "rule-never-bare-update",
    source: misfiled,
    message:
      "Remember this: never run a bare `t3 update` on this machine. Always pass T3CODE_RELEASE_BASE_URL=https://github.com/acme/app/releases/download and an explicit version.",
    expect: "role",
  },
  {
    id: "rule-workers-reply-not-write",
    source: misfiled,
    message:
      "When you start worker threads, don't let them write into your notes folder directly, it triggers approvals. Have them put the content in their reply instead.",
    expect: "role",
  },
  {
    id: "rule-ask-before-posting-zh",
    source: misfiled,
    message: "以后往群里发消息之前，都先把草稿给我确认，不要直接发。",
    expect: "role",
  },
  {
    id: "control-fact-default-project",
    source: "Control: a fact the bot should keep in memory.",
    message:
      "FYI, general ops work on this machine goes in the project acme-ops (id 26e07921-2f1e-4466-befa-bb766bae6986, root /home/user/scratch).",
    expect: "memory",
  },
  {
    id: "control-fact-host-baseline",
    source: "Control: a fact the bot should keep in memory.",
    message:
      "For reference: this host has 4 vCPU, 8 GiB RAM plus 4 GiB swap, the data disk is mounted at /data, and only TCP 22 is open to the internet.",
    expect: "memory",
  },
  {
    id: "control-procedure-release",
    source: "Control: a repeatable procedure belongs in a skill.",
    message:
      "Here's how we cut a release, do it this way every time I say ship: bump the version in package.json, tag it vX.Y.Z-r.N, push the tag, then run `gh workflow run release.yml -f tag=<tag>` and watch it until green.",
    expect: "skill",
  },
];
