/**
 * Benchmark av Varannans rena beräkningslogik.
 * Mäter de vägar som körs vid varje render av kalendern.
 */

import { getScheduledParentForDate, getNextOrdinaryHandoff, getCycleLengthDays } from "../lib/custodyCycle";
import { calculateShiftDeltaDays } from "../lib/dayBalance";
import { expandEvents } from "../lib/recurrence";
import { CustodyCycleDoc, EventDoc } from "../types/schema";

const A = "parentA";
const B = "parentB";

function ts(d: Date) {
  return { seconds: Math.floor(d.getTime() / 1000), nanoseconds: 0 };
}

const cycle223: CustodyCycleDoc = {
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

function bench(label: string, iterations: number, fn: () => void) {
  // Uppvärmning så JIT:en inte mäts in.
  for (let i = 0; i < Math.min(1000, iterations); i++) fn();

  const start = process.hrtime.bigint();
  for (let i = 0; i < iterations; i++) fn();
  const end = process.hrtime.bigint();

  const totalMs = Number(end - start) / 1e6;
  const perOpUs = (totalMs * 1000) / iterations;
  console.log(
    `${label.padEnd(52)} ${totalMs.toFixed(1).padStart(8)} ms  /  ${iterations.toLocaleString("sv-SE").padStart(9)} st  =  ${perOpUs.toFixed(3)} µs per anrop`
  );
}

console.log("\n=== 1. Cykelberäkning (körs 1x per dagruta, 42 rutor/månad) ===\n");

const someDay = new Date(2026, 7, 15, 12, 0, 0);
bench("getScheduledParentForDate (2-2-3, 14 dagars cykel)", 1_000_000, () => {
  getScheduledParentForDate(cycle223, someDay);
});

bench("getNextOrdinaryHandoff", 1_000_000, () => {
  getNextOrdinaryHandoff(cycle223, someDay);
});

// Datum långt från ankaret — testar att modulo-matten inte degraderar.
const farFuture = new Date(2046, 7, 15, 12, 0, 0);
bench("getScheduledParentForDate (20 år efter ankaret)", 1_000_000, () => {
  getScheduledParentForDate(cycle223, farFuture);
});

const longCycle: CustodyCycleDoc = {
  ...cycle223,
  blocks: Array.from({ length: 40 }, (_, i) => ({ parentId: i % 2 ? B : A, days: 2 })),
};
bench("getScheduledParentForDate (40 block, 80 dagar)", 1_000_000, () => {
  getScheduledParentForDate(longCycle, someDay);
});

console.log("\n=== 2. Full månadsrendering (42 dagrutor) ===\n");

const monthDays = Array.from({ length: 42 }, (_, i) => new Date(2026, 7, i - 3, 12, 0, 0));
bench("42 dagrutor — hela månadsvyn", 20_000, () => {
  for (const d of monthDays) getScheduledParentForDate(cycle223, d);
});

console.log("\n=== 3. Ställningsberäkning (körs vid godkänt byte) ===\n");

const shortShift = {
  startAt: ts(new Date(2026, 7, 25, 12, 0)),
  endAt: ts(new Date(2026, 7, 26, 12, 0)),
  takingOverParentId: B,
};
bench("calculateShiftDeltaDays (1 dygn)", 100_000, () => {
  calculateShiftDeltaDays(cycle223, shortShift, A);
});

const weekShift = {
  startAt: ts(new Date(2026, 7, 25, 12, 0)),
  endAt: ts(new Date(2026, 8, 1, 12, 0)),
  takingOverParentId: B,
};
bench("calculateShiftDeltaDays (7 dygn)", 50_000, () => {
  calculateShiftDeltaDays(cycle223, weekShift, A);
});

const longShift = {
  startAt: ts(new Date(2026, 5, 1, 12, 0)),
  endAt: ts(new Date(2026, 7, 1, 12, 0)),
  takingOverParentId: B,
};
bench("calculateShiftDeltaDays (61 dygn — sommarlov)", 10_000, () => {
  calculateShiftDeltaDays(cycle223, longShift, A);
});

console.log("\n=== 4. Expansion av återkommande aktiviteter ===\n");

function makeEvent(id: string, start: Date, recurrence?: any): EventDoc {
  return {
    id,
    teamId: "t1",
    childId: "c1",
    title: `Aktivitet ${id}`,
    startAt: ts(start),
    endAt: ts(new Date(start.getTime() + 3600_000)),
    recurrence,
    createdBy: "u1",
    createdAt: ts(new Date()),
  };
}

const rangeStart = new Date(2026, 6, 1);
const rangeEnd = new Date(2026, 9, 1);

const oneOffs = Array.from({ length: 50 }, (_, i) => makeEvent(`e${i}`, new Date(2026, 7, (i % 28) + 1, 13, 0)));
bench("expandEvents — 50 engångsaktiviteter", 20_000, () => {
  expandEvents(oneOffs, rangeStart, rangeEnd);
});

const weeklies = Array.from({ length: 10 }, (_, i) =>
  makeEvent(`w${i}`, new Date(2026, 0, 5 + i, 13, 0), { frequency: "weekly", interval: 1 })
);
bench("expandEvents — 10 veckovisa (start 7 mån bakåt)", 5_000, () => {
  expandEvents(weeklies, rangeStart, rangeEnd);
});

const dailies = Array.from({ length: 5 }, (_, i) =>
  makeEvent(`d${i}`, new Date(2026, 0, 1 + i, 13, 0), { frequency: "daily", interval: 1 })
);
bench("expandEvents — 5 dagliga (start 7 mån bakåt)", 2_000, () => {
  expandEvents(dailies, rangeStart, rangeEnd);
});

const multiWeekday = Array.from({ length: 5 }, (_, i) =>
  makeEvent(`m${i}`, new Date(2026, 0, 5 + i, 13, 0), {
    frequency: "weekly",
    interval: 1,
    byWeekday: [1, 3, 5],
  })
);
bench("expandEvents — 5 st mån/ons/fre", 5_000, () => {
  expandEvents(multiWeekday, rangeStart, rangeEnd);
});

console.log("\n=== 5. Realistisk kombinerad rendering ===\n");

const realistic = [...oneOffs.slice(0, 20), ...weeklies.slice(0, 5), ...multiWeekday.slice(0, 2)];
bench("Månadsvy: 42 rutor + expansion av 27 events", 5_000, () => {
  for (const d of monthDays) getScheduledParentForDate(cycle223, d);
  expandEvents(realistic, rangeStart, rangeEnd);
});

console.log("\n=== 6. Kontroll: antal tillfällen som genereras ===\n");
console.log("Cykellängd 2-2-3:", getCycleLengthDays(cycle223), "dagar");
console.log("50 engångs   ->", expandEvents(oneOffs, rangeStart, rangeEnd).length, "tillfällen");
console.log("10 veckovisa ->", expandEvents(weeklies, rangeStart, rangeEnd).length, "tillfällen");
console.log("5 dagliga    ->", expandEvents(dailies, rangeStart, rangeEnd).length, "tillfällen");
console.log("5 mån/ons/fre->", expandEvents(multiWeekday, rangeStart, rangeEnd).length, "tillfällen");
console.log("");
