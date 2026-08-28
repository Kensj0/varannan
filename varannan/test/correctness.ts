/**
 * Korrekthetstester för kärnlogiken. Körs med `node out/bench/correctness.js`.
 * Verifierar särskilt att prestandaoptimeringen av getScheduledParentForDate
 * inte ändrade beteendet.
 */

import { getScheduledParentForDate, getNextOrdinaryHandoff, getCycleLengthDays } from "../lib/custodyCycle";
import { calculateShiftDeltaDays } from "../lib/dayBalance";
import { expandEvents } from "../lib/recurrence";
import { validateCustodyCycleBlocks, blocksFromPattern, CYCLE_PRESET_LIST, generateInviteCode } from "../lib/onboarding";
import { CustodyCycleDoc, EventDoc } from "../types/schema";

const A = "parentA";
const B = "parentB";

let passed = 0;
let failed = 0;

function check(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    console.log(`  ✗ ${label}\n      förväntat: ${JSON.stringify(expected)}\n      fick:      ${JSON.stringify(actual)}`);
  }
}

function ts(d: Date) {
  return { seconds: Math.floor(d.getTime() / 1000), nanoseconds: 0 };
}

/**
 * Bygger en absolut tidpunkt från en väggklocka i Europe/Stockholm.
 *
 * Testerna MÅSTE göra så här. `sthlm(2026, 1, 3, 11, 59)` ger 11:59 i
 * den tidszon där testet råkar köra — vilket är hela buggen vi just
 * fixade. Cykeln är ankrad i sin lagrade tidszon, så testet måste också
 * uttrycka sig i den, annars testar det körmiljön i stället för koden.
 */
function sthlm(year: number, month1: number, day: number, hour = 12, minute = 0): Date {
  const guess = Date.UTC(year, month1 - 1, day, hour, minute);
  const offsetAt = (instant: number) => {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "Europe/Stockholm",
      hour12: false,
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    }).formatToParts(new Date(instant));
    const get = (t: string) => Number(parts.find((p) => p.type === t)!.value);
    return Date.UTC(get("year"), get("month") - 1, get("day"), get("hour") % 24, get("minute"), get("second")) - instant;
  };
  const first = offsetAt(guess);
  let result = guess - first;
  const second = offsetAt(result);
  if (second !== first) result = guess - second;
  return new Date(result);
}

// Cykel: A 2 dagar, B 2 dagar, A 3 dagar, B 2, A 2, B 3 = 14 dagar
// Startar 1 jan 2026 kl 12:00.
const cycle: CustodyCycleDoc = {
  childId: "c1",
  blocks: [
    { parentId: A, days: 2 },
    { parentId: B, days: 2 },
    { parentId: A, days: 3 },
    { parentId: B, days: 2 },
    { parentId: A, days: 2 },
    { parentId: B, days: 3 },
  ],
  cycleStartDate: "2026-01-01",
  switchHour: "12:00",
  timezone: "Europe/Stockholm",
  updatedAt: ts(new Date()),
  updatedBy: "u1",
};

console.log("\n=== Cykelberäkning ===\n");

check("cykellängd är 14 dagar", getCycleLengthDays(cycle), 14);

// Block 1: 1 jan 12:00 – 3 jan 12:00 = A
check("1 jan 13:00 -> A", getScheduledParentForDate(cycle, sthlm(2026, 1, 1, 13)).parentId, A);
check("2 jan 12:00 -> A", getScheduledParentForDate(cycle, sthlm(2026, 1, 2, 12)).parentId, A);
// Block 2: 3 jan 12:00 – 5 jan 12:00 = B
check("3 jan 11:59 -> A (före bytet)", getScheduledParentForDate(cycle, sthlm(2026, 1, 3, 11, 59)).parentId, A);
check("3 jan 12:00 -> B (vid bytet)", getScheduledParentForDate(cycle, sthlm(2026, 1, 3, 12)).parentId, B);
check("4 jan 12:00 -> B", getScheduledParentForDate(cycle, sthlm(2026, 1, 4, 12)).parentId, B);
// Block 3: 5 jan 12:00 – 8 jan 12:00 = A (3 dagar)
check("5 jan 12:00 -> A", getScheduledParentForDate(cycle, sthlm(2026, 1, 5, 12)).parentId, A);
check("7 jan 12:00 -> A", getScheduledParentForDate(cycle, sthlm(2026, 1, 7, 12)).parentId, A);
// Block 6 slutar 15 jan 12:00, då börjar cykeln om
check("15 jan 12:00 -> A (cykeln börjar om)", getScheduledParentForDate(cycle, sthlm(2026, 1, 15, 12)).parentId, A);
check("14 jan 12:00 -> B (sista blocket)", getScheduledParentForDate(cycle, sthlm(2026, 1, 14, 12)).parentId, B);

