// @effect-diagnostics globalDate:off - Routines run on local wall-clock dates.
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
      new Date(2026, 10, 27, 10, 0),
    );
    expect(next).toEqual(new Date(2026, 10, 30, 9, 0));
  });

  it("runs a one-day routine a week later once today's time has passed", () => {
    // Monday 2026-11-23 at 09:00 exactly: due strictly after, so the next Monday.
    expect(
      nextDueAt({ type: "daily", time: "09:00", weekdays: [1] }, new Date(2026, 10, 23, 9, 0)),
    ).toEqual(new Date(2026, 10, 30, 9, 0));
  });
});
