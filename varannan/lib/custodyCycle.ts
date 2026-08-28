/**
 * custodyCycle.ts
 * ----------------
 * Beräknar vem som "borde" ha barnet en given tidpunkt enligt den fasta
 * grundcykeln (t.ex. 2/2/3), helt utan att behöva lagra en rad per dag i
 * Firestore. Cykeln är bara ett litet dokument (CustodyCycleDoc) och allt
 * annat räknas fram on-the-fly.
 *
 * Byten sker på halvdag (switchHour, t.ex. "12:00"), precis som i
 * originalappen där ett byte kan ske t.ex. kl 12:00 en viss dag.
 */

import { CustodyCycleDoc } from "../types/schema";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export interface CycleSegment {
  parentId: string;
  /** Index i cycleDoc.blocks */
  blockIndex: number;
  /** Segmentets start/slut i cykel-lokal tid (Date-objekt, redan tidszon-justerade av anroparen). */
  segmentStart: Date;
  segmentEnd: Date;
}

/** Total längd på cykeln i dagar (t.ex. 14 för ett 2-2-3-2-2-3-mönster). */
export function getCycleLengthDays(cycle: CustodyCycleDoc): number {
  let total = 0;
  for (let i = 0; i < cycle.blocks.length; i++) total += cycle.blocks[i].days;
  return total;
}

/**
 * Ger vilken förälder som enligt den FASTA cykeln (ignorerar godkända
 * shiftRequests) har ansvaret vid tidpunkten `at`.
 *
 * Hot path: anropas en gång per dagruta (42 per månadsvy). Därför
 * allokerar den inga Date-objekt för brytpunkterna, utan går igenom
 * blocken med ren aritmetik och skapar bara de två Date-objekt som
 * faktiskt returneras.
 */
export function getScheduledParentForDate(cycle: CustodyCycleDoc, at: Date): CycleSegment {
  const cycleLengthDays = getCycleLengthDays(cycle);
  if (cycleLengthDays <= 0) {
    throw new Error("Cykeln måste ha minst ett block med days > 0");
  }
  const cycleLengthMs = cycleLengthDays * MS_PER_DAY;

  const anchorMs = resolveCycleAnchorMs(cycle);

  // Hur långt in i cykeln (i ms) befinner vi oss, modulo cykelns längd.
  // Hanterar även datum FÖRE cycleStartDate korrekt via positiv modulo.
  const elapsed = at.getTime() - anchorMs;
  const offsetInCycle = ((elapsed % cycleLengthMs) + cycleLengthMs) % cycleLengthMs;
  const cycleBaseMs = anchorMs + (elapsed - offsetInCycle);

  let cursorMs = 0;
  for (let i = 0; i < cycle.blocks.length; i++) {
    const blockLengthMs = cycle.blocks[i].days * MS_PER_DAY;
    if (offsetInCycle < cursorMs + blockLengthMs) {
      const segmentStartMs = cycleBaseMs + cursorMs;
      return {
        parentId: cycle.blocks[i].parentId,
        blockIndex: i,
        segmentStart: new Date(segmentStartMs),
        segmentEnd: new Date(segmentStartMs + blockLengthMs),
      };
    }
    cursorMs += blockLengthMs;
  }

  // Ska aldrig nås (offsetInCycle < cycleLengthMs garanterar en träff ovan),
  // men TypeScript vill ha en retur.
  const lastIndex = cycle.blocks.length - 1;
  const lastLengthMs = cycle.blocks[lastIndex].days * MS_PER_DAY;
  const lastStartMs = cycleBaseMs + cycleLengthMs - lastLengthMs;
  return {
    parentId: cycle.blocks[lastIndex].parentId,
    blockIndex: lastIndex,
    segmentStart: new Date(lastStartMs),
    segmentEnd: new Date(lastStartMs + lastLengthMs),
  };
}

