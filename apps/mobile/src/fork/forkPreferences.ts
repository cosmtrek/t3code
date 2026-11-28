import { File, Paths } from "expo-file-system";

import { writeFileAtomically } from "../lib/atomic-file";

/**
 * The fork's own small device choices (a collapsed group, a bot's draft), in a file of their own
 * so upstream's preferences schema stays untouched. Read once, then served from memory.
 */
const file = () => new File(Paths.document, "fork-preferences.json");
let values: Record<string, unknown> | null = null;

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

/** `undefined` removes the key. Writes are best effort: a lost choice is only a choice. */
export function writeForkPreference(key: string, value: unknown): void {
  const next = { ...load() };
  if (value === undefined) delete next[key];
  else next[key] = value;
  values = next;
  void writeFileAtomically(file(), JSON.stringify(next)).catch(() => undefined);
}
