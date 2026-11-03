# Code-Auszug: Regelprüfung

Kleine Ausschnitte aus der Anwendung, damit der Stil und die Arbeitsweise erkennbar sind. Der vollständige Quellcode ist privat. Alle Rechte vorbehalten, siehe [LICENSE.md](../LICENSE.md).

Die Regelprüfung ist **deterministischer Code** und hängt von keinem Sprachmodell ab. Sie liefert zu jedem Verstoß einen Klartext-Grund, den die Oberfläche unverändert anzeigt.

## Schichtmodell und Arbeitswoche (domain.ts)

```ts
/** Die drei Schichten des Regelbetriebs Mo–Fr. */
export const WEEKDAY_SHIFTS: ShiftType[] = ["FRUEH", "SPAET", "NACHT"];

/**
 * Schichtfolge des Betriebs: Früh → Nacht → Spät → (wieder Früh). Ein Wechsel ist nur auf
 * die jeweils nächste Schicht dieser Folge (oder dieselbe Schicht) erlaubt; alles andere
 * - Nacht→Früh, Spät→Nacht, Früh→Spät - ist laut Vorgabe zwingend verboten, siehe
 * ROTATION-Regel in rules-engine.ts. Die Mindestruhezeit von 11 Stunden gilt zusätzlich.
 */
export const FORWARD_ROTATION_ORDER: ShiftType[] = ["FRUEH", "NACHT", "SPAET"];

/**
 * Arbeitswoche einer Schicht (Datum, das für die Wochenstunden zählt): Die Nachtschicht
 * beginnt Sonntag 22:00 und gehört zur Arbeitswoche, die am Montag beginnt (Nacht So–Do).
 * Alle anderen Schichten zählen zu ihrem Kalendertag.
 */
export function workWeekDate(dateIso: string, shiftType: string): string {
  if (shiftType !== "NACHT") return dateIso;
  const d = new Date(dateIso + "T00:00:00Z");
  if (d.getUTCDay() !== 0) return dateIso;
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}
```

## Regelparameter (domain.ts)

```ts
export const RULE_DEFAULTS = {
  /** ArbZG § 5: 11 Stunden ununterbrochene Ruhezeit zwischen zwei Schichten */
  MIN_REST_HOURS: 11,
  /** ArbZG § 3: regulaer 8 Stunden werktaeglich */
  MAX_DAILY_HOURS_REGULAR: 8,
  /** ArbZG § 3: bis 10 Stunden zulaessig, nur mit Ausgleich innerhalb 24 Wochen */
  MAX_DAILY_HOURS_EXCEPTION: 10,
  /**
   * Vertragliche Wochenregelarbeitszeit. 41,25 statt 40 Stunden, weil jede
   * der bis zu 5 Wochenschichten durch die 15-Minuten-Uebergabe 8:15 statt
   * 8:00 Std. dauert (5 x 0,25 Std. = 1,25 Std.) - sonst wuerde die normale
   * Vollzeit-Wochenplanung faelschlich als Regelverstoss gemeldet.
   */
  MAX_WEEKLY_HOURS: 41.25,
  /** Betriebsvereinbarung: maximal 5 Nachtschichten in Folge */
  MAX_CONSECUTIVE_NIGHT_SHIFTS: 5,
  /** Mehrmaschinenbedienung: maximal 2 Maschinen je Bediener */
  MAX_MACHINES_PER_OPERATOR: 2,
  /** Maschinenfreigabe existiert ab Skill-Level 2 fuer den Maschinentyp */
  MIN_LEVEL_FOR_MACHINE_RELEASE: 2,
  /** Je Produktionszelle und Schicht mindestens ein Level-3-Einrichter */
  MIN_LEVEL3_PER_PRODUCTION_CELL: 1,
  /** Je Produktionszelle und Schicht genau ein Zellenverantwortlicher */
  CELL_LEADS_PER_PRODUCTION_CELL: 1,
  /** Sollbesetzung Materialbereitstellung (Zelle 2) je Schicht, zusaetzlich zur Produktion */
  TARGET_HEADCOUNT_MATERIAL_CELL: 2,
  /** Vorgabe des Auftraggebers fuer die Produktion unter Volllast */
  TARGET_HEADCOUNT_PRODUCTION: 25,
  /** Wochenendarbeit (Samstag/Sonntag, alle 3 Schichten) generell an (1) oder aus (0) - betriebsweite Einstellung */
  WOCHENENDARBEIT_AKTIV: 0,
} as const;
```

## Ruhezeit, Überschneidung und Schichtfolge (ules-engine.ts)

