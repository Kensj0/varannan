"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.calculateShiftDeltaDays = calculateShiftDeltaDays;
exports.applyApprovedShiftToBalance = applyApprovedShiftToBalance;
exports.formatBalanceLabel = formatBalanceLabel;
const custodyCycle_1 = require("./custodyCycle");
const MS_PER_DAY = 24 * 60 * 60 * 1000;
/** Vi räknar i halvdagar eftersom byten kan ske på switchHour (halvdag). */
const MS_PER_HALF_DAY = MS_PER_DAY / 2;
/**
 * Räknar ut hur många dagar (kan vara .5) som ska justeras på
 * dayBalance.balanceDays när `request` godkänns, sett relativt
 * `referenceParentId`.
 *
 * Positivt returvärde = referensföräldern FÖRLORAR dagar (den andra
 * föräldern tar över dagar som annars var referensförälderns) → alltså
 * ska balanceDays MINSKAS med det returnerade värdet.
 * Negativt returvärde = referensföräldern FÅR dagar → balanceDays ÖKAS.
 *
 * (Se calculateNewBalance nedan för hur tecknet faktiskt tillämpas —
 * den här funktionen håller sig neutral och bara mäter avvikelsen.)
 */
function calculateShiftDeltaDays(cycle, request, referenceParentId) {
    const start = fromTs(request.startAt);
    const end = request.endAt ? fromTs(request.endAt) : (0, custodyCycle_1.getNextOrdinaryHandoff)(cycle, start);
    if (end.getTime() <= start.getTime()) {
        throw new Error("Slutdatum måste vara efter startdatum för shiftRequest");
    }
    let deltaAwayFromReference = 0; // antal dagar som flyttas BORT FRÅN referensföräldern
    let cursor = new Date(start);
    // Iterera i halvdags-steg genom perioden och jämför "schemalagd" förälder
    // (enligt fasta cykeln) mot vem som FAKTISKT har barnet (takingOverParentId).
    while (cursor.getTime() < end.getTime()) {
        const stepEnd = new Date(Math.min(cursor.getTime() + MS_PER_HALF_DAY, end.getTime()));
        const midpoint = new Date((cursor.getTime() + stepEnd.getTime()) / 2);
        const scheduled = (0, custodyCycle_1.getScheduledParentForDate)(cycle, midpoint);
        const stepFractionOfDay = (stepEnd.getTime() - cursor.getTime()) / MS_PER_DAY;
        const actualParentId = request.takingOverParentId;
        if (scheduled.parentId === referenceParentId && actualParentId !== referenceParentId) {
            // Referensförälderns dag togs över av den andra → förlust för referensförälder
            deltaAwayFromReference += stepFractionOfDay;
        }
        else if (scheduled.parentId !== referenceParentId && actualParentId === referenceParentId) {
            // Referensförälderns motpart skulle haft dagen, men referensförälder tog över → vinst
            deltaAwayFromReference -= stepFractionOfDay;
        }
        // Om scheduled === actual (ingen faktisk avvikelse) → ingen justering.
        cursor = stepEnd;
    }
    // Avrunda till närmaste halva dag för att undvika flyttal-brus.
    return Math.round(deltaAwayFromReference * 2) / 2;
}
/**
 * Applicerar ett godkänt shiftRequest på en dayBalance och returnerar det
 * nya dokumentet (rent-funktion — anroparen ansvarar för att skriva till
 * Firestore, t.ex. i en transaction i en Cloud Function).
 */
function applyApprovedShiftToBalance(currentBalance, cycle, request) {
    if (request.status !== "approved") {
        throw new Error("applyApprovedShiftToBalance kräver ett godkänt shiftRequest");
    }
    const deltaAwayFromReference = calculateShiftDeltaDays(cycle, request, currentBalance.referenceParentId);
    // deltaAwayFromReference > 0 → referensföräldern förlorade dagar → balanceDays minskar.
    const newBalanceDays = currentBalance.balanceDays - deltaAwayFromReference;
    const updatedBalance = {
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
function formatBalanceLabel(balance, parentNames, otherParentId) {
    if (balance.balanceDays === 0) {
        return "Jämnt läge — inga dagar att kvitta.";
    }
    const isReferenceAhead = balance.balanceDays > 0;
    const leadingParentId = isReferenceAhead ? balance.referenceParentId : otherParentId;
    const days = Math.abs(balance.balanceDays);
    const dayLabel = days === 1 ? "dag" : "dagar";
    return `+${formatDays(days)} ${dayLabel} på ${parentNames[leadingParentId] ?? "?"}`;
}
function formatDays(n) {
    return Number.isInteger(n) ? String(n) : n.toFixed(1);
}
// ---------------------------------------------------------------------------
// Hjälpfunktioner
// ---------------------------------------------------------------------------
function fromTs(ts) {
    return new Date(ts.seconds * 1000 + ts.nanoseconds / 1e6);
}
function nowTs() {
    const ms = Date.now();
    return { seconds: Math.floor(ms / 1000), nanoseconds: (ms % 1000) * 1e6 };
}
