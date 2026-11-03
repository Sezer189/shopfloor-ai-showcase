/**
 * Integrationstests für Regelengine und Planer gegen eine Testkopie der Datenbank.
 * Laufen nur, wenn TEST_DATABASE_URL gesetzt ist (nie gegen die echte Datenbank):
 *
 *   $env:TEST_DATABASE_URL = "postgresql://shopfloor:<passwort>@localhost:5432/shopfloor_test"
 *   npm run test:db
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { RULE_DEFAULTS } from "./domain";

const testUrl = process.env.TEST_DATABASE_URL;
if (testUrl && /\/shopfloor$/.test(testUrl)) {
  throw new Error("TEST_DATABASE_URL zeigt auf die echte Datenbank - Abbruch.");
}

describe.skipIf(!testUrl)("Regelengine und Planer (Testkopie)", () => {
  let checkAssignments: typeof import("./rules-engine").checkAssignments;
  let buildStandardPlan: typeof import("./planner").buildStandardPlan;
  let query: typeof import("./db").query;
  let pool: typeof import("./db").pool;
  let shiftId: number;

  beforeAll(async () => {
    process.env.DATABASE_URL = testUrl;
    ({ query, pool } = await import("./db"));
    ({ checkAssignments } = await import("./rules-engine"));
    ({ buildStandardPlan } = await import("./planner"));
    // Frühschicht ohne Plan in der Nachbarschaft: letzter Montag des Schichtkalenders
    const rows = await query<{ id: number }>(
      `SELECT s.id FROM shift s
        WHERE s.shift_type = 'FRUEH' AND EXTRACT(DOW FROM s.date) = 1
          AND NOT EXISTS (SELECT 1 FROM plan p WHERE p.shift_id = s.id)
        ORDER BY s.date DESC LIMIT 1`,
    );
    shiftId = rows[0].id;
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("meldet eine nicht existierende Schicht als harten Verstoß", async () => {
    const r = await checkAssignments(-1, []);
    expect(r.ok).toBe(false);
    expect(r.violations[0].rule).toBe("VERFUEGBARKEIT");
  });

  it("Planvorschlag ist ohne harte Verstöße und besetzt jede Maschine höchstens einmal", async () => {
    const plan = await buildStandardPlan(shiftId);
    expect(plan.assignments.length).toBeGreaterThan(0);
    expect(plan.check.violations.filter((v) => v.severity === "HART" && v.rule !== "MINDESTBESETZUNG")).toEqual([]);
    const machines = plan.assignments.map((a) => a.machineId).filter((m) => m != null);
    expect(new Set(machines).size).toBe(machines.length);
  });

  it("Planvorschlag setzt niemanden auf mehr Maschinen als erlaubt", async () => {
    const plan = await buildStandardPlan(shiftId);
    const perPerson = new Map<number, number>();
    for (const a of plan.assignments) {
      if (a.machineId != null) perPerson.set(a.employeeId, (perPerson.get(a.employeeId) ?? 0) + 1);
    }
    for (const n of perPerson.values()) expect(n).toBeLessThanOrEqual(RULE_DEFAULTS.MAX_MACHINES_PER_OPERATOR);
  });

  it("alle Strategien liefern einen Vorschlag", async () => {
    for (const s of ["ZUFRIEDENHEIT", "MAX_QUALIFIKATION", "MIN_UEBERSTUNDEN"] as const) {
      const plan = await buildStandardPlan(shiftId, s);
      expect(plan.assignments.length).toBeGreaterThan(0);
    }
  });

  it("schließt ausgeschlossene Personen aus dem Vorschlag aus", async () => {
    const first = await buildStandardPlan(shiftId);
    const excluded = first.assignments.slice(0, 5).map((a) => a.employeeId);
    const second = await buildStandardPlan(shiftId, "ZUFRIEDENHEIT", { excludeEmployeeIds: excluded });
    for (const a of second.assignments) expect(excluded).not.toContain(a.employeeId);
  });

  it("erkennt eine unbekannte Mitarbeiter-ID", async () => {
    const plan = await buildStandardPlan(shiftId);
    const bad = [...plan.assignments, { ...plan.assignments[0], employeeId: -5, machineId: null }];
    const r = await checkAssignments(shiftId, bad);
    expect(r.ok).toBe(false);
    expect(r.violations.some((v) => v.rule === "VERFUEGBARKEIT" && v.employeeId === -5)).toBe(true);
  });

  it("erkennt eine doppelt besetzte Maschine", async () => {
    const plan = await buildStandardPlan(shiftId);
    const withMachine = plan.assignments.find((a) => a.machineId != null)!;
    const other = plan.assignments.find((a) => a.employeeId !== withMachine.employeeId && a.machineId != null)!;
    const dup = [...plan.assignments, { ...other, machineId: withMachine.machineId }];
    const r = await checkAssignments(shiftId, dup);
    expect(r.violations.some((v) => v.rule === "DOPPELBELEGUNG")).toBe(true);
  });

  it("erkennt eine abwesende Person", async () => {
    const plan = await buildStandardPlan(shiftId);
    const victim = plan.assignments[0].employeeId;
    const [{ date }] = await query<{ date: string }>(`SELECT date::text AS date FROM shift WHERE id = $1`, [shiftId]);
    await query(`INSERT INTO absence (employee_id, date_from, date_to, type) VALUES ($1, $2, $2, 'KRANK')`, [victim, date]);
    try {
      const r = await checkAssignments(shiftId, plan.assignments);
      expect(r.violations.some((v) => v.rule === "VERFUEGBARKEIT" && v.employeeId === victim)).toBe(true);
    } finally {
      await query(`DELETE FROM absence WHERE employee_id = $1 AND date_from = $2`, [victim, date]);
    }
  });

  it("verlangt Mindestbesetzung bei leerer Besetzung", async () => {
    const r = await checkAssignments(shiftId, []);
    expect(r.violations.some((v) => v.rule === "MINDESTBESETZUNG")).toBe(true);
  });

  it("ignoriert leere Zellen bei skipUnplannedCells", async () => {
    const r = await checkAssignments(shiftId, [], { skipUnplannedCells: true });
    expect(r.violations.filter((v) => v.rule === "MINDESTBESETZUNG" && v.severity === "HART").length).toBeLessThan(
      (await checkAssignments(shiftId, [])).violations.filter((v) => v.rule === "MINDESTBESETZUNG").length,
    );
  });
});
