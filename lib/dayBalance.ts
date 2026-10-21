/**
 * dayBalance.ts
 * -------------
 * "Ställningen" = hur många dagar en förälder ligger plus/minus jämfört
 * med vad den FASTA cykeln (2/2/3 etc.) egentligen säger.
 *
 * Principen:
 *   Varje dygn (eller halvdygn, om bytet sker mitt på dagen) har en
 *   "schemalagd" förälder enligt custodyCycle. Om ett godkänt
 *   shiftRequest gör att en ANNAN förälder faktiskt har barnet under
 *   en period, så är det en avvikelse. Avvikelsen omvandlas till ett
 *   dagsvärde (kan vara halva dagar) och adderas till/dras från
 *   dayBalance.balanceDays — signerat relativt referenceParentId.
 *
 * Exempel: cykeln säger att Pappa (referensförälder) ska ha barnet
 * 25–27 aug, men Mamma tar över från 25 aug 12:00 till 26 aug 12:00
 * (godkänt). Det är 1 dygn som "borde" varit Pappas men blev Mammas
 * → balanceDays minskar med 1 (Pappa ligger nu -1, dvs Mamma +1).
 */

import {
  CustodyCycleDoc,
  ShiftRequestDoc,
  DayBalanceDoc,
  DEFAULT_WEEKEND_BONUS_DAYS,
} from "../types/schema";
import { getScheduledParentForDate, getNextOrdinaryHandoff } from "./custodyCycle";

const MS_PER_DAY = 24 * 60 * 60 * 1000;
/** Vi räknar i halvdagar eftersom byten kan ske på switchHour (halvdag). */
const MS_PER_HALF_DAY = MS_PER_DAY / 2;

/**
 * Räknar ut hur många dagar (i tiondels steg) som ska justeras på
 * dayBalance.balanceDays när `request` godkänns, sett relativt
 * `referenceParentId`.
 *
 * Positivt returvärde = referensföräldern FÖRLORAR dagar (den andra
 * föräldern tar över dagar som annars var referensförälderns) → alltså
 * ska balanceDays MINSKAS med det returnerade värdet.
 * Negativt returvärde = referensföräldern FÅR dagar → balanceDays ÖKAS.
 *
 * Helgbonus: för varje lördag och söndag som ett avvikande steg i bytet
 * berör läggs cycle.weekendBonusDays (default 0.5) till i samma riktning
 * som avvikelsen, dvs till den förälder som faktiskt tar över. En helgdag
 * räknas högst en gång per byte.
 */
export function calculateShiftDeltaDays(
  cycle: CustodyCycleDoc,
  request: Pick<ShiftRequestDoc, "startAt" | "endAt" | "takingOverParentId">,
  referenceParentId: string
): number {
  const start = fromTs(request.startAt);
  const end = request.endAt ? fromTs(request.endAt) : getNextOrdinaryHandoff(cycle, start);

  if (end.getTime() <= start.getTime()) {
    throw new Error("Slutdatum måste vara efter startdatum för shiftRequest");
  }

  // En anhörig kan ta en dag SJÄLV (etapp 4, docs/roller-och-medlemskap.md)
  // — takingOverParentId pekar då på en anhörigs uid, inte en av de två
  // riktiga föräldrarna i cykeln. Ett sådant byte ska ALDRIG påverka
  // ställningen ("ingen förälder vann något på den") — dagen syns
  // fortfarande som ordinarie förälders färg i kalendern, precis som
  // innan bytet.
  const isRealCycleParent = cycle.blocks.some((b) => b.parentId === request.takingOverParentId);
  if (!isRealCycleParent) return 0;

  const timeZone = cycle.timezone || "Europe/Stockholm";
  const weekendBonus = cycle.weekendBonusDays ?? DEFAULT_WEEKEND_BONUS_DAYS;
  const weekendDaysCounted = new Set<string>();

  let deltaAwayFromReference = 0; // antal dagar som flyttas BORT FRÅN referensföräldern
  let cursor = new Date(start);

  // Iterera i halvdags-steg genom perioden och jämför "schemalagd" förälder
  // (enligt fasta cykeln) mot vem som FAKTISKT har barnet (takingOverParentId).
  while (cursor.getTime() < end.getTime()) {
    const stepEnd = new Date(Math.min(cursor.getTime() + MS_PER_HALF_DAY, end.getTime()));
    const midpoint = new Date((cursor.getTime() + stepEnd.getTime()) / 2);

    const scheduled = getScheduledParentForDate(cycle, midpoint);
    const stepFractionOfDay = (stepEnd.getTime() - cursor.getTime()) / MS_PER_DAY;

    const actualParentId = request.takingOverParentId;

    // sign: +1 = referensföräldern förlorar, -1 = referensföräldern vinner, 0 = ingen avvikelse
    let sign = 0;
    if (scheduled.parentId === referenceParentId && actualParentId !== referenceParentId) {
      // Referensförälderns dag togs över av den andra → förlust för referensförälder
      deltaAwayFromReference += stepFractionOfDay;
      sign = 1;
    } else if (scheduled.parentId !== referenceParentId && actualParentId === referenceParentId) {
      // Referensförälderns motpart skulle haft dagen, men referensförälder tog över → vinst
      deltaAwayFromReference -= stepFractionOfDay;
      sign = -1;
    }

    // Helgbonus: steget kan täcka högst två kalenderdagar (start och slut),
    // och varje lördag/söndag ger bonusen en gång.
    if (sign !== 0) {
      for (const instant of [cursor, new Date(stepEnd.getTime() - 1)]) {
        const day = localDay(instant, timeZone);
        if (day.isWeekend && !weekendDaysCounted.has(day.key)) {
          weekendDaysCounted.add(day.key);
          deltaAwayFromReference += sign * weekendBonus;
        }
      }
    }

    cursor = stepEnd;
  }

  return roundTenth(deltaAwayFromReference);
}

