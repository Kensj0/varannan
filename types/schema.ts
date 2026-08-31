/**
 * VARANNAN — Firestore datamodell (NoSQL)
 * ----------------------------------------
 * Alla collections är top-level. Nästan allt kopplas ihop via `teamId`
 * (= "familjen", dvs de två föräldrarna + gemensamma barn).
 *
 * Firestore-paths:
 *   /users/{uid}
 *   /teams/{teamId}
 *   /teams/{teamId}/children/{childId}                (subcollection)
 *   /teams/{teamId}/children/{childId}/childInfo/main  (singleton-doc)
 *   /teams/{teamId}/children/{childId}/accounts/{accountId}
 *   /teams/{teamId}/children/{childId}/custodyCycle/main (singleton-doc)
 *   /teams/{teamId}/children/{childId}/dayBalance/main   (singleton-doc)
 *   /teams/{teamId}/events/{eventId}
 *   /teams/{teamId}/shiftRequests/{shiftRequestId}
 *   /teams/{teamId}/packLists/{packListId}
 *   /teams/{teamId}/notes/{noteId}
 *   /teams/{teamId}/todos/{todoId}
 *   /teams/{teamId}/chatMessages/{messageId}
 */

// ---------------------------------------------------------------------------
// USERS
// ---------------------------------------------------------------------------

export interface UserDoc {
  uid: string;
  displayName: string;
  email: string;
  avatarUrl?: string;
  /** Föräldern hör till exakt ett team i mockupen — null tills onboarding är klar. */
  teamId: string | null;
  /** Google OAuth-token (server-side, via Cloud Functions) för kalendersync. */
  googleCalendar?: {
    connected: boolean;
    calendarId?: string; // vilken av användarens kalendrar vi skriver till
    refreshTokenRef?: string; // referens till hemlighet i Secret Manager, ALDRIG rå token i Firestore
    lastSyncedAt?: FirestoreTimestamp;
  };
  /** Web push-tokens (en per enhet/webbläsare som aktiverat notiser). */
  fcmTokens?: string[];
  /**
   * Påminnelser om överlämning (push), styrs i kalenderns inställnings-
   * panel. Saknas fältet helt = defaultbeteendet (båda på), se
   * DEFAULT_HANDOFF_REMINDER_PREFS.
   */
  handoffReminderPrefs?: {
    dayBefore: boolean;
    sameDay: boolean;
  };
  createdAt: FirestoreTimestamp;
}

/** Default när users/{uid}.handoffReminderPrefs saknas (ny användare). */
export const DEFAULT_HANDOFF_REMINDER_PREFS = { dayBefore: true, sameDay: true } as const;

// ---------------------------------------------------------------------------
// TEAMS (familjen / föräldraparet)
// ---------------------------------------------------------------------------

export interface TeamParentProfile {
  uid: string;
  displayName: string;
  avatarUrl?: string;
  /**
   * Vald schemafärg (id ur PARENT_PALETTE). Saknas = fall tillbaka på
   * platsens standardfärg, så gamla team fortsätter se ut som förut.
   */
  colorId?: ParentColorId;
}

/**
 * Sex färger att välja mellan för föräldrarnas scheman. Hexvärdena är
 * Google Calendars egna kalenderfärger, så att ett exporterat/prenumererat
 * schema ser likadant ut i appen som i Google Calendar.
 */
export const PARENT_PALETTE = [
  { id: "tomato", label: "Tomat", hex: "#D50000" },
  { id: "tangerine", label: "Mandarin", hex: "#F4511E" },
  { id: "banana", label: "Banan", hex: "#F6BF26" },
  { id: "basil", label: "Basilika", hex: "#0B8043" },
  { id: "peacock", label: "Påfågel", hex: "#039BE5" },
  { id: "grape", label: "Vindruva", hex: "#8E24AA" },
] as const;

export type ParentColorId = (typeof PARENT_PALETTE)[number]["id"];

/** Förvald färg per plats i parentIds, när ingen egen färg valts. */
export const DEFAULT_PARENT_COLOR_IDS: ParentColorId[] = ["tomato", "peacock"];

export function parentColorHex(colorId: ParentColorId | undefined, fallbackIndex: number): string {
  const id = colorId ?? DEFAULT_PARENT_COLOR_IDS[fallbackIndex % DEFAULT_PARENT_COLOR_IDS.length];
  return (PARENT_PALETTE.find((c) => c.id === id) ?? PARENT_PALETTE[0]).hex;
}