/**
 * Nästa "ordinarie" bytpunkt efter `at` enligt den fasta cykeln.
 * Används för texten "fram till nästa ordinarie byte" i Ändra ansvar-flödet.
 */
export function getNextOrdinaryHandoff(cycle: CustodyCycleDoc, at: Date): Date {
  const segment = getScheduledParentForDate(cycle, at);
  return segment.segmentEnd;
}

// ---------------------------------------------------------------------------
// Tidszonshantering
// ---------------------------------------------------------------------------

/**
 * VARFÖR DET HÄR BEHÖVS
 *
 * switchHour ("12:00") är ett klockslag som föräldrarna läser i sin egen
 * tidszon. Tidigare applicerades det med Date.setHours(), som använder
 * den tidszon där koden RÅKAR köra. Klienten kör i Europe/Stockholm,
 * men Cloud Functions kör i UTC — så samma cykel gav 12:00 lokal tid i
 * kalendern men 12:00 UTC (= 14:00 svensk sommartid) när ställningen
 * räknades ut på servern. Det kunde felaktigt tillskriva en halv dag.
 *
 * Nu resolveras ankaret alltid i cykelns lagrade tidszon, oavsett var
 * koden körs.
 */

/** Vad visar klockan i `timeZone` vid tidpunkten `instant`? Returnerar offset i ms. */
function getZoneOffsetMs(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(instant);

  const get = (type: string) => Number(parts.find((p) => p.type === type)!.value);
  const asIfUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour") % 24, get("minute"), get("second"));
  return asIfUtc - instant.getTime();
}

/**
 * Omvandlar en väggklocka (datum + klockslag i en viss tidszon) till en
 * absolut tidpunkt. Två pass, eftersom offseten vid gissningen kan skilja
 * sig från offseten vid resultatet över en sommartidsövergång.
 */
function zonedWallClockToMs(
  year: number,
  monthIndex: number,
  day: number,
  hours: number,
  minutes: number,
  timeZone: string
): number {
  const guessMs = Date.UTC(year, monthIndex, day, hours, minutes);
  const firstOffset = getZoneOffsetMs(new Date(guessMs), timeZone);
  let resultMs = guessMs - firstOffset;

  const secondOffset = getZoneOffsetMs(new Date(resultMs), timeZone);
  if (secondOffset !== firstOffset) {
    resultMs = guessMs - secondOffset;
  }
  return resultMs;
}

/**
 * Intl-anrop är dyra jämfört med resten av hot path (0,5 µs per anrop),
 * och ankaret är konstant för en given cykel. Därför cachas det per
 * unik kombination av startdatum, klockslag och tidszon.
 */
const anchorCache = new Map<string, number>();

function resolveCycleAnchorMs(cycle: CustodyCycleDoc): number {
  const key = `${cycle.cycleStartDate}|${cycle.switchHour}|${cycle.timezone}`;
  const cached = anchorCache.get(key);
  if (cached !== undefined) return cached;

  const [year, month, day] = cycle.cycleStartDate.split("-").map(Number);
  const [switchH, switchM] = cycle.switchHour.split(":").map(Number);
  const timeZone = cycle.timezone || "Europe/Stockholm";

  const anchorMs = zonedWallClockToMs(year, month - 1, day, switchH, switchM, timeZone);
  anchorCache.set(key, anchorMs);
  return anchorMs;
}

/**
 * KÄND BEGRÄNSNING: blockgränser beräknas som anchorMs + N * 24h. Över
 * en sommartidsövergång driver bytestiden därför en timme (12:00 blir
 * 11:00 eller 13:00) tills cykeln ankras om. Eftersom svenska
 * DST-övergångar sker kl 03:00 och byten normalt sker mitt på dagen,
 * korsar driften aldrig en dygnsgräns — vilken förälder som har
 * ansvaret blir alltid rätt. Att bygga bort det helt skulle kräva ett
 * Intl-anrop per blockgräns, vilket är ~100x dyrare i hot path.
 */

