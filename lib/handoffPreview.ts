/**
 * handoffPreview.ts
 * ------------------
 * Ren hjälplogik (ingen Firestore-klient/admin-koppling) för att avgöra
 * VEM som har ansvaret vid en given tidpunkt — fasta cykeln plus
 * godkända ad hoc-byten — och om ett faktiskt överlämnings-ögonblick
 * inträffar vid en given bytestid. Används både av kalendervyn (via
 * samma resonemang, se CalendarView.tsx) och av den schemalagda
 * Cloud Functionen som skickar överlämnings-påminnelser
 * (functions/src/handoffReminders.ts) — därför bor den i lib/, inte i
 * functions/, precis som custodyCycle.ts.
 */

import { CustodyCycleDoc, ShiftRequestDoc } from "../types/schema";
import { getScheduledParentForDate } from "./custodyCycle";

function isInstantWithinShift(instant: Date, request: ShiftRequestDoc): boolean {
  const start = new Date(request.startAt.seconds * 1000);
  const end = request.endAt ? new Date(request.endAt.seconds * 1000) : null;
  if (end) return instant >= start && instant < end;
  return instant >= start;
}

/** Vem som HAR ansvaret vid en given tidpunkt: godkända byten vinner över den fasta cykeln. */
export function resolveResponsibleParent(
  cycle: CustodyCycleDoc,
  approvedShiftRequests: ShiftRequestDoc[],
  instant: Date
): string {
  const override = approvedShiftRequests.find((r) => isInstantWithinShift(instant, r));
  return override ? override.takingOverParentId : getScheduledParentForDate(cycle, instant).parentId;
}

export interface HandoffOnDate {
  fromParentId: string;
  toParentId: string;
  /** UTC-instanten bytet faktiskt sker. */
  at: Date;
}

/**
 * Sker det ett ansvarsbyte precis vid `switchInstant`? Jämför vem som
 * har ansvaret en minut innan mot vid/efter — skiljer de sig är det ett
 * verkligt överlämnings-ögonblick (annars fortsätter bara samma
 * förälders block, t.ex. mitt i ett 3-dagarsblock).
 */
export function findHandoffOnDate(
  cycle: CustodyCycleDoc,
  approvedShiftRequests: ShiftRequestDoc[],
  switchInstant: Date
): HandoffOnDate | null {
  const justBefore = new Date(switchInstant.getTime() - 60 * 1000);
  const fromParentId = resolveResponsibleParent(cycle, approvedShiftRequests, justBefore);
  const toParentId = resolveResponsibleParent(cycle, approvedShiftRequests, switchInstant);
  if (fromParentId === toParentId) return null;
  return { fromParentId, toParentId, at: switchInstant };
}