// Datum FÖRE ankaret — positiv modulo måste hantera detta
check("31 dec 2025 12:00 -> B (bakåt i tiden)", getScheduledParentForDate(cycle, sthlm(2025, 12, 31, 12)).parentId, B);
check("18 dec 2025 12:00 -> A (två cykler bakåt)", getScheduledParentForDate(cycle, sthlm(2025, 12, 18, 12)).parentId, A);

// Långt framåt: 2026-01-01 + 14*100 dagar = samma position i cykeln
// 1400 dagar = exakt 100 cykler. Bygg i Stockholm-tid så sommartid
// hanteras korrekt i stället för att lägga på råa 24h-steg.
const hundredCycles = sthlm(2026, 1, 1 + 14 * 100, 12);
check("100 cykler framåt -> A (samma position)", getScheduledParentForDate(cycle, hundredCycles).parentId, A);

console.log("\n=== Nästa ordinarie byte ===\n");

check(
  "från 1 jan 13:00 -> 3 jan 12:00",
  getNextOrdinaryHandoff(cycle, sthlm(2026, 1, 1, 13)).toISOString(),
  sthlm(2026, 1, 3, 12).toISOString()
);
check(
  "från 5 jan 12:00 -> 8 jan 12:00 (3-dagarsblock)",
  getNextOrdinaryHandoff(cycle, sthlm(2026, 1, 5, 12)).toISOString(),
  sthlm(2026, 1, 8, 12).toISOString()
);

console.log("\n=== Ställningsberäkning ===\n");

// 1–3 jan är A:s enligt cykeln. B tar över 1 jan 12:00 – 2 jan 12:00 (1 dygn).
// A förlorar 1 dag -> delta bort från A = +1
check(
  "B tar 1 dygn av A:s tid -> A förlorar 1 dag",
  calculateShiftDeltaDays(
    cycle,
    { startAt: ts(sthlm(2026, 1, 1, 12)), endAt: ts(sthlm(2026, 1, 2, 12)), takingOverParentId: B },
    A
  ),
  1
);

// A tar över under B:s block (3–5 jan): A vinner 1 dag -> -1
check(
  "A tar 1 dygn av B:s tid -> A vinner 1 dag",
  calculateShiftDeltaDays(
    cycle,
    { startAt: ts(sthlm(2026, 1, 3, 12)), endAt: ts(sthlm(2026, 1, 4, 12)), takingOverParentId: A },
    A
  ),
  -1
);

// B "tar över" sin EGEN tid -> ingen avvikelse
check(
  "B tar över sin egen tid -> 0",
  calculateShiftDeltaDays(
    cycle,
    { startAt: ts(sthlm(2026, 1, 3, 12)), endAt: ts(sthlm(2026, 1, 5, 12)), takingOverParentId: B },
    A
  ),
  0
);

// Halvdag: B tar 1–1.5 jan (12 timmar av A:s tid) -> 0.5
check(
  "halvdagsbyte -> 0.5 dag",
  calculateShiftDeltaDays(
    cycle,
    { startAt: ts(sthlm(2026, 1, 1, 12)), endAt: ts(sthlm(2026, 1, 2, 0)), takingOverParentId: B },
    A
  ),
  0.5
);

// Byte som spänner över flera block: B tar 1–5 jan.
// 1–3 jan är A:s (2 dagar förlorade), 3–5 jan är B:s egna (0) -> 2
check(
  "byte över blockgräns -> 2 dagar",
  calculateShiftDeltaDays(
    cycle,
    { startAt: ts(sthlm(2026, 1, 1, 12)), endAt: ts(sthlm(2026, 1, 5, 12)), takingOverParentId: B },
    A
  ),
  2
);

console.log("\n=== Expansion av återkommande aktiviteter ===\n");

function makeEvent(id: string, start: Date, recurrence?: any): EventDoc {
  return {
    id,
    teamId: "t1",
    childId: "c1",
    title: id,
    startAt: ts(start),
    endAt: ts(new Date(start.getTime() + 3600_000)),
    recurrence,
    createdBy: "u1",
    createdAt: ts(new Date()),
  };
}

const janStart = new Date(2026, 0, 1);
const febStart = new Date(2026, 1, 1);

