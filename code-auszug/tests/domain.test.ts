import { describe, it, expect } from "vitest";
import {
  workWeekDate,
  shiftTimestamps,
  targetDatesForShiftType,
  conversionCoversShift,
  conversionPhase,
  resolveNavigationTargetMonday,
  FORWARD_ROTATION_ORDER,
  RULE_DEFAULTS,
} from "./domain";

describe("workWeekDate", () => {
  it("zählt die Sonntag-Nachtschicht zur Arbeitswoche ab Montag", () => {
    expect(workWeekDate("2026-10-25", "NACHT")).toBe("2026-10-26");
  });
  it("lässt andere Nachtschichten unverändert", () => {
    expect(workWeekDate("2026-10-27", "NACHT")).toBe("2026-10-27");
  });
  it("lässt Früh und Spät am Sonntag unverändert", () => {
    expect(workWeekDate("2026-10-25", "FRUEH")).toBe("2026-10-25");
    expect(workWeekDate("2026-10-25", "SPAET")).toBe("2026-10-25");
  });
});

describe("shiftTimestamps", () => {
  const day = new Date("2026-10-26T00:00:00Z");
  it("Frühschicht dauert 8:15 Stunden ab 06:00", () => {
    const { startsAt, endsAt } = shiftTimestamps(day, "FRUEH");
    expect(startsAt.toISOString()).toBe("2026-10-26T06:00:00.000Z");
    expect(endsAt.toISOString()).toBe("2026-10-26T14:15:00.000Z");
  });
  it("Nachtschicht endet am Folgetag um 06:15", () => {
    const { startsAt, endsAt } = shiftTimestamps(day, "NACHT");
    expect(startsAt.toISOString()).toBe("2026-10-26T22:00:00.000Z");
    expect(endsAt.toISOString()).toBe("2026-10-27T06:15:00.000Z");
  });
  it("verändert das übergebene Datum nicht", () => {
    shiftTimestamps(day, "SPAET");
    expect(day.toISOString()).toBe("2026-10-26T00:00:00.000Z");
  });
});

describe("targetDatesForShiftType", () => {
  const monday = new Date("2026-10-26T00:00:00Z");
  it("Früh und Spät laufen Montag bis Freitag", () => {
    const dates = targetDatesForShiftType(monday, "FRUEH");
    expect(dates).toEqual(["2026-10-26", "2026-10-27", "2026-10-28", "2026-10-29", "2026-10-30"]);
    expect(targetDatesForShiftType(monday, "SPAET")).toEqual(dates);
  });
  it("Nacht läuft Sonntag bis Donnerstag (5 Nächte)", () => {
    expect(targetDatesForShiftType(monday, "NACHT")).toEqual([
      "2026-10-25",
      "2026-10-26",
      "2026-10-27",
      "2026-10-28",
      "2026-10-29",
    ]);
  });
});

describe("conversionCoversShift", () => {
  const frueh = {
    date: "2026-10-26",
    startsAt: new Date("2026-10-26T06:00:00Z"),
    endsAt: new Date("2026-10-26T14:15:00Z"),
  };
  it("ganztägiger Umbau deckt die Schicht am Datum ab", () => {
    const c = { startsAt: "2026-10-26", endsAt: "2026-10-27", startTime: null, endTime: null };
    expect(conversionCoversShift(c, frueh)).toBe(true);
  });
  it("ganztägiger Umbau deckt andere Tage nicht ab", () => {
    const c = { startsAt: "2026-10-27", endsAt: "2026-10-28", startTime: null, endTime: null };
    expect(conversionCoversShift(c, frueh)).toBe(false);
  });
  it("Umbau mit Uhrzeit über die ganze Schicht deckt sie ab", () => {
    const c = { startsAt: "2026-10-26", endsAt: "2026-10-26", startTime: "05:00", endTime: "15:00" };
    expect(conversionCoversShift(c, frueh)).toBe(true);
  });
  it("Umbau nur mitten in der Schicht lässt die Maschine besetzt", () => {
    const c = { startsAt: "2026-10-26", endsAt: "2026-10-26", startTime: "09:00", endTime: "11:00" };
    expect(conversionCoversShift(c, frueh)).toBe(false);
  });
});

describe("conversionPhase", () => {
  it("unterscheidet Geplant, Aktiv und Abgeschlossen", () => {
    expect(conversionPhase("2026-11-01", "2026-11-02", "2026-10-26").label).toBe("Geplant");
    expect(conversionPhase("2026-10-26", "2026-10-27", "2026-10-26").label).toBe("Aktiv");
    expect(conversionPhase("2026-10-20", "2026-10-21", "2026-10-26").label).toBe("Abgeschlossen");
  });
});

describe("resolveNavigationTargetMonday", () => {
  const today = new Date("2026-10-28T12:00:00Z"); // Mittwoch, KW 44
  it("relativ: diese, nächste und letzte Woche", () => {
    expect(resolveNavigationTargetMonday("RELATIV", null, 0, today)).toBe("2026-10-26");
    expect(resolveNavigationTargetMonday("RELATIV", null, 1, today)).toBe("2026-11-02");
    expect(resolveNavigationTargetMonday("RELATIV", null, -1, today)).toBe("2026-10-19");
  });
  it("KW 44 ergibt den Montag 26.10.2026", () => {
    expect(resolveNavigationTargetMonday("KW", 44, null, today)).toBe("2026-10-26");
  });
  it("KW 3 im Oktober wird als nächstes Jahr gedeutet", () => {
    expect(resolveNavigationTargetMonday("KW", 3, null, today)).toBe("2027-01-18");
  });
});

describe("Konstanten", () => {
  it("Schichtfolge ist Früh, Nacht, Spät", () => {
    expect(FORWARD_ROTATION_ORDER).toEqual(["FRUEH", "NACHT", "SPAET"]);
  });
  it("Wochenarbeitszeit entspricht 5 Schichten à 8,25 Stunden", () => {
    expect(RULE_DEFAULTS.MAX_WEEKLY_HOURS).toBe(5 * 8.25);
  });
});
