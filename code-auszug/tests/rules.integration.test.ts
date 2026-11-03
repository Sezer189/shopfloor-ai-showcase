/**
 * Integrationstests für die zeitabhängigen Regeln (Ruhezeit, Rotation, Wochenstunden,
 * Nachtfolge) gegen eine Testkopie der Datenbank. Läuft nur mit TEST_DATABASE_URL
 * (siehe planning.integration.test.ts). Die Tests legen eigene Pläne an und räumen sie
 * wieder weg.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { RULE_DEFAULTS, shiftTimestamps, type ShiftType } from "./domain";
import type { Assignment, Violation } from "./rules-engine";

const testUrl = process.env.TEST_DATABASE_URL;
if (testUrl && /\/shopfloor$/.test(testUrl)) {
  throw new Error("TEST_DATABASE_URL zeigt auf die echte Datenbank - Abbruch.");
}

const addDays = (iso: string, n: number) => {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

describe.skipIf(!testUrl)("Zeitabhängige Regeln (Testkopie)", () => {
  let checkAssignments: typeof import("./rules-engine").checkAssignments;
  let query: typeof import("./db").query;
  let pool: typeof import("./db").pool;
  let monday: string;
  let emp: number;
  let cellId: number;
  const createdPlans: number[] = [];
  const createdShifts: number[] = [];

  const shiftId = async (date: string, type: ShiftType) => {
    const rows = await query<{ id: number }>(`SELECT id FROM shift WHERE date = $1 AND shift_type = $2`, [date, type]);
    return rows[0].id;
  };

  const plan = async (date: string, type: ShiftType, status: "ENTWURF" | "FREIGEGEBEN") => {
    const sid = await shiftId(date, type);
    const [p] = await query<{ id: number }>(
      `INSERT INTO plan (shift_id, version, status, origin) VALUES ($1, 1, $2, 'MANUELL') RETURNING id`,
      [sid, status],
    );
    createdPlans.push(p.id);
    await query(
      `INSERT INTO assignment (plan_id, employee_id, cell_id, machine_id, role_in_shift)
       VALUES ($1, $2, $3, NULL, 'BEDIENER')`,
      [p.id, emp, cellId],
    );
  };

  /** Verstöße der Test-Person gegen genau eine Regel für eine Zielschicht. */
  const violationsFor = async (date: string, type: ShiftType, rule: Violation["rule"]) => {
    const a: Assignment = { employeeId: emp, cellId, machineId: null, roleInShift: "BEDIENER" };
    const r = await checkAssignments(await shiftId(date, type), [a]);
    return r.violations.filter((v) => v.employeeId === emp && v.rule === rule);
  };

  beforeAll(async () => {
    process.env.DATABASE_URL = testUrl;
    ({ query, pool } = await import("./db"));
    ({ checkAssignments } = await import("./rules-engine"));
    // Letzte Woche des Schichtkalenders ohne Pläne
    const [m] = await query<{ date: string }>(
      `SELECT s.date::text AS date FROM shift s
        WHERE s.shift_type = 'FRUEH' AND EXTRACT(DOW FROM s.date) = 1
          AND NOT EXISTS (SELECT 1 FROM plan p WHERE p.shift_id = s.id)
        ORDER BY s.date DESC LIMIT 1`,
    );
    monday = m.date;
    const [c] = await query<{ id: number }>(`SELECT id FROM cell WHERE cell_type = 'PRODUKTION' ORDER BY id LIMIT 1`);
    cellId = c.id;
    const from = addDays(monday, -2);
    const to = addDays(monday, 7);
    const [e] = await query<{ id: number }>(
      `SELECT e.id FROM employee e
        WHERE e.active AND e.employee_type = 'BEDIENER' AND e.contract_end_date IS NULL
          AND NOT EXISTS (SELECT 1 FROM absence a WHERE a.employee_id = e.id AND a.date_from <= $2 AND a.date_to >= $1)
        ORDER BY e.id LIMIT 1`,
      [from, to],
    );
    emp = e.id;
  });

  afterEach(async () => {
    if (createdPlans.length) await query(`DELETE FROM plan WHERE id = ANY($1::int[])`, [createdPlans.splice(0)]);
    if (createdShifts.length) await query(`DELETE FROM shift WHERE id = ANY($1::int[])`, [createdShifts.splice(0)]);
  });

  afterAll(async () => {
    await pool?.end();
  });

  describe("Ruhezeit", () => {
    it("erkennt eine zeitliche Überschneidung (Früh bis 14:15, Spät ab 14:00)", async () => {
      await plan(monday, "SPAET", "ENTWURF");
      const v = await violationsFor(monday, "FRUEH", "RUHEZEIT");
      expect(v.length).toBeGreaterThan(0);
      expect(v[0].severity).toBe("HART");
      expect(v[0].message).toContain("Überschneidung");
    });

    it("erkennt zu kurze Ruhezeit (Spät bis 22:15, Früh ab 06:00)", async () => {
      await plan(monday, "SPAET", "ENTWURF");
      const v = await violationsFor(addDays(monday, 1), "FRUEH", "RUHEZEIT");
      expect(v.length).toBeGreaterThan(0);
      expect(v[0].message).toContain("Ruhezeit zur Nachbarschicht");
    });

    it("lässt 11 Stunden und mehr zu (Früh Montag, Früh Dienstag)", async () => {
      await plan(monday, "FRUEH", "ENTWURF");
      expect(await violationsFor(addDays(monday, 1), "FRUEH", "RUHEZEIT")).toEqual([]);
    });
  });

  describe("Rotation Früh, Nacht, Spät", () => {
    it("verbietet den Rückwärtswechsel Früh auf Spät", async () => {
      await plan(monday, "FRUEH", "ENTWURF");
      const v = await violationsFor(addDays(monday, 1), "SPAET", "ROTATION");
      expect(v.length).toBeGreaterThan(0);
      expect(v[0].message).toContain("Rückwärtswechsel");
    });

    it("erlaubt den Vorwärtsschritt Früh auf Nacht", async () => {
      await plan(monday, "FRUEH", "ENTWURF");
      expect(await violationsFor(addDays(monday, 1), "NACHT", "ROTATION")).toEqual([]);
    });

    it("erlaubt dieselbe Schicht nacheinander", async () => {
      await plan(monday, "SPAET", "ENTWURF");
      expect(await violationsFor(addDays(monday, 1), "SPAET", "ROTATION")).toEqual([]);
    });
  });

  describe("Wochenarbeitszeit (41,25 Stunden)", () => {
    it("erlaubt genau die fünfte Schicht der Woche", async () => {
      for (let i = 0; i < 4; i++) await plan(addDays(monday, i), "FRUEH", "FREIGEGEBEN");
      expect(await violationsFor(addDays(monday, 4), "SPAET", "WOCHENARBEITSZEIT")).toEqual([]);
      expect(RULE_DEFAULTS.MAX_WEEKLY_HOURS).toBe(41.25);
    });

    it("verbietet die sechste Schicht der Woche", async () => {
      for (let i = 0; i < 5; i++) await plan(addDays(monday, i), "FRUEH", "FREIGEGEBEN");
      const v = await violationsFor(addDays(monday, 4), "SPAET", "WOCHENARBEITSZEIT");
      expect(v.length).toBeGreaterThan(0);
      expect(v[0].message).toContain("49.5");
    });

    it("zählt die Sonntag-Nachtschicht zur Woche ab Montag", async () => {
      for (let i = 0; i < 5; i++) await plan(addDays(monday, i), "FRUEH", "FREIGEGEBEN");
      const v = await violationsFor(addDays(monday, -1), "NACHT", "WOCHENARBEITSZEIT");
      expect(v.length).toBeGreaterThan(0);
    });

    it("zählt nur freigegebene Pläne, keine Entwürfe", async () => {
      for (let i = 0; i < 5; i++) await plan(addDays(monday, i), "FRUEH", "ENTWURF");
      expect(await violationsFor(addDays(monday, 4), "SPAET", "WOCHENARBEITSZEIT")).toEqual([]);
    });
  });

  describe("Nachtschichtfolge (höchstens 5 in Folge)", () => {
    it("erlaubt die fünfte Nacht in Folge", async () => {
      for (let i = -1; i <= 2; i++) await plan(addDays(monday, i), "NACHT", "ENTWURF");
      expect(await violationsFor(addDays(monday, 3), "NACHT", "NACHTSCHICHTFOLGE")).toEqual([]);
    });

    it("verbietet die sechste Nacht in Folge", async () => {
      for (let i = -1; i <= 3; i++) await plan(addDays(monday, i), "NACHT", "ENTWURF");
      const friday = addDays(monday, 4);
      const { startsAt, endsAt } = shiftTimestamps(new Date(friday + "T00:00:00Z"), "NACHT");
      const [s] = await query<{ id: number }>(
        `INSERT INTO shift (date, shift_type, starts_at, ends_at) VALUES ($1, 'NACHT', $2, $3) RETURNING id`,
        [friday, startsAt.toISOString(), endsAt.toISOString()],
      );
      createdShifts.push(s.id);
      const v = await violationsFor(friday, "NACHT", "NACHTSCHICHTFOLGE");
      expect(v.length).toBeGreaterThan(0);
      expect(v[0].message).toContain("6. Nachtschicht");
    });
  });
});