/**
 * Applicerar ett godkänt shiftRequest på en dayBalance och returnerar det
 * nya dokumentet (rent-funktion — anroparen ansvarar för att skriva till
 * Firestore, t.ex. i en transaction i en Cloud Function).
 */
export function applyApprovedShiftToBalance(
  currentBalance: DayBalanceDoc,
  cycle: CustodyCycleDoc,
  request: ShiftRequestDoc
): { updatedBalance: DayBalanceDoc; deltaDays: number } {
  if (request.status !== "approved") {
    throw new Error("applyApprovedShiftToBalance kräver ett godkänt shiftRequest");
  }

  const deltaAwayFromReference = calculateShiftDeltaDays(cycle, request, currentBalance.referenceParentId);

  // deltaAwayFromReference > 0 → referensföräldern förlorade dagar → balanceDays minskar.
  const newBalanceDays = roundTenth(currentBalance.balanceDays - deltaAwayFromReference);

  const updatedBalance: DayBalanceDoc = {
    ...currentBalance,
    balanceDays: newBalanceDays,
    lastShiftRequestId: request.id,
    updatedAt: nowTs(),
  };

  // Returnerar också "deltaDays" i request-perspektiv (för historik/UI-text),
  // dvs hur många dagar som faktiskt bytte ägare i detta specifika byte.
  return { updatedBalance, deltaDays: -deltaAwayFromReference };
}

/**
 * Formaterar ställningen till en UI-sträng, t.ex. "+2 dagar på Pappa".
 * parentNames mappar parentId → förnamn.
 */
export function formatBalanceLabel(
  balance: DayBalanceDoc,
  parentNames: Record<string, string>,
  otherParentId: string
): string {
  if (balance.balanceDays === 0) {
    return "Jämnt läge — inga dagar att kvitta.";
  }
  const isReferenceAhead = balance.balanceDays > 0;
  const leadingParentId = isReferenceAhead ? balance.referenceParentId : otherParentId;
  const days = Math.abs(balance.balanceDays);
  const dayLabel = days === 1 ? "dag" : "dagar";
  return `+${formatDays(days)} ${dayLabel} på ${parentNames[leadingParentId] ?? "?"}`;
}

function formatDays(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

// ---------------------------------------------------------------------------
// Hjälpfunktioner
// ---------------------------------------------------------------------------

/** Avrundar till en decimal för att undvika flyttalsbrus (t.ex. 1.2999999). */
function roundTenth(n: number): number {
  return Math.round(n * 10) / 10;
}

/** Lokal kalenderdag (YYYY-MM-DD) och om den är lördag eller söndag i `timeZone`. */
function localDay(instant: Date, timeZone: string): { key: string; isWeekend: boolean } {
  const key = new Intl.DateTimeFormat("sv-SE", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(instant);
  const weekday = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short" }).format(instant);
  return { key, isWeekend: weekday === "Sat" || weekday === "Sun" };
}

function fromTs(ts: { seconds: number; nanoseconds: number }): Date {
  return new Date(ts.seconds * 1000 + ts.nanoseconds / 1e6);
}

function nowTs(): { seconds: number; nanoseconds: number } {
  const ms = Date.now();
  return { seconds: Math.floor(ms / 1000), nanoseconds: (ms % 1000) * 1e6 };
}
