"use strict";
/**
 * shiftRequests.ts
 * ----------------
 * Logiken bakom "Tryck på en dag → välj Aktivitet eller Ändra ansvar".
 *
 * Designtanke: klicket på en dag i UI:t triggar bara en modal (ren
 * presentation, se DayActionModal.tsx). Det är FÖRST när användaren
 * bekräftar ett av de två valen som vi når hit och pratar med Firestore.
 *
 * Ändra ansvar skapar ALLTID ett `shiftRequest` med status "pending" —
 * det blir aldrig verkligt förrän andra föräldern godkänner (precis som
 * originalappens "FÖRESLÅ"-knapp). Godkännande sker i `respondToShiftRequest`.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.createShiftRequest = createShiftRequest;
exports.respondToShiftRequest = respondToShiftRequest;
const custodyCycle_1 = require("./custodyCycle");
const dayBalance_1 = require("./dayBalance");
/**
 * Steg 1 av 2: skapa förslaget. Motsvarar "FÖRESLÅ"-knappen i modalen på
 * bild 4/9 ("Livia tar ansvaret för Lova ... FÖRESLÅ").
 */
async function createShiftRequest(db, input) {
    const cycle = await db.getCustodyCycle(input.childId);
    const impliedEndAt = input.endAt ?? (0, custodyCycle_1.getNextOrdinaryHandoff)(cycle, input.startAt);
    const shiftRequestId = await db.createShiftRequest({
        teamId: input.teamId,
        childId: input.childId,
        requestedBy: input.requestedBy,
        takingOverParentId: input.takingOverParentId,
        startAt: toTs(input.startAt),
        endAt: input.endAt ? toTs(input.endAt) : undefined,
        handoffMethod: input.handoffMethod,
        note: input.note,
        status: "pending",
        createdAt: toTs(new Date()),
    });
    return { shiftRequestId, impliedEndAt };
}
/**
 * Steg 2 av 2: andra föräldern svarar. Vid "approved" räknas Ställningen
 * om ATOMISKT tillsammans med statusändringen — i en riktig backend körs
 * detta som en Firestore-transaction i en Cloud Function (triggas t.ex.
 * av en onUpdate-lyssnare eller ett direkt "approve"-callable).
 */
async function respondToShiftRequest(db, args) {
    const { shiftRequestId, request, respondedBy, decision } = args;
    if (decision === "declined") {
        await db.updateShiftRequest(shiftRequestId, {
            status: "declined",
            respondedBy,
            respondedAt: toTs(new Date()),
        });
        return;
    }
    const cycle = await db.getCustodyCycle(request.childId);
    const currentBalance = await db.getDayBalance(request.childId);
    const approvedRequest = {
        ...request,
        status: "approved",
        respondedBy,
        respondedAt: toTs(new Date()),
    };
    const { updatedBalance, deltaDays } = (0, dayBalance_1.applyApprovedShiftToBalance)(currentBalance, cycle, approvedRequest);
    // I produktion: gör dessa tre skrivningar i EN transaction.
    await db.updateShiftRequest(shiftRequestId, {
        status: "approved",
        respondedBy,
        respondedAt: approvedRequest.respondedAt,
        balanceDeltaDays: deltaDays,
    });
    await db.writeDayBalance(request.childId, updatedBalance);
    await db.appendDayBalanceHistory({
        childId: request.childId,
        shiftRequestId,
        deltaDays,
        balanceAfter: updatedBalance.balanceDays,
        createdAt: toTs(new Date()),
    });
}
function toTs(date) {
    const ms = date.getTime();
    return { seconds: Math.floor(ms / 1000), nanoseconds: (ms % 1000) * 1e6 };
}
