import { beforeEach, expect, it, vi } from "vite-plus/test";

const disk = vi.hoisted(() => ({ text: "{}" }));
vi.mock("expo-file-system", () => ({
  Paths: { document: "documents" },
  File: class {
    exists = true;
    textSync() {
      return disk.text;
    }
  },
}));
vi.mock("../lib/atomic-file", () => ({ writeFileAtomically: vi.fn(async () => {}) }));

beforeEach(() => {
  vi.resetModules();
  disk.text = '{"botsGroupCollapsed":true}';
});

it("shares persisted choices and updates between two Home subscribers, including removal", async () => {
  const { readForkPreference, subscribeForkPreference, writeForkPreference } =
    await import("./forkPreferences");
  const first: unknown[] = [];
  const second: unknown[] = [];
  const key = "botsGroupCollapsed";
  expect(readForkPreference(key)).toBe(true);
  const stopFirst = subscribeForkPreference(key, () => first.push(readForkPreference(key)));
  const stopSecond = subscribeForkPreference(key, () => second.push(readForkPreference(key)));
  try {
    writeForkPreference("botDraft", "draft");
    expect(first).toEqual([]);
    expect(second).toEqual([]);
    writeForkPreference(key, false);
    writeForkPreference(key, false);
    expect(first).toEqual([false]);
    expect(second).toEqual([false]);
    stopFirst();
    writeForkPreference(key, true);
    writeForkPreference(key, undefined);
    expect(first).toEqual([false]);
    expect(second).toEqual([false, true, undefined]);
    expect(readForkPreference(key)).toBeUndefined();
  } finally {
    stopFirst();
    stopSecond();
  }
  const remounted = vi.fn();
  const stopRemounted = subscribeForkPreference(key, remounted);
  try {
    stopFirst();
    writeForkPreference(key, true);
    expect(remounted).toHaveBeenCalledOnce();
  } finally {
    stopRemounted();
  }
});

it("keeps in-memory state and notifies subscribers when persistence fails", async () => {
  const { writeFileAtomically } = await import("../lib/atomic-file");
  vi.mocked(writeFileAtomically).mockRejectedValueOnce(new Error("disk full"));
  const { readForkPreference, subscribeForkPreference, writeForkPreference } =
    await import("./forkPreferences");
  const listener = vi.fn();
  const stop = subscribeForkPreference("botsGroupCollapsed", listener);
  try {
    writeForkPreference("botsGroupCollapsed", false);
    expect(readForkPreference("botsGroupCollapsed")).toBe(false);
    expect(listener).toHaveBeenCalledOnce();
    await expect(vi.mocked(writeFileAtomically).mock.results.at(-1)?.value).rejects.toThrow(
      "disk full",
    );
  } finally {
    stop();
  }
});
