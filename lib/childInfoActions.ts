import { collection, doc, setDoc, deleteDoc, Timestamp } from "firebase/firestore";
import { db } from "./firebase";
import { ChildInfoDoc, ChildAccountDoc } from "../types/schema";

/**
 * Skrivningar för Barninfo och Konton.
 *
 * SÄKERHET: de här dokumenten innehåller personnummer, passnummer,
 * medicinsk information och inloggningsuppgifter. De skyddas av
 * firestore.rules (endast teamets föräldrar) och är avindexerade i
 * firestore.indexes.json så att de aldrig blir sökbara.
 *
 * Firestore krypterar allt at-rest som standard, men Anthropics
 * rekommendation för produktion är att dessutom kryptera pinOrNote och
 * personalNumber klient-side med en nyckel som ligger utanför
 * databasen — då skyddas de även mot en felkonfigurerad regel eller en
 * läckt admin-nyckel. Det är INTE implementerat här (mockup).
 */

// ---------------------------------------------------------------------------
// Barninfo
// ---------------------------------------------------------------------------

/**
 * Uppdaterar ett eller flera fält. Använder merge så att ett fält kan
 * sparas utan att de andra skrivs över — formuläret sparar per rad.
 */
export async function updateChildInfo(
  teamId: string,
  childId: string,
  patch: Partial<Omit<ChildInfoDoc, "updatedBy" | "updatedAt">>,
  updatedBy: string
): Promise<void> {
  await setDoc(
    doc(db, `teams/${teamId}/children/${childId}/childInfo/main`),
    { ...patch, updatedBy, updatedAt: Timestamp.now() },
    { merge: true }
  );
}

/** Tömmer ett enskilt fält (t.ex. om man vill ta bort personnumret igen). */
export async function clearChildInfoField(
  teamId: string,
  childId: string,
  field: keyof ChildInfoDoc,
  updatedBy: string
): Promise<void> {
  await setDoc(
    doc(db, `teams/${teamId}/children/${childId}/childInfo/main`),
    { [field]: "", updatedBy, updatedAt: Timestamp.now() },
    { merge: true }
  );
}

// ---------------------------------------------------------------------------
// Delade konton
// ---------------------------------------------------------------------------

export async function createChildAccount(args: {
  teamId: string;
  childId: string;
  service: string;
  username?: string;
  pinOrNote?: string;
  addedBy: string;
}): Promise<string> {
  const ref = doc(collection(db, `teams/${args.teamId}/children/${args.childId}/accounts`));
  const account: ChildAccountDoc = {
    id: ref.id,
    service: args.service,
    username: args.username,
    pinOrNote: args.pinOrNote,
    addedBy: args.addedBy,
    createdAt: Timestamp.now() as any,
  };
  await setDoc(ref, account);
  return ref.id;
}

export async function updateChildAccount(
  teamId: string,
  childId: string,
  accountId: string,
  patch: Partial<Pick<ChildAccountDoc, "service" | "username" | "pinOrNote">>
): Promise<void> {
  await setDoc(doc(db, `teams/${teamId}/children/${childId}/accounts/${accountId}`), patch, { merge: true });
}

export async function deleteChildAccount(teamId: string, childId: string, accountId: string): Promise<void> {
  await deleteDoc(doc(db, `teams/${teamId}/children/${childId}/accounts/${accountId}`));
}
