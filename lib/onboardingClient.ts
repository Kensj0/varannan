import { httpsCallable } from "firebase/functions";
import { functions } from "./firebase";
import { CustodyCycleBlock } from "../types/schema";

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

/**
 * Lägger till ett barn (= en kalender). Går via callable eftersom
 * skapandet också måste uppdatera teams/{teamId}.childIds, och
 * team-dokumentet är låst för klientskrivningar i firestore.rules.
 * sendHandoffReminders läser childIds för att veta vilka barn som
 * finns, så de två skrivningarna måste ske ihop.
 */
export async function addChild(
  teamId: string,
  name: string,
  birthYear?: number
): Promise<{ childId: string }> {
  const fn = httpsCallable<
    { teamId: string; name: string; birthYear?: number },
    { childId: string }
  >(functions, "addChild");
  const res = await fn({ teamId, name, ...(birthYear !== undefined ? { birthYear } : {}) });
  return res.data;
}

/** Byter namn på en kalender (= barnets namn). */
export async function renameChild(
  teamId: string,
  childId: string,
  name: string
): Promise<void> {
  const fn = httpsCallable(functions, "renameChild");
  await fn({ teamId, childId, name });
}

/**
 * Tar bort en kalender med allt som hänger på den (schema, ställning,
 * barninfo, konton, byten). Servern vägrar ta bort den sista kalendern.
 */
export async function deleteChild(teamId: string, childId: string): Promise<void> {
  const fn = httpsCallable(functions, "deleteChild");
  await fn({ teamId, childId });
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