export interface TeamDoc {
  id: string;
  name: string; // t.ex. "Familjen Sjöstedt"
  parentIds: [string, string] | [string]; // stöd för att bjuda in förälder 2 senare
  /**
   * Cachade namn/avatarer för båda föräldrarna. Finns här eftersom
   * users/{uid} bara är läsbart för ägaren själv (se firestore.rules) —
   * utan den här kopian kan förälder A inte visa förälder B:s namn.
   * Skrivs enbart av Cloud Functions (createFamilyTeam, acceptInvite,
   * syncDisplayNameToTeam).
   */
  parentProfiles: Record<string, TeamParentProfile>;
  childIds: string[];
  /**
   * Hemliga prenumerationstoken per barn för ICS-flödet (se
   * functions/src/calendarFeed.ts). Skrivs bara av Cloud Functions.
   */
  calendarFeedTokens?: Record<string /* childId */, string>;
  createdAt: FirestoreTimestamp;
  createdBy: string;
}

// ---------------------------------------------------------------------------
// CHILDREN
// ---------------------------------------------------------------------------

export interface ChildDoc {
  id: string;
  teamId: string;
  name: string;
  avatarUrl?: string;
  birthYear?: number;
  createdAt: FirestoreTimestamp;
}

/** /children/{childId}/childInfo/main */
export interface ChildInfoDoc {
  clothingSize?: string;
  shoeSize?: string;
  insurance?: string;
  medicalAllergy?: string;
  vaccinations?: string;
  personalNumber?: string; // känsligt fält — se säkerhetsanteckning i README
  passportNumber?: string;
  passportLocation?: string;
  other?: string;
  updatedBy: string;
  updatedAt: FirestoreTimestamp;
}

/** /children/{childId}/accounts/{accountId} — t.ex. streamingtjänster */
export interface ChildAccountDoc {
  id: string;
  service: string; // "Netflix", "Fortnite" etc.
  username?: string;
  pinOrNote?: string;
  addedBy: string;
  createdAt: FirestoreTimestamp;
}

// ---------------------------------------------------------------------------
// CUSTODY CYCLE — den fasta grundcykeln, t.ex. 2/2/3
// ---------------------------------------------------------------------------

/**
 * En cykel är en upprepande sekvens av block. Varje block säger
 * "förälder X har barnet i N dagar". Summan av alla block = cykelns
 * totala längd i dagar. Byten sker på halvdag (switchHour).
 *
 * Exempel 2/2/3:
 *   blocks: [
 *     { parentId: "parentA", days: 2 },
 *     { parentId: "parentB", days: 2 },
 *     { parentId: "parentA", days: 3 },
 *     { parentId: "parentB", days: 2 },
 *     { parentId: "parentA", days: 2 },
 *     { parentId: "parentB", days: 3 },
 *   ]  // klassisk 2-2-3-2-2-3 som totalt blir 14 dagar / vecko-symmetrisk
 */
export interface CustodyCycleBlock {
  parentId: string;
  days: number; // heltal, antal dygn i blocket
}

/**
 * Platshållar-id för en föräldraroll i schemat som ännu inte har en
 * riktig person kopplad — dvs. man har byggt schemat själv innan man
 * bjudit in den andra föräldern. Byts automatiskt ut mot personens
 * riktiga uid när hen accepterar inbjudan (se acceptParentInvite i
 * lib/onboarding.ts), så schemat "aktiveras" utan att behöva byggas om.
 */
export const PENDING_PARTNER_ID = "__pending_partner__";

/** /children/{childId}/custodyCycle/main */
export interface CustodyCycleDoc {
  childId: string;
  blocks: CustodyCycleBlock[];
  /**
   * Datum då block[0] börjar — ankaret för all beräkning.
   *
   * Lagras som ren kalenderdatum-sträng "YYYY-MM-DD", INTE som
   * Timestamp. Ett startdatum för ett återkommande schema är ett
   * datum i en kalender, inte en punkt på tidslinjen: lagrat som
   * Timestamp beror tolkningen på vilken tidszon som råkar vara
   * aktiv där koden körs (webbläsaren i Sverige vs Cloud Functions
   * i UTC), vilket gav olika resultat på klient och server.
   */
  cycleStartDate: string; // "YYYY-MM-DD"
  /** Klockslag på dygnet då bytet sker, t.ex. "12:00" (halvdagsbyte). */
  switchHour: string; // "HH:mm"
  /** Tidszonen switchHour tolkas i, t.ex. "Europe/Stockholm". */
  timezone: string;
  updatedAt: FirestoreTimestamp;
  updatedBy: string;
}

// ---------------------------------------------------------------------------
// SHIFT REQUESTS — "Ändra ansvar"
// ---------------------------------------------------------------------------

export type ShiftRequestStatus = "pending" | "approved" | "declined" | "cancelled";

