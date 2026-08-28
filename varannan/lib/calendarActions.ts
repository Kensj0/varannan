import { collection, doc, setDoc, Timestamp } from "firebase/firestore";
import { httpsCallable } from "firebase/functions";
import { db, functions } from "./firebase";
import { sendChatMessage } from "./chatActions";
import { EventDoc, ShiftRequestDoc, RecurrenceRule } from "../types/schema";

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
    recurrence: args.recurrence,
    createdBy: args.createdBy,
    createdAt: Timestamp.now() as any,
  };
  await setDoc(ref, event);
  return ref.id;
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
  const request: ShiftRequestDoc = {
    id: ref.id,
    teamId: args.teamId,
    childId: args.childId,
    requestedBy: args.requestedBy,
    takingOverParentId: args.takingOverParentId,
    startAt: Timestamp.fromDate(args.startAt) as any,
    endAt: args.endAt ? (Timestamp.fromDate(args.endAt) as any) : undefined,
    handoffMethod: args.handoffMethod,
    note: args.note,
    status: "pending",
    createdAt: Timestamp.now() as any,
  };
  await setDoc(ref, request);

  // Lägg in förfrågan i chatten också, så båda föräldrarna har hela
  // historiken över förfrågningar och godkännanden på ett ställe.
  await sendChatMessage({
    teamId: args.teamId,
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
