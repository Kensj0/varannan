import { httpsCallable } from "firebase/functions";
import { functions } from "./firebase";
import { CalendarRole, CustodyCycleBlock } from "../types/schema";

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
 * Lämnar en kalender (finns kvar hos övriga medlemmar), eller — om man
 * är den sista medlemmen av VILKEN roll som helst — raderar den helt
 * med allt som hänger på den (schema, ställning, barninfo, konton,
 * byten). Kräver bokstavlig text "RADERA" som bekräftelse, samma
 * mönster som deleteMyAccount.
 */
export async function deleteChild(
  teamId: string,
  childId: string,
  confirmation: string
): Promise<void> {
  const fn = httpsCallable(functions, "deleteChild");
  await fn({ teamId, childId, confirmation });
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

/**
 * Bjuder in någon till EN kalender. Används när man redan har en
 * kalender och vill dela just den — t.ex. efter att den andra föräldern
 * lämnat och man vill koppla på någon ny på samma schema (role
 * "parent", oförändrat — inget godkännande krävs), eller för att bjuda
 * in en anhörig/utomstående (role "relative"/"viewer", kräver
 * invitedEmail och kalenderns föräldrars godkännande — etapp 2, se
 * docs/roller-och-medlemskap.md).
 *
 * shareUrl är null när svaret är "pending_approval" — koden mailas
 * inte till den inbjudna förrän alla nödvändiga föräldrar godkänt.
 */
export async function createCalendarInvite(
  teamId: string,
  childId: string,
  options?: { role?: CalendarRole; invitedEmail?: string }
): Promise<{
  code: string;
  expiresAt: string;
  shareUrl: string | null;
  status: "sent" | "pending_approval";
}> {
  const fn = httpsCallable(functions, "createCalendarInvite");
  const baseUrl = typeof window !== "undefined" ? window.location.origin : undefined;
  const res = await fn({
    teamId,
    childId,
    baseUrl,
    ...(options?.role ? { role: options.role } : {}),
    ...(options?.invitedEmail ? { invitedEmail: options.invitedEmail } : {}),
  });
  return res.data as any;
}

/** Ansluter till en kalender via en kalenderscopad inbjudningskod. */
export async function acceptCalendarInvite(
  code: string
): Promise<{ teamId: string; childId: string }> {
  const fn = httpsCallable<{ code: string }, { teamId: string; childId: string }>(
    functions,
    "acceptCalendarInvite"
  );
  const res = await fn({ code });
  return res.data;
}

/**
 * En förälder på kalendern godkänner (eller nekar) en väntande
 * anhörig/utomstående-inbjudan. Se approveCalendarInvite i
 * functions/src/index.ts.
 */
export async function respondToCalendarInvite(
  code: string,
  decision: "approve" | "decline"
): Promise<{ status: "pending_approval" | "sent" | "expired" }> {
  const fn = httpsCallable<
    { code: string; decision: "approve" | "decline" },
    { status: "pending_approval" | "sent" | "expired" }
  >(functions, "approveCalendarInvite");
  const res = await fn({ code, decision });
  return res.data;
}

export interface MyCalendar {
  teamId: string;
  childId: string;
  childName: string;
  role: CalendarRole;
  /** uid -> visningsnamn, bara för kalenderns föräldrar. */
  parentNames: Record<string, string>;
  /** Alla medlemmar (alla roller) — styr "lämna" vs. "radera helt". */
  memberCount: number;
}

/**
 * Vilka kalendrar är jag anhörig/utomstående (eller förälder) till, i
 * ALLA familjer — inte bara mitt eget users/{uid}.teamId. Behövs
 * eftersom en anhörig aldrig får det fältet satt (se
 * acceptCalendarInvite). Se getMyCalendars i functions/src/index.ts.
 */
export async function getMyCalendars(): Promise<MyCalendar[]> {
  const fn = httpsCallable<void, { calendars: MyCalendar[] }>(functions, "getMyCalendars");
  const res = await fn();
  return res.data.calendars;
}

/**
 * Permanent radering av det egna kontot — se deleteMyAccount i
 * functions/src/index.ts för exakt vad som händer (lämnar delade
 * kalendrar, raderar egenägda, tar bort Auth-kontot sist). Servern
 * kräver samma bekräftelsetext som dialogen redan validerat, som
 * försvar i djupled.
 */
export async function deleteMyAccount(): Promise<void> {
  const fn = httpsCallable<{ confirmation: string }, { ok: boolean }>(functions, "deleteMyAccount");
  await fn({ confirmation: "RADERA" });
}
