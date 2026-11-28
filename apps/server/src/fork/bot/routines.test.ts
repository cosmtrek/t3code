// @effect-diagnostics globalDate:off - Routines run on local wall-clock dates.
// @effect-diagnostics-next-line nodeBuiltinImport:off -- A subprocess isolates the legacy Date oracle's local timezone.
import * as NodeChildProcess from "node:child_process";
import * as DateTime from "effect/DateTime";

import { describe, expect, it } from "@effect/vitest";

import { nextDueAt, parseSchedule } from "./routines.ts";

const daily = (weekdays: string) =>
  parseSchedule(
    new Map([
      ["daily", "09:00"],
      ["weekdays", weekdays],
    ]),
  );

describe("routine schedules", () => {
  it.each([
    ["1-5", [1, 2, 3, 4, 5]],
    ["1,3,5", [1, 3, 5]],
    ["6-7,1", [1, 6, 7]],
  ])("reads --weekdays %s", (value, weekdays) => {
    expect(daily(value)).toEqual({ type: "daily", time: "09:00", weekdays });
  });

  // Each would otherwise come back with no days, which runs every day.
  it.each(["5-1", "1-abc", "1-", "0", "8", "", "1,,2", "1-2-3"])(
    "refuses --weekdays %j",
    (value) => {
      expect(typeof daily(value)).toBe("string");
    },
  );

  it("finds the next weekday across a weekend", () => {
    // Friday 2026-11-27 at 10:00, past Friday's run: the next is Monday.
    const next = nextDueAt(
      { type: "daily", time: "09:00", weekdays: [1, 2, 3, 4, 5] },
      DateTime.makeZonedUnsafe(new Date(2026, 10, 27, 10, 0)),
    );
    expect(next?.pipe(DateTime.formatIso)).toEqual(new Date(2026, 10, 30, 9, 0).toISOString());
  });

  it("runs a one-day routine a week later once today's time has passed", () => {
    // Monday 2026-11-23 at 09:00 exactly: due strictly after, so the next Monday.
    expect(
      nextDueAt(
        { type: "daily", time: "09:00", weekdays: [1] },
        DateTime.makeZonedUnsafe(new Date(2026, 10, 23, 9, 0)),
      )?.pipe(DateTime.formatIso),
    ).toEqual(new Date(2026, 10, 30, 9, 0).toISOString());
  });
});

describe("legacy local calendar compatibility", () => {
  it.each(["America/New_York", "Europe/Berlin"])("matches Date in %s", (timeZone) => {
    const inputs = [
      "2026-03-08T00:00:00",
      "2026-03-08T03:15:00",
      "2026-11-01T00:00:00",
      "2026-11-01T01:45:00-05:00",
      "2026-03-29T00:00:00",
      "2026-03-29T03:15:00",
      "2026-10-25T00:00:00",
      "2026-10-25T02:45:00+01:00",
      "2024-02-28T23:45:00",
      "2024-02-29T23:45:00",
      "2026-04-30T23:45:00",
      "2026-12-31T23:45:00",
      "2026-11-27T10:00:00",
      "2026-11-29T09:00:00",
    ];
    const schedules = [
      { type: "daily", time: "01:30" },
      { type: "daily", time: "02:30" },
      { type: "daily", time: "09:00", weekdays: [1, 2, 3, 4, 5] },
      { type: "daily", time: "09:00", weekdays: [7] },
      { type: "every", minutes: 5 },
      { type: "every", minutes: 30 },
    ] as const;
    const oracle = JSON.parse(
      NodeChildProcess.execFileSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `
      const inputs = ${JSON.stringify(inputs)};
      const schedules = ${JSON.stringify(schedules)};
      const next = (schedule, from) => {
        if (schedule.type === "every") return new Date(from.getTime() + Math.max(schedule.minutes, 5) * 60000);
        const [hour, minute] = schedule.time.split(":").map(Number);
        const days = schedule.weekdays ? new Set(schedule.weekdays) : null;
        for (let offset = 0; offset <= 7; offset++) {
          const candidate = new Date(from);
          candidate.setDate(candidate.getDate() + offset);
          candidate.setHours(hour, minute, 0, 0);
          const day = candidate.getDay() === 0 ? 7 : candidate.getDay();
          if (candidate > from && (days === null || days.has(day))) return candidate;
        }
        return null;
      };
      console.log(JSON.stringify(inputs.flatMap(input => {
        const from = new Date(input);
        return schedules.map(schedule => ({ from: from.toISOString(), next: next(schedule, from)?.toISOString() ?? null }));
      })));
    `,
        ],
        { env: { ...process.env, TZ: timeZone }, encoding: "utf8" },
      ),
    ) as Array<{ from: string; next: string | null }>;
    for (const [index, expected] of oracle.entries()) {
      const schedule = schedules[index % schedules.length]!;
      const from = DateTime.makeZonedUnsafe(expected.from, { timeZone });
      expect(
        nextDueAt(schedule, from)?.pipe(DateTime.formatIso) ?? null,
        JSON.stringify({ timeZone, from: expected.from, schedule }),
      ).toBe(expected.next);
    }
  });
});