Prüft für jede geplante Person die Nachbarschichten: zeitliche Überschneidung, 11 Stunden Mindestruhezeit und die erlaubte Vorwärtsrotation Früh, Nacht, Spät.

```ts
    for (const a of assignments) {
      const others = adjacentShifts.filter((o) => o.employee_id === a.employeeId);
      for (const other of others) {
        const otherStart = new Date(other.starts_at);
        const otherEnd = new Date(other.ends_at);
        // Echte zeitliche Überschneidung (z. B. Frühschicht endet 14:15, Spätschicht
        // beginnt 14:00) ist der schwerste Fall - schwerer als "zu wenig Ruhezeit" -
        // und muss unabhängig von der Ruhezeit-Rechnung erkannt werden. Sonst liefert
        // restBeforeHours/restAfterHours zwei negative Werte, die fälschlich als
        // "keine Ruhezeit-Prüfung nötig" durchgehen (siehe relevantRest >= 0 unten).
        const overlaps = shift.startsAt.getTime() < otherEnd.getTime() && otherStart.getTime() < shift.endsAt.getTime();
        if (overlaps) {
          violations.push({
            rule: "RUHEZEIT",
            severity: "HART",
            message: `${other.name}: ist zeitgleich bereits in einer anderen Schicht eingeplant (Überschneidung) — keine gleichzeitige Zuweisung möglich.`,
            employeeId: a.employeeId,
          });
          continue;
        }
        const restBeforeHours = (shift.startsAt.getTime() - otherEnd.getTime()) / 3_600_000;
        const restAfterHours = (otherStart.getTime() - shift.endsAt.getTime()) / 3_600_000;
        const relevantRest = restBeforeHours >= 0 ? restBeforeHours : restAfterHours;
        if (relevantRest >= 0 && relevantRest < RULE_DEFAULTS.MIN_REST_HOURS) {
          violations.push({
            rule: "RUHEZEIT",
            severity: "HART",
            message: `${other.name}: nur ${relevantRest.toFixed(1)} Stunden Ruhezeit zur Nachbarschicht — Mindestruhezeit beträgt ${RULE_DEFAULTS.MIN_REST_HOURS} Stunden (ArbZG § 5).`,
            employeeId: a.employeeId,
          });
        }
      }

      // Vorwärtsrotation: die zeitlich naechste VORHERGEHENDE Schicht (falls
      // vorhanden) bestimmt, welcher Schichttyp als naechstes erlaubt ist.
      // Erlaubt: derselbe Typ (Block von 2-3 gleichen Schichten) oder genau
      // ein Schritt in FORWARD_ROTATION_ORDER. Alles andere (z.B. Nacht auf
      // Spaet, Spaet auf Frueh) ist ein verbotener Rueckwaertswechsel.
      const previous = others
        .filter((o) => shift.startsAt.getTime() - new Date(o.ends_at).getTime() >= 0)
        .sort((x, y) => new Date(y.ends_at).getTime() - new Date(x.ends_at).getTime())[0];
      if (previous && WEEKDAY_SHIFTS.includes(previous.shift_type as ShiftType) && WEEKDAY_SHIFTS.includes(shift.shiftType as ShiftType)) {
        const prevIdx = FORWARD_ROTATION_ORDER.indexOf(previous.shift_type as ShiftType);
        const curIdx = FORWARD_ROTATION_ORDER.indexOf(shift.shiftType as ShiftType);
        const isSame = prevIdx === curIdx;
        const isForwardStep = curIdx === (prevIdx + 1) % FORWARD_ROTATION_ORDER.length;
        if (!isSame && !isForwardStep) {
          violations.push({
            rule: "ROTATION",
            severity: "HART",
            message: `${previous.name}: Wechsel von ${previous.shift_type} auf ${shift.shiftType} ist ein Rückwärtswechsel — erlaubt ist nur die Vorwärtsrotation ${FORWARD_ROTATION_ORDER.join(" → ")} → ${FORWARD_ROTATION_ORDER[0]}.`,
            employeeId: a.employeeId,
          });
        }
      }
    }
  }
```

## Tests

Im Ordner [tests](tests) liegen die automatischen Tests:

- `domain.test.ts`: Unit-Tests für Schichtzeiten, Arbeitswoche, Umbau-Fenster und Navigation (laufen immer).
- `planning.integration.test.ts` und `rules.integration.test.ts`: Tests der Regelengine und des Planers gegen eine Kopie der Datenbank (Ruhezeit, Rotation, Wochenstunden, Nachtfolge). Sie laufen nur mit gesetzter `TEST_DATABASE_URL` und nie gegen die echte Datenbank.