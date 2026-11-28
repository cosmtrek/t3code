import { File, Paths } from "expo-file-system";

import { writeFileAtomically } from "../lib/atomic-file";

/**
 * The fork's own small device choices (a collapsed group, a bot's draft), in a file of their own
 * so upstream's preferences schema stays untouched. Read once, then served from memory.
 */
const file = () => new File(Paths.document, "fork-preferences.json");
let values: Record<string, unknown> | null = null;
const listeners = new Map<string, Set<() => void>>();

function load(): Record<string, unknown> {
  if (values !== null) return values;
  try {
    const parsed: unknown = file().exists ? JSON.parse(file().textSync()) : {};
    values =
      typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    values = {};
  }
  return values;
}

export function readForkPreference(key: string): unknown {
  return load()[key];
}

export function subscribeForkPreference(key: string, listener: () => void): () => void {
  let subscribers = listeners.get(key);
  if (!subscribers) {
    subscribers = new Set();
    listeners.set(key, subscribers);
  }
  subscribers.add(listener);
  return () => {
    subscribers.delete(listener);
    if (subscribers.size === 0 && listeners.get(key) === subscribers) listeners.delete(key);
  };
}

/** `undefined` removes the key. Writes are best effort: a lost choice is only a choice. */
export function writeForkPreference(key: string, value: unknown): void {
  if (Object.is(readForkPreference(key), value)) return;
  const next = { ...load() };
  if (value === undefined) delete next[key];
  else next[key] = value;
  values = next;
  for (const listener of listeners.get(key) ?? []) listener();
  void writeFileAtomically(file(), JSON.stringify(next)).catch(() => undefined);
}
