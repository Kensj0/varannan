/**
 * onboarding.ts
 * -------------
 * Allt en ny användare går igenom EN gång: skapa familjen (teamet),
 * bjuda in andra föräldern, lägga till barn och sätta upp den fasta
 * cykeln (t.ex. 2/2/3) för varje barn.
 *
 * Precis som i shiftRequests.ts hålls Firestore-anropen bakom ett
 * litet interface, så filen kan testas utan en riktig Firebase-app.
 */

import {
  TeamDoc,
  TeamParentProfile,
  UserDoc,
  ChildDoc,
  CustodyCycleDoc,
  CustodyCycleBlock,
  DayBalanceDoc,
} from "../types/schema";

export interface OnboardingFirestore {
  createTeam(doc: Omit<TeamDoc, "id">): Promise<string>;
  updateUser(uid: string, patch: Partial<UserDoc>): Promise<void>;
  createInvite(teamId: string, code: string, expiresAt: Date): Promise<void>;
  /** Läser en inbjudan utan att förbruka den (för förhandskontroller). */
  peekInvite(code: string): Promise<{ teamId: string } | null>;
  consumeInvite(code: string): Promise<{ teamId: string } | null>;
  getTeam(teamId: string): Promise<TeamDoc | null>;
  addParentToTeam(teamId: string, uid: string, profile: TeamParentProfile): Promise<void>;
  createChild(doc: Omit<ChildDoc, "id">): Promise<string>;
  writeCustodyCycle(teamId: string, childId: string, doc: CustodyCycleDoc): Promise<void>;
  initDayBalance(teamId: string, childId: string, doc: DayBalanceDoc): Promise<void>;
}

// ---------------------------------------------------------------------------
// Steg 1: skapa familjen
// ---------------------------------------------------------------------------

export async function createTeam(
  db: OnboardingFirestore,
  args: { creatorUid: string; teamName: string; creatorProfile: TeamParentProfile }
): Promise<string> {
  const teamId = await db.createTeam({
    name: args.teamName,
    parentIds: [args.creatorUid],
    parentProfiles: { [args.creatorUid]: args.creatorProfile },
    childIds: [],
    createdAt: nowTs(),
    createdBy: args.creatorUid,
  });
  await db.updateUser(args.creatorUid, { teamId });
  return teamId;
}

// ---------------------------------------------------------------------------
// Steg 2: bjud in andra föräldern
// ---------------------------------------------------------------------------

const INVITE_TTL_HOURS = 72;

export async function createParentInvite(
  db: OnboardingFirestore,
  teamId: string,
  /** Appens publika adress, t.ex. "https://ert-projekt.web.app". */
  baseUrl: string
): Promise<{ code: string; expiresAt: Date; shareUrl: string }> {
  const code = generateInviteCode();
  const expiresAt = new Date(Date.now() + INVITE_TTL_HOURS * 60 * 60 * 1000);
  await db.createInvite(teamId, code, expiresAt);
  return {
    code,
    expiresAt,
    shareUrl: `${baseUrl.replace(/\/$/, "")}/join/${encodeURIComponent(code)}`,
  };
}

/**
 * Körs när förälder 2 klickar på inbjudningslänken och är inloggad.
 *
 * Kontrollerar att teamet inte redan är fullt: ett team är avsett för
 * exakt två föräldrar, och utan den kontrollen kunde en tredje person
 * med en läckt kod ansluta och läsa barnens personnummer.
 */
export async function acceptParentInvite(
  db: OnboardingFirestore,
  args: { uid: string; code: string; profile: TeamParentProfile }
): Promise<{ teamId: string } | { error: "invalid_or_expired" | "team_full" | "already_member" }> {
  const peeked = await db.peekInvite(args.code);
  if (!peeked) return { error: "invalid_or_expired" };

  const team = await db.getTeam(peeked.teamId);
  if (!team) return { error: "invalid_or_expired" };

  if (team.parentIds.includes(args.uid)) {
    // Redan medlem — konsumera inte koden, bara släpp in personen.
    return { teamId: peeked.teamId };
  }
  if (team.parentIds.length >= 2) {
    return { error: "team_full" };
  }

  // Konsumera koden först nu, när vi vet att anslutningen kan gå igenom.
  const consumed = await db.consumeInvite(args.code);
  if (!consumed) return { error: "invalid_or_expired" };

  await db.addParentToTeam(consumed.teamId, args.uid, args.profile);
  await db.updateUser(args.uid, { teamId: consumed.teamId });
  return { teamId: consumed.teamId };
}

// ---------------------------------------------------------------------------
// Steg 3: lägg till barn
// ---------------------------------------------------------------------------

export async function addChild(
  db: OnboardingFirestore,
  args: { teamId: string; name: string; birthYear?: number }
): Promise<string> {
  const childId = await db.createChild({
    teamId: args.teamId,
    name: args.name,
    birthYear: args.birthYear,
    createdAt: nowTs(),
  });
  return childId;
}

// ---------------------------------------------------------------------------
// Steg 4: sätt upp den fasta cykeln, t.ex. 2/2/3, + nollställ ställningen
// ---------------------------------------------------------------------------

