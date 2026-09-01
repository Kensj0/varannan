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

  const timeZone = cycle.timezone || "Europe/Stockholm";
  const [switchH, switchM] = cycle.switchHour.split(":").map(Number);

  // Räkna i KALENDERDAGAR, inte i fasta 24-timmarssteg. Ett dygn är inte
  // alltid 86 400 000 ms: vid sommartidsomställningen är det 23 eller 25
  // timmar. Tidigare adderades block som fasta ms från ett ankare, vilket
  // gjorde att bytespunkten gled en timme i lokal tid efter varje
  // omställning (08:00 blev 07:00 på vintern). Då hamnade morgonsamplingen
  // — switchHour minus en minut — på fel sida om gränsen, bytesdagarna
  // slutade upptäckas, och kalendern ritade hela veckor i en färg.
  const wall = getZonedParts(at, timeZone);

  // Ett "cykeldygn" löper från switchHour till switchHour. Är klockan före
  // bytestiden tillhör tidpunkten alltså föregående dygns block.
  const beforeSwitch =
    wall.hour < switchH || (wall.hour === switchH && wall.minute < switchM);
  const effectiveDayNumber = daysFromCivil(wall.year, wall.month, wall.day) - (beforeSwitch ? 1 : 0);

  const [startY, startM, startD] = cycle.cycleStartDate.split("-").map(Number);
  const anchorDayNumber = daysFromCivil(startY, startM, startD);

  const dayIndex = effectiveDayNumber - anchorDayNumber;
  const offsetInCycle = ((dayIndex % cycleLengthDays) + cycleLengthDays) % cycleLengthDays;
  const cycleBaseDayNumber = effectiveDayNumber - offsetInCycle;

  let cursorDays = 0;
  for (let i = 0; i < cycle.blocks.length; i++) {
    const blockDays = cycle.blocks[i].days;
    if (offsetInCycle < cursorDays + blockDays) {
      const startDayNumber = cycleBaseDayNumber + cursorDays;
      return {
        parentId: cycle.blocks[i].parentId,
        blockIndex: i,
        segmentStart: new Date(switchInstantForDayNumber(startDayNumber, switchH, switchM, timeZone)),
        segmentEnd: new Date(
          switchInstantForDayNumber(startDayNumber + blockDays, switchH, switchM, timeZone)
        ),
      };
    }
    cursorDays += blockDays;
  }

  // Ska aldrig nås (offsetInCycle < cycleLengthDays garanterar en träff ovan),
  // men TypeScript vill ha en retur.
  const lastIndex = cycle.blocks.length - 1;
  const lastDays = cycle.blocks[lastIndex].days;
  const lastStartDayNumber = cycleBaseDayNumber + cycleLengthDays - lastDays;
  return {
    parentId: cycle.blocks[lastIndex].parentId,
    blockIndex: lastIndex,
    segmentStart: new Date(switchInstantForDayNumber(lastStartDayNumber, switchH, switchM, timeZone)),
    segmentEnd: new Date(
      switchInstantForDayNumber(lastStartDayNumber + lastDays, switchH, switchM, timeZone)
    ),
  };
}

/** Väggklockans delar i en given tidszon för en absolut tidpunkt. */
function getZonedParts(
  instant: Date,
  timeZone: string
): { year: number; month: number; day: number; hour: number; minute: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(instant);
  const get = (type: string) => Number(parts.find((p) => p.type === type)!.value);
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour") % 24,
    minute: get("minute"),
  };
}

/**
 * Dagnummer för ett civildatum (Howard Hinnants days_from_civil). Ren
 * heltalsaritmetik utan Date-objekt, så den är helt opåverkad av tidszoner
 * och sommartid — poängen med hela omskrivningen.
 */
function daysFromCivil(year: number, month: number, day: number): number {
  const y = year - (month <= 2 ? 1 : 0);
  const era = Math.floor((y >= 0 ? y : y - 399) / 400);
  const yoe = y - era * 400;
  const doy = Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + day - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

/** Omvändningen: dagnummer → civildatum. */
function civilFromDays(dayNumber: number): { year: number; month: number; day: number } {
  const z = dayNumber + 719468;
  const era = Math.floor((z >= 0 ? z : z - 146096) / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const y = yoe + era * 400;
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp + (mp < 10 ? 3 : -9);
  return { year: y + (m <= 2 ? 1 : 0), month: m, day: d };
}

/** Absolut tidpunkt för switchHour på ett givet dagnummer, i rätt tidszon. */
function switchInstantForDayNumber(
  dayNumber: number,
  switchH: number,
  switchM: number,
  timeZone: string
): number {
  const { year, month, day } = civilFromDays(dayNumber);
  return zonedWallClockToMs(year, month - 1, day, switchH, switchM, timeZone);
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
 * Bytestidens exakta tidpunkt (UTC-instant) för ett givet kalenderdatum,
 * i cykelns egen tidszon — t.ex. "2026-09-10" + switchHour "12:00" +
 * timezone "Europe/Stockholm" → rätt UTC-instant oavsett var koden körs.
 * Används av den schemalagda överlämnings-påminnelsen (Cloud Functions
 * kör i UTC, så Date.setHours() duger inte där, se resonemanget ovan).
 */
export function switchInstantForDate(cycle: CustodyCycleDoc, dateStr: string): Date {
  const [year, month, day] = dateStr.split("-").map(Number);
  const [switchH, switchM] = cycle.switchHour.split(":").map(Number);
  const timeZone = cycle.timezone || "Europe/Stockholm";
  return new Date(zonedWallClockToMs(year, month - 1, day, switchH ?? 12, switchM ?? 0, timeZone));
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

