import type { Place } from "./cases.ts";

/** Where the bot's commands wrote things down. */
export function placesWritten(output: string): ReadonlySet<Place> {
  const places = new Set<Place>();
  if (/\brole\s+(?:add|edit)\b/.test(output)) places.add("role");
  if (/\bmemory\s+(?:add|edit)\b/.test(output)) places.add("memory");
  if (/SKILL\.md/.test(output)) places.add("skill");
  return places;
}

/** A rule belongs in the role alone; a fact or procedure must not reach the role. */
export function passes(expect: Place, output: string): boolean {
  const places = placesWritten(output);
  if (!places.has(expect)) return false;
  if (expect === "role") return !places.has("memory");
  return !places.has("role");
}