check(
  "engångsaktivitet inom intervallet -> 1",
  expandEvents([makeEvent("e1", new Date(2026, 0, 15, 13))], janStart, febStart).length,
  1
);
check(
  "engångsaktivitet utanför intervallet -> 0",
  expandEvents([makeEvent("e1", new Date(2026, 2, 15, 13))], janStart, febStart).length,
  0
);

// Daglig från 1 jan, januari har 31 dagar
check(
  "daglig i januari -> 31",
  expandEvents([makeEvent("d1", new Date(2026, 0, 1, 13), { frequency: "daily", interval: 1 })], janStart, febStart).length,
  31
);

// Varannan dag: 1,3,5...31 = 16
check(
  "varannan dag i januari -> 16",
  expandEvents([makeEvent("d2", new Date(2026, 0, 1, 13), { frequency: "daily", interval: 2 })], janStart, febStart).length,
  16
);

// Veckovis från 1 jan (torsdag): 1,8,15,22,29 = 5
check(
  "veckovis i januari -> 5",
  expandEvents([makeEvent("w1", new Date(2026, 0, 1, 13), { frequency: "weekly", interval: 1 })], janStart, febStart).length,
  5
);

// Återkommande som STARTADE före intervallet ska ändå synas
check(
  "daglig startad i dec syns i januari -> 31",
  expandEvents(
    [makeEvent("d3", new Date(2025, 11, 1, 13), { frequency: "daily", interval: 1 })],
    janStart,
    febStart
  ).length,
  31
);

// until-gräns respekteras: daglig från 1 jan till 10 jan
check(
  "daglig med until 10 jan -> 9",
  expandEvents(
    [
      makeEvent("d4", new Date(2026, 0, 1, 13), {
        frequency: "daily",
        interval: 1,
        until: ts(new Date(2026, 0, 10, 13)),
      }),
    ],
    janStart,
    febStart
  ).length,
  9
);

// Första tillfället är inte markerat som "recurring"
const occurrences = expandEvents(
  [makeEvent("w2", new Date(2026, 0, 1, 13), { frequency: "weekly", interval: 1 })],
  janStart,
  febStart
);
check("första tillfället isRecurring=false", occurrences[0].isRecurring, false);
check("andra tillfället isRecurring=true", occurrences[1].isRecurring, true);
check("tillfällen är sorterade", occurrences.every((o, i) => i === 0 || o.startAt >= occurrences[i - 1].startAt), true);
check(
  "occurrenceId är unika",
  new Set(occurrences.map((o) => o.occurrenceId)).size,
  occurrences.length
);

console.log("\n=== Cykelvalidering och mönster ===\n");


check("tom cykel avvisas", validateCustodyCycleBlocks([]) !== null, true);
check(
  "block med 0 dagar avvisas",
  validateCustodyCycleBlocks([{ parentId: A, days: 0 }, { parentId: B, days: 2 }]) !== null,
  true
);
check(
  "cykel med bara en förälder avvisas",
  validateCustodyCycleBlocks([{ parentId: A, days: 2 }, { parentId: A, days: 3 }]) !== null,
  true
);
check(
  "giltig 2-2-3 accepteras",
  validateCustodyCycleBlocks(blocksFromPattern([2, 2, 3, 2, 2, 3], A, B)),
  null
);

// Alla färdiga mönster ska vara jämnt fördelade och delbara med 7,
// annars förskjuts veckodagarna för varje varv.
for (const preset of CYCLE_PRESET_LIST) {
  const blocks = blocksFromPattern(preset.pattern, A, B);
  const total = blocks.reduce((sum, b) => sum + b.days, 0);
  const forA = blocks.filter((b) => b.parentId === A).reduce((sum, b) => sum + b.days, 0);
  check(`preset "${preset.label}": jämn fördelning (${forA}/${total - forA})`, forA * 2, total);
  check(`preset "${preset.label}": delbar med 7 (${total} dagar)`, total % 7, 0);
}

console.log("\n=== Inbjudningskoder ===\n");

const codes = new Set<string>();
for (let i = 0; i < 5000; i++) codes.add(generateInviteCode());
check("5000 koder utan kollision", codes.size, 5000);

const sample = generateInviteCode();
check("format ABCDE-FGHIJ", /^[A-Z2-9]{5}-[A-Z2-9]{5}$/.test(sample), true);
check("inga förväxlingsbara tecken (I, L, O, 0, 1)", /[ILO01]/.test(sample.replace("-", "")), false);

console.log(`\n${"=".repeat(60)}`);
console.log(`  ${passed} godkända, ${failed} misslyckade`);
console.log(`${"=".repeat(60)}\n`);

if (failed > 0) throw new Error(`${failed} test misslyckades`);