export interface ShiftRequestDoc {
  id: string;
  teamId: string;
  childId: string;
  requestedBy: string; // uid för föräldern som initierar
  /** Föräldern som TAR ÖVER ansvaret under perioden. */
  takingOverParentId: string;
  startAt: FirestoreTimestamp; // t.ex. 25 Aug 2026 12:00
  /**
   * Grupperar flera shiftRequests som skickades tillsammans i EN
   * "Skicka förslag"-åtgärd (t.ex. flera separata dagar man målat om i
   * kalenderns ändringsläge), så de visas och besvaras som en enhet
   * istället för N separata förfrågningar.
   */
  batchId?: string;
  /**
   * endAt är valfritt. Om null/undefined gäller bytet "fram till nästa
   * ordinarie byte" enligt custodyCycle — dvs det beräknas dynamiskt,
   * precis som texten i appen: "Livia fortsätter att ha ansvaret fram
   * till bytet den 28 Aug 2026".
   */
  endAt?: FirestoreTimestamp;
  handoffMethod?: string; // t.ex. "genom skolan"
  note?: string;
  status: ShiftRequestStatus;
  /** Sätts när status blir "approved" — hur många dagar ställningen ska justeras. */
  balanceDeltaDays?: number;
  respondedBy?: string;
  respondedAt?: FirestoreTimestamp;
  createdAt: FirestoreTimestamp;
}

// ---------------------------------------------------------------------------
// DAY BALANCE — "Ställningen"
// ---------------------------------------------------------------------------

/** /children/{childId}/dayBalance/main */
export interface DayBalanceDoc {
  childId: string;
  /**
   * Signerat värde relativt "referensföräldern" (teams.parentIds[0]).
   * Positivt = referensföräldern har haft barnet fler dagar än den fasta
   * cykeln säger. Negativt = motsatt förälder ligger plus.
   */
  balanceDays: number;
  referenceParentId: string;
  lastShiftRequestId?: string;
  updatedAt: FirestoreTimestamp;
}

/** Append-only historik, användbar för "Ställning"-vyns detaljlista. */
export interface DayBalanceHistoryEntryDoc {
  id: string;
  childId: string;
  shiftRequestId: string;
  deltaDays: number; // +/- justering vid just detta tillfälle
  balanceAfter: number;
  createdAt: FirestoreTimestamp;
}

// ---------------------------------------------------------------------------
// EVENTS — "Aktivitet"
// ---------------------------------------------------------------------------

export interface RecurrenceRule {
  frequency: "daily" | "weekly" | "monthly" | "yearly";
  interval: number; // var N:e period
  byWeekday?: number[]; // 0=söndag ... 6=lördag
  until?: FirestoreTimestamp;
}

export interface EventDoc {
  id: string;
  teamId: string;
  childId?: string; // saknas = familje-gemensam aktivitet
  title: string;
  startAt: FirestoreTimestamp;
  endAt: FirestoreTimestamp;
  recurrence?: RecurrenceRule;
  photoUrl?: string;
  createdBy: string;
  createdAt: FirestoreTimestamp;
  /** Sätts av Cloud Function efter export till Google Calendar. */
  googleEventIds?: Record<string /* uid */, string /* google event id */>;
}

// ---------------------------------------------------------------------------
// PACK LISTS
// ---------------------------------------------------------------------------

export interface PackListItemDoc {
  id: string;
  name: string;
  checked: boolean;
  checkedBy?: string;
}

export interface PackListDoc {
  id: string;
  teamId: string;
  childId: string;
  title: string; // "Barnens Regn/Vinterkläder", "Lovas Gosedjur"
  /** Kopplas till nästa byte — visas i UI:t innan bytet sker. */
  linkedShiftRequestId?: string;
  items: PackListItemDoc[];
  seenBy: string[]; // uids
  createdAt: FirestoreTimestamp;
  updatedAt: FirestoreTimestamp;
}

// ---------------------------------------------------------------------------
// NOTES & TODOS
// ---------------------------------------------------------------------------

export interface NoteDoc {
  id: string;
  teamId: string;
  title: string;
  content: string;
  createdBy: string;
  createdAt: FirestoreTimestamp;
  updatedAt: FirestoreTimestamp;
}

export interface TodoDoc {
  id: string;
  teamId: string;
  title: string;
  done: boolean;
  doneBy?: string;
  doneAt?: FirestoreTimestamp;
  archived: boolean;
  seenBy: string[];
  createdBy: string;
  createdAt: FirestoreTimestamp;
}

// ---------------------------------------------------------------------------
// CHAT
// ---------------------------------------------------------------------------

export interface ChatMessageDoc {
  id: string;
  teamId: string;
  senderId: string;
  text?: string;
  /** Länk till t.ex. en shiftRequest som visas som ett kort i chatten. */
  linkedShiftRequestId?: string;
  createdAt: FirestoreTimestamp;
}

// ---------------------------------------------------------------------------
// Hjälptyp — undviker hård binding mot firebase/firestore i denna fil
// ---------------------------------------------------------------------------

export type FirestoreTimestamp = {
  seconds: number;
  nanoseconds: number;
};
