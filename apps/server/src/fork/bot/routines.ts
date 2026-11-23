// @effect-diagnostics globalDate:off - Local wall-clock time is the point: routines run at the user's 09:00.
/**
 * When a bot's routines come due. Times are the server's local time, where the user is.
 */
import type { RoutineSchedule } from "./store.ts";

const TIME = /^([01]?\d|2[0-3]):([0-5]\d)$/;
const MIN_MINUTES = 5;

/** The first due time strictly after `from`, or null for a schedule that cannot run. */
export function nextDueAt(schedule: RoutineSchedule, from: Date): Date | null {
  if (schedule.type === "every") {
    return new Date(from.getTime() + Math.max(schedule.minutes, MIN_MINUTES) * 60_000);
  }
  const match = TIME.exec(schedule.time);
  if (!match) return null;
  const days =
    schedule.weekdays && schedule.weekdays.length > 0 ? new Set(schedule.weekdays) : null;
  for (let offset = 0; offset <= 7; offset += 1) {
    const candidate = new Date(from);
    candidate.setDate(candidate.getDate() + offset);
    candidate.setHours(Number(match[1]), Number(match[2]), 0, 0);
    // getDay: Sunday is 0; weekdays here are ISO, Monday 1 through Sunday 7.
    const isoDay = candidate.getDay() === 0 ? 7 : candidate.getDay();
    if (candidate.getTime() > from.getTime() && (days === null || days.has(isoDay))) {
      return candidate;
    }
  }
  return null;
}

/** Reads `--daily 09:00 [--weekdays 1-5]` or `--every 30` (minutes). */
export function parseSchedule(flags: ReadonlyMap<string, string>): RoutineSchedule | string {
  const daily = flags.get("daily");
  const every = flags.get("every");
  if (daily !== undefined) {
    if (!TIME.test(daily)) return "Give --daily a time such as 09:00.";
    const weekdays = flags.get("weekdays");
    if (weekdays === undefined) return { type: "daily", time: daily };
    const days = parseWeekdays(weekdays);
    return days ?? "Give --weekdays as 1-5 or 1,3,5 (Monday is 1).";
  }
  if (every !== undefined) {
    const minutes = Number(every);
    if (!Number.isInteger(minutes) || minutes < MIN_MINUTES) {
      return `Give --every a whole number of minutes, at least ${MIN_MINUTES}.`;
    }
    return { type: "every", minutes };
  }
  return "Say when: --daily 09:00 [--weekdays 1-5], or --every <minutes>.";

  function parseWeekdays(value: string): RoutineSchedule | null {
    const days = new Set<number>();
    for (const part of value.split(",")) {
      const [start, end] = part.split("-").map(Number);
      if (start === undefined || !Number.isInteger(start)) return null;
      for (let day = start; day <= (end ?? start); day += 1) {
        if (day < 1 || day > 7) return null;
        days.add(day);
      }
    }
    return { type: "daily", time: daily!, weekdays: [...days].toSorted((a, b) => a - b) };
  }
}

const DAY_NAMES = ["", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export function describeSchedule(schedule: RoutineSchedule): string {
  if (schedule.type === "every") return `every ${schedule.minutes} min`;
  const days = schedule.weekdays;
  if (!days || days.length === 0 || days.length === 7) return `daily ${schedule.time}`;
  return `${days.map((day) => DAY_NAMES[day]).join(",")} ${schedule.time}`;
}
