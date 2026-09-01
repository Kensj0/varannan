import { httpsCallable } from "firebase/functions";
import { doc, setDoc, collection, updateDoc, arrayUnion } from "firebase/firestore";
import { functions, db } from "./firebase";
import { CustodyCycleBlock, ChildDoc } from "../types/schema";

/**
 * team/invite/cykel går via Cloud Functions eftersom firestore.rules
 * medvetet blockerar de skrivningarna från klienten (se README-avsnittet
 * "Säkerhet"). addChild går DIREKT mot Firestore eftersom rules redan
 * tillåter teammedlemmar att skriva i children-subkollektionen.
 */

export async function createFamilyTeam(teamName: string): Promise<{ teamId: string }> {
  const fn = httpsCallable<{ teamName: string }, { teamId: string }>(functions, "createFamilyTeam");
  const res = await fn({ teamName });
  return res.data;
}

export async function createInvite(teamId: string): Promise<{ code: string; expiresAt: string; shareUrl: string }> {
  const fn = httpsCallable(functions, "createInvite");
  // Servern validerar origin mot ALLOWED_APP_ORIGINS och faller tillbaka
  // på ett känt värde om det inte matchar — se functions/src/index.ts.
  const baseUrl = typeof window !== "undefined" ? window.location.origin : undefined;
  const res = await fn({ teamId, baseUrl });
  return res.data as any;
}

export async function acceptInvite(code: string): Promise<{ teamId: string }> {
  const fn = httpsCallable<{ code: string }, { teamId: string }>(functions, "acceptInvite");
  const res = await fn({ code });
  return res.data;
}

export async function repairPendingPartner(teamId: string): Promise<{ repaired: number }> {
  const fn = httpsCallable<{ teamId: string }, { repaired: number }>(functions, "repairPendingPartner");
  const res = await fn({ teamId });
  return res.data;
}

export async function addChild(teamId: string, name: string, birthYear?: number): Promise<{ childId: string }> {
  const ref = doc(collection(db, `teams/${teamId}/children`));
  const childDoc: ChildDoc = {
    id: ref.id,
    teamId,
    name,
    createdAt: { seconds: Math.floor(Date.now() / 1000), nanoseconds: 0 },
    // Firestores webb-SDK kastar fel på `undefined`-fält (till skillnad
    // från Admin SDK), så birthYear inkluderas bara när det faktiskt
    // angetts — annars kraschar setDoc när fältet lämnas tomt.
    ...(birthYear !== undefined ? { birthYear } : {}),
  };
  await setDoc(ref, childDoc);
  // Håll team.childIds i synk. sendHandoffReminders läser det fältet för
  // att veta vilka barn som finns, så utan detta skickades aldrig några
  // överlämningspåminnelser för barn som lagts till från klienten.
  await updateDoc(doc(db, `teams/${teamId}`), { childIds: arrayUnion(ref.id) });
  return { childId: ref.id };
}

export async function saveCustodyCycle(args: {
  teamId: string;
  childId: string;
  blocks: CustodyCycleBlock[];
  cycleStartDate: string; // "YYYY-MM-DD"
  switchHour: string;
  referenceParentId: string;
}): Promise<void> {
  const fn = httpsCallable(functions, "saveCustodyCycle");
  await fn({
    teamId: args.teamId,
    childId: args.childId,
    blocks: args.blocks,
    cycleStartDate: args.cycleStartDate,
    switchHour: args.switchHour,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    referenceParentId: args.referenceParentId,
  });
}
