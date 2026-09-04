import { collection, doc, setDoc, Timestamp } from "firebase/firestore";
import { httpsCallable } from "firebase/functions";
import { db, functions } from "./firebase";
import { sendChatMessage } from "./chatActions";
import {
  EventDoc,
  ShiftRequestDoc,
  RecurrenceRule,
  ScheduleChangeMode,
} from "../types/schema";

/**
 * Skrivningar från kalendervyn. Aktiviteter och nya (pending)
 * ansvarsbyten får skrivas direkt av teammedlemmar enligt
 * firestore.rules. Godkännande går via callable, eftersom det måste
 * uppdatera ställningen i samma transaktion.
 */

export async function createEvent(args: {
  teamId: string;
  childId?: string;
  title: string;
  startAt: Date;
  endAt: Date;
  recurrence?: RecurrenceRule;
  createdBy: string;
}): Promise<string> {
  const ref = doc(collection(db, `teams/${args.teamId}/events`));
  const event: EventDoc = {
    id: ref.id,
    teamId: args.teamId,
    childId: args.childId,
    title: args.title,
    startAt: Timestamp.fromDate(args.startAt) as any,
    endAt: Timestamp.fromDate(args.endAt) as any,
    createdBy: args.createdBy,
    createdAt: Timestamp.now() as any,
    // Firestores webb-SDK kastar fel på `undefined`-fält, så recurrence
    // inkluderas bara när aktiviteten faktiskt är återkommande.
    ...(args.recurrence ? { recurrence: args.recurrence } : {}),
  };
  await setDoc(ref, event);
  return ref.id;
}

/** Bygger ett Firestore-dokument för en shiftRequest, utan undefined-fält. */
function buildShiftRequestDoc(args: {
  ref: ReturnType<typeof doc>;
  teamId: string;
  childId: string;
  requestedBy: string;
  takingOverParentId: string;
  startAt: Date;
  endAt?: Date;
  handoffMethod?: string;
  note?: string;
  batchId?: string;
}): ShiftRequestDoc {
  return {
    id: args.ref.id,
    teamId: args.teamId,
    childId: args.childId,
    requestedBy: args.requestedBy,
    takingOverParentId: args.takingOverParentId,
    startAt: Timestamp.fromDate(args.startAt) as any,
    status: "pending",
    createdAt: Timestamp.now() as any,
    // Firestores webb-SDK kastar fel på `undefined`-fält — varje valfritt
    // fält inkluderas bara när det faktiskt har ett värde.
    ...(args.endAt ? { endAt: Timestamp.fromDate(args.endAt) as any } : {}),
    ...(args.handoffMethod ? { handoffMethod: args.handoffMethod } : {}),
    ...(args.note ? { note: args.note } : {}),
    ...(args.batchId ? { batchId: args.batchId } : {}),
  };
}

export async function proposeShiftRequest(args: {
  teamId: string;
  childId: string;
  requestedBy: string;
  takingOverParentId: string;
  startAt: Date;
  endAt?: Date;
  handoffMethod?: string;
  note?: string;
}): Promise<string> {
  const ref = doc(collection(db, `teams/${args.teamId}/shiftRequests`));
  const request = buildShiftRequestDoc({ ref, ...args });
  await setDoc(ref, request);

  // Lägg in förfrågan i chatten också, så båda föräldrarna har hela
  // historiken över förfrågningar och godkännanden på ett ställe.
  // childId MÅSTE med: chatten är kalenderbunden sedan delningen flyttades
  // ner på barnet, så utan det hamnar varje förfrågans chattpost på den
  // FÖRSTA kalendern i stället för på rätt barn.
  await sendChatMessage({
    teamId: args.teamId,
    childId: args.childId,
    senderId: args.requestedBy,
    text: args.note ?? "",
    linkedShiftRequestId: ref.id,
  });

  return ref.id;
}

/** Godkänn eller avböj — kör transaktionen som uppdaterar ställningen. */
export async function respondToShiftRequest(args: {
  teamId: string;
  childId: string;
  shiftRequestId: string;
  decision: "approved" | "declined";
}): Promise<void> {
  const fn = httpsCallable(functions, "approveShiftRequest");
  await fn(args);
}

// ---------------------------------------------------------------------------
// Kalenderns ändringsläge: måla om flera dagar och skicka som ETT förslag.
// ---------------------------------------------------------------------------

export interface DayChange {
  /** Kalenderdatum (lokal tid, tidpunkten på dygnet spelar ingen roll). */
  date: Date;
  takingOverParentId: string;
}