export interface SetupCustodyCycleInput {
  teamId: string;
  childId: string;
  blocks: CustodyCycleBlock[]; // t.ex. [{parentId:"A",days:2},{parentId:"B",days:2},{parentId:"A",days:3},...]
  cycleStartDate: string; // "YYYY-MM-DD"
  switchHour: string; // "12:00"
  timezone: string; // "Europe/Stockholm"
  referenceParentId: string;
  updatedBy: string;
}

export function validateCustodyCycleBlocks(blocks: CustodyCycleBlock[]): string | null {
  if (blocks.length === 0) return "Cykeln måste ha minst ett block.";
  if (blocks.some((b) => b.days <= 0 || !Number.isInteger(b.days))) {
    return "Varje block måste vara ett helt antal dagar (minst 1).";
  }
  const parentIds = new Set(blocks.map((b) => b.parentId));
  if (parentIds.size < 2) {
    return "Cykeln bör innehålla båda föräldrarna — annars behövs inget schema.";
  }
  return null;
}

export async function setupCustodyCycle(db: OnboardingFirestore, input: SetupCustodyCycleInput): Promise<void> {
  const validationError = validateCustodyCycleBlocks(input.blocks);
  if (validationError) throw new Error(validationError);

  await db.writeCustodyCycle(input.teamId, input.childId, {
    childId: input.childId,
    blocks: input.blocks,
    cycleStartDate: input.cycleStartDate,
    switchHour: input.switchHour,
    timezone: input.timezone,
    updatedAt: nowTs(),
    updatedBy: input.updatedBy,
  });

  await db.initDayBalance(input.teamId, input.childId, {
    childId: input.childId,
    balanceDays: 0,
    referenceParentId: input.referenceParentId,
    updatedAt: nowTs(),
  });
}

/** Vanliga färdiga mönster att erbjuda i UI:t, så man slipper bygga från noll. */
export const CYCLE_PRESET_LIST: { label: string; pattern: number[] }[] = [
  { label: "Varannan vecka (7/7)", pattern: [7, 7] },
  { label: "2-2-3", pattern: [2, 2, 3, 2, 2, 3] },
  { label: "2-2-5-5", pattern: [2, 2, 5, 5] },
  { label: "3-4-4-3", pattern: [3, 4, 4, 3] },
];

/** Bygger blocks[] från ett mönster + vilken förälder som börjar. */
export function blocksFromPattern(pattern: number[], firstParentId: string, secondParentId: string): CustodyCycleBlock[] {
  return pattern.map((days, i) => ({
    parentId: i % 2 === 0 ? firstParentId : secondParentId,
    days,
  }));
}

// ---------------------------------------------------------------------------
// Hjälpfunktioner
// ---------------------------------------------------------------------------

/**
 * Inbjudningskoden är i praktiken en nyckel till familjens ALLA uppgifter
 * — inklusive barnens personnummer. Därför:
 *
 *  - 10 tecken ur ett 31-teckens alfabet (~10^15 kombinationer) istället
 *    för 6 (~10^9, vilket är gissningsbart med automatik).
 *  - Kryptografiskt säker slump, inte Math.random() (som är förutsägbar
 *    om man sett tidigare värden).
 *  - Grupperas som ABCDE-FGHIJ för att vara läsbar att skriva av.
 *
 * Servern begränsar dessutom antal försök, se acceptInvite i functions.
 */
const INVITE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // utan I, L, O, 0, 1
const INVITE_CODE_LENGTH = 10;

function randomBytes(count: number): Uint8Array {
  const bytes = new Uint8Array(count);
  const cryptoObj: any =
    (typeof globalThis !== "undefined" && (globalThis as any).crypto) || undefined;

  if (cryptoObj?.getRandomValues) {
    cryptoObj.getRandomValues(bytes);
    return bytes;
  }
  // Node utan global crypto (äldre runtimes)
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const nodeCrypto = require("crypto");
  return new Uint8Array(nodeCrypto.randomBytes(count));
}

export function generateInviteCode(): string {
  // Avvisa värden i det sista ofullständiga intervallet, så fördelningen
  // över alfabetet blir jämn (modulo-bias undviks).
  const limit = 256 - (256 % INVITE_ALPHABET.length);
  const chars: string[] = [];

  while (chars.length < INVITE_CODE_LENGTH) {
    for (const byte of randomBytes(INVITE_CODE_LENGTH)) {
      if (byte < limit) {
        chars.push(INVITE_ALPHABET[byte % INVITE_ALPHABET.length]);
        if (chars.length === INVITE_CODE_LENGTH) break;
      }
    }
  }

  const code = chars.join("");
  return `${code.slice(0, 5)}-${code.slice(5)}`;
}

function toTs(date: Date): { seconds: number; nanoseconds: number } {
  const ms = date.getTime();
  return { seconds: Math.floor(ms / 1000), nanoseconds: (ms % 1000) * 1e6 };
}

function nowTs(): { seconds: number; nanoseconds: number } {
  return toTs(new Date());
}
