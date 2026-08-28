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

import {
  ShiftRequestDoc,
  CustodyCycleDoc,
  DayBalanceDoc,
  DayBalanceHistoryEntryDoc,
} from "../types/schema";
import { getNextOrdinaryHandoff } from "./custodyCycle";
import { applyApprovedShiftToBalance } from "./dayBalance";

// Minimal abstraktion så filen inte hårdkodar Firebase SDK-anrop.
// I en riktig app: ersätt med t.ex. `runTransaction(db, ...)`.
export interface Firestore {
  getCustodyCycle(childId: string): Promise<CustodyCycleDoc>;
  getDayBalance(childId: string): Promise<DayBalanceDoc>;
  createShiftRequest(doc: Omit<ShiftRequestDoc, "id">): Promise<string>;
  updateShiftRequest(id: string, patch: Partial<ShiftRequestDoc>): Promise<void>;
  writeDayBalance(childId: string, doc: DayBalanceDoc): Promise<void>;
  appendDayBalanceHistory(entry: Omit<DayBalanceHistoryEntryDoc, "id">): Promise<void>;
}

export interface CreateShiftRequestInput {
  teamId: string;
  childId: string;
  requestedBy: string; // uid för den inloggade föräldern
  takingOverParentId: string; // vem klicket gäller ("X tar ansvaret")
  startAt: Date;
  /** Om utelämnad: bytet gäller "fram till nästa ordinarie byte". */
  endAt?: Date;
  handoffMethod?: string;
  note?: string;
}

/**
 * Steg 1 av 2: skapa förslaget. Motsvarar "FÖRESLÅ"-knappen i modalen på
 * bild 4/9 ("Livia tar ansvaret för Lova ... FÖRESLÅ").
 */
export async function createShiftRequest(
  db: Firestore,
  input: CreateShiftRequestInput
): Promise<{ shiftRequestId: string; impliedEndAt: Date }> {
  const cycle = await db.getCustodyCycle(input.childId);
  const impliedEndAt = input.endAt ?? getNextOrdinaryHandoff(cycle, input.startAt);

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
export async function respondToShiftRequest(
  db: Firestore,
  args: {
    shiftRequestId: string;
    request: ShiftRequestDoc; // hämtat innan, för att undvika extra läsning här
    respondedBy: string;
    decision: "approved" | "declined";
  }
): Promise<void> {
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

  const approvedRequest: ShiftRequestDoc = {
    ...request,
    status: "approved",
    respondedBy,
    respondedAt: toTs(new Date()),
  };

  const { updatedBalance, deltaDays } = applyApprovedShiftToBalance(currentBalance, cycle, approvedRequest);

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

function toTs(date: Date): { seconds: number; nanoseconds: number } {
  const ms = date.getTime();
  return { seconds: Math.floor(ms / 1000), nanoseconds: (ms % 1000) * 1e6 };
}