/** "12:00" → { hours: 12, minutes: 0 } */
function parseSwitchHour(switchHour: string): { hours: number; minutes: number } {
  const [h, m] = switchHour.split(":").map(Number);
  return { hours: h ?? 12, minutes: m ?? 0 };
}

/** Datumet vid bytestiden en given kalenderdag, t.ex. 27 aug 12:00. */
export function atSwitchHour(date: Date, switchHour: string): Date {
  const { hours, minutes } = parseSwitchHour(switchHour);
  const d = new Date(date);
  d.setHours(hours, minutes, 0, 0);
  return d;
}

export function addDays(date: Date, days: number): Date {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

function isSameCalendarDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/**
 * Slår ihop enskilda dagändringar till sammanhängande körningar med
 * samma förälder, så att "må–to till pappa" blir ETT block istället för
 * fyra. Delas av förfrågningsvägen och direktändringsvägen, så att en
 * ändring ser likadan ut i historiken oavsett vilket läge teamet har.
 */
function groupIntoRuns(
  changes: DayChange[]
): { start: Date; end: Date; takingOverParentId: string }[] {
  const sorted = [...changes].sort((a, b) => a.date.getTime() - b.date.getTime());
  const runs: { start: Date; end: Date; takingOverParentId: string }[] = [];
  for (const change of sorted) {
    const last = runs[runs.length - 1];
    const isConsecutive = last && isSameCalendarDay(addDays(last.end, 1), change.date);
    if (last && last.takingOverParentId === change.takingOverParentId && isConsecutive) {
      last.end = change.date;
    } else {
      runs.push({ start: change.date, end: change.date, takingOverParentId: change.takingOverParentId });
    }
  }
  return runs;
}

/**
 * Slår ihop flera dagändringar (från kalenderns ändringsläge) till ETT
 * förslag: en shiftRequest per SAMMANHÄNGANDE körning av dagar som går
 * till samma förälder, alla taggade med samma batchId så de visas och
 * besvaras tillsammans i UI:t.
 *
 * Byten sker på bytestiden (switchHour), inte midnatt — varje dag i
 * `changes` blir alltså perioden [den dagens bytestid, nästa dags
 * bytestid) för den föräldern.
 */
export async function proposeShiftRequestBatch(args: {
  teamId: string;
  childId: string;
  requestedBy: string;
  switchHour: string;
  changes: DayChange[];
  note?: string;
}): Promise<string> {
  if (args.changes.length === 0) throw new Error("Inga dagar valda.");

  const sorted = [...args.changes].sort((a, b) => a.date.getTime() - b.date.getTime());
  const runs = groupIntoRuns(args.changes);

  const batchId = doc(collection(db, `teams/${args.teamId}/shiftRequests`)).id;

  const writes = runs.map((run) => {
    const ref = doc(collection(db, `teams/${args.teamId}/shiftRequests`));
    const request = buildShiftRequestDoc({
      ref,
      teamId: args.teamId,
      childId: args.childId,
      requestedBy: args.requestedBy,
      takingOverParentId: run.takingOverParentId,
      startAt: atSwitchHour(run.start, args.switchHour),
      endAt: atSwitchHour(addDays(run.end, 1), args.switchHour),
      note: args.note,
      batchId,
    });
    return setDoc(ref, request);
  });
  await Promise.all(writes);

  // childId MÅSTE med, samma skäl som i proposeShiftRequest: chatten är
  // kalenderbunden, så utan det hamnar batchens chattpost på fel barns kalender.
  await sendChatMessage({
    teamId: args.teamId,
    childId: args.childId,
    senderId: args.requestedBy,
    text: args.note ?? `Föreslår ändring av ${sorted.length} dag${sorted.length === 1 ? "" : "ar"}.`,
    linkedShiftRequestId: batchId,
  });

  return batchId;
}

/** Godkänn eller avböj en hel grupp av dagändringar i ett svep. */
export async function proposeBalanceAdjustment(args: {
  teamId: string;
  childId: string;
  deltaDays: number;
  note?: string;
}): Promise<{ id: string }> {
  const fn = httpsCallable<typeof args, { id: string }>(functions, "proposeBalanceAdjustment");
  const res = await fn(args);
  return res.data;
}

export async function respondToBalanceAdjustment(args: {
  teamId: string;
  childId: string;
  requestId: string;
  decision: "approved" | "declined";
}): Promise<void> {
  const fn = httpsCallable(functions, "respondToBalanceAdjustment");
  await fn(args);
}

export async function clearApprovedShiftsFrom(args: {
  teamId: string;
  childId: string;
  fromDate: string; // "YYYY-MM-DD"
}): Promise<{ removed: number }> {
  const fn = httpsCallable<typeof args, { removed: number }>(functions, "clearApprovedShiftsFrom");
  const res = await fn(args);
  return res.data;
}

export async function respondToShiftRequestBatch(args: {
  teamId: string;
  childId: string;
  batchId: string;
  decision: "approved" | "declined";
}): Promise<void> {
  const fn = httpsCallable(functions, "approveShiftRequestBatch");
  await fn(args);
}

// ---------------------------------------------------------------------------
// Läget för schemaändringar: förfrågan (godkännande krävs) vs notifiering
// (gäller direkt). Se ScheduleChangeMode i types/schema.ts.
// ---------------------------------------------------------------------------

export async function setScheduleChangeMode(
  teamId: string,
  mode: ScheduleChangeMode
): Promise<void> {
  const fn = httpsCallable(functions, "setScheduleChangeMode");
  await fn({ teamId, mode });
}

/**
 * Genomför en schemaändring direkt, utan godkännandesteg. Servern
 * vägrar om teamet står på "request", så läget kan inte kringgås
 * genom att bara anropa den här istället.
 */
async function applyScheduleChangeDirect(args: {
  teamId: string;
  childId: string;
  changes: { startAt: Date; endAt?: Date; takingOverParentId: string }[];
  note?: string;
}): Promise<void> {
  const fn = httpsCallable(functions, "applyScheduleChangeDirect");
  await fn({
    teamId: args.teamId,
    childId: args.childId,
    note: args.note,
    changes: args.changes.map((c) => ({
      startAt: c.startAt.toISOString(),
      endAt: c.endAt ? c.endAt.toISOString() : null,
      takingOverParentId: c.takingOverParentId,
    })),
  });
}

/**
 * Enda ingången för "ändra en dag" från kalendern. Väljer väg utifrån
 * teamets läge, så att anropande UI slipper känna till skillnaden.
 *
 * `endAt` är OBLIGATORISKT: en enkeldagsändring utan slut lagras som en
 * öppen period, och findOverlappingApproved på servern läser det som
 * "pågår i all evighet" — då blockerar en enda godkänd ändring alla
 * framtida datum. Anroparen (app/page.tsx) sätter det till nästa
 * ordinarie byte via getNextOrdinaryHandoff. Gäller BÅDA vägarna nedan
 * (applyScheduleChangeDirect och proposeShiftRequest).
 */
export async function submitShiftChange(args: {
  teamId: string;
  childId: string;
  requestedBy: string;
  takingOverParentId: string;
  startAt: Date;
  endAt: Date;
  note?: string;
  mode: ScheduleChangeMode;
}): Promise<void> {
  if (args.mode === "notify") {
    await applyScheduleChangeDirect({
      teamId: args.teamId,
      childId: args.childId,
      note: args.note,
      changes: [
        {
          startAt: args.startAt,
          endAt: args.endAt,
          takingOverParentId: args.takingOverParentId,
        },
      ],
    });
    return;
  }
  await proposeShiftRequest(args);
}

/**
 * Enda ingången för kalenderns ändringsläge (flera dagar på en gång).
 * Grupperingen i sammanhängande körningar är samma som i
 * proposeShiftRequestBatch — bara målet skiljer.
 */
export async function submitShiftChangeBatch(args: {
  teamId: string;
  childId: string;
  requestedBy: string;
  switchHour: string;
  changes: DayChange[];
  note?: string;
  mode: ScheduleChangeMode;
}): Promise<void> {
  if (args.mode !== "notify") {
    await proposeShiftRequestBatch(args);
    return;
  }
  if (args.changes.length === 0) throw new Error("Inga dagar valda.");

  const runs = groupIntoRuns(args.changes);
  await applyScheduleChangeDirect({
    teamId: args.teamId,
    childId: args.childId,
    note: args.note,
    changes: runs.map((run) => ({
      startAt: atSwitchHour(run.start, args.switchHour),
      endAt: atSwitchHour(addDays(run.end, 1), args.switchHour),
      takingOverParentId: run.takingOverParentId,
    })),
  });
}

/**
 * Svarar på ett förslag om ändrat grundschema eller ändrad bytestid.
 * Godkännande verkställer ändringen på servern.
 */
export async function respondToStructureRequest(args: {
  teamId: string;
  requestId: string;
  decision: "approved" | "declined";
}): Promise<void> {
  const fn = httpsCallable(functions, "respondToStructureRequest");
  await fn(args);
}
