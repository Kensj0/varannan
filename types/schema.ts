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
  /**
   * Hur DEN HÄR föräldern vill bli inblandad när den andra ändrar
   * schemat. Läget hör till mottagaren, inte till den som ändrar: det
   * är mottagaren som annars skulle behöva godkänna, så det är hen som
   * rimligen bestämmer om det steget behövs.
   *
   * Föräldrarna kan alltså ha olika lägen. A kan kräva förfrågan medan
   * B nöjer sig med en notis — då måste B fråga A om lov, men A kan
   * ändra B:s dagar direkt. Saknas fältet gäller DEFAULT_SCHEDULE_CHANGE_MODE.
   */
  scheduleChangeMode?: ScheduleChangeMode;
}

/**
 * Sex färger att välja mellan för föräldrarnas scheman.
 *
 * Varje färg har TVÅ hexvärden:
 *  - `hex`       — mjuk, ljus ton som appen visar. Google Calendars
 *                  grundfärger (#D50000, #039BE5 …) är gjorda för små
 *                  punkter och blir tunga när de fyller breda staplar,
 *                  så appen använder ett par snäpp ljusare varianter.
 *  - `googleHex` — Google Calendars *egna, omättade* originalfärg för
 *                  samma kulör. Skickas i ICS-flödet (calendarFeed.ts)
 *                  som COLOR/X-APPLE-CALENDAR-COLOR, så att Apple
 *                  Calendar och Outlook automatiskt målar prenumerationen
 *                  i närmaste Google-motsvarighet till appens färg.
 *
 * Google Calendar själv ignorerar COLOR-fältet för prenumererade
 * kalendrar (den färgar per kalender, inte per händelse, och användaren
 * väljer färgen manuellt efter att ha prenumererat) — se kommentaren vid
 * `only`-parametern i calendarFeed.ts. `googleHex` är alltså till för
 * Apple/Outlook; för Google är den bara en referens ("välj ungefär den
 * här färgen") om vi någon gång vill visa det i UI:t.
 */
export const PARENT_PALETTE = [
  { id: "tomato", label: "Tomat", hex: "#E8615E", googleHex: "#D50000" },
  { id: "tangerine", label: "Mandarin", hex: "#F58A5B", googleHex: "#F4511E" },
  { id: "banana", label: "Banan", hex: "#EBC15C", googleHex: "#F6BF26" },
  { id: "basil", label: "Basilika", hex: "#4FA97B", googleHex: "#0B8043" },
  { id: "peacock", label: "Påfågel", hex: "#6FB3E8", googleHex: "#039BE5" },
  { id: "grape", label: "Vindruva", hex: "#A87BC7", googleHex: "#8E24AA" },
] as const;

export type ParentColorId = (typeof PARENT_PALETTE)[number]["id"];

/** Förvald färg per plats i parentIds, när ingen egen färg valts. */
export const DEFAULT_PARENT_COLOR_IDS: ParentColorId[] = ["tomato", "peacock"];

export function parentColorHex(colorId: ParentColorId | undefined, fallbackIndex: number): string {
  const id = colorId ?? DEFAULT_PARENT_COLOR_IDS[fallbackIndex % DEFAULT_PARENT_COLOR_IDS.length];
  return (PARENT_PALETTE.find((c) => c.id === id) ?? PARENT_PALETTE[0]).hex;
}

/**
 * Google Calendars originalfärg för samma kulör som `parentColorHex`.
 * Används av calendarFeed.ts för att sätta COLOR/X-APPLE-CALENDAR-COLOR
 * i ICS-flödet, så Apple Calendar och Outlook målar prenumerationen i
 * närmaste Google-motsvarighet automatiskt.
 */
export function parentColorGoogleHex(colorId: ParentColorId | undefined, fallbackIndex: number): string {
  const id = colorId ?? DEFAULT_PARENT_COLOR_IDS[fallbackIndex % DEFAULT_PARENT_COLOR_IDS.length];
  return (PARENT_PALETTE.find((c) => c.id === id) ?? PARENT_PALETTE[0]).googleHex;
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
  /**
   * Teamgemensamt läge. UTGÅENDE — läget ligger numera per förälder på
   * parentProfiles[uid].scheduleChangeMode. Fältet läses fortfarande som
   * fallback för team som satte det innan flytten, så deras val inte
   * tyst återgår till "request".
   */
  scheduleChangeMode?: ScheduleChangeMode;
  createdAt: FirestoreTimestamp;
  createdBy: string;
}

/**
 * "request" — en ändring blir ett förslag som den andra föräldern måste
 *   godkänna innan det syns i schemat. (Ursprungligt beteende.)
 * "notify"  — ändringen börjar gälla direkt och den andra föräldern får
 *   en notis om att den skett. Ingen godkännandeknapp.
 *
 * Gäller ALLA schemaändringar: enstaka dagar, ändringsläget i kalendern
 * och förskjutning av hela schemat.
 */
export type ScheduleChangeMode = "request" | "notify";

export const DEFAULT_SCHEDULE_CHANGE_MODE: ScheduleChangeMode = "request";

/**
 * Vilket läge gäller för ändringar av `parentId`s dagar? Slår upp
 * förälderns eget val, och faller tillbaka på teamets gamla gemensamma
 * inställning innan den blev individuell.
 */
export function scheduleChangeModeFor(
  team: { scheduleChangeMode?: ScheduleChangeMode; parentProfiles?: Record<string, TeamParentProfile> } | null | undefined,
  parentId: string | undefined,
): ScheduleChangeMode {
  if (!team || !parentId) return DEFAULT_SCHEDULE_CHANGE_MODE;
  return (
    team.parentProfiles?.[parentId]?.scheduleChangeMode ??
    team.scheduleChangeMode ??
    DEFAULT_SCHEDULE_CHANGE_MODE
  );
}

export const SCHEDULE_CHANGE_MODES: {
  id: ScheduleChangeMode;
  label: string;
  description: string;
}[] = [
  {
    id: "request",
    label: "Förfrågan",
    description: "Du vill godkänna ändringar av dina dagar innan de gäller.",
  },
  {
    id: "notify",
    label: "Notifiering",
    description: "Ändringar av dina dagar gäller direkt. Du får en notis.",
  },
];

// ---------------------------------------------------------------------------
// CHILDREN
// ---------------------------------------------------------------------------

export interface ChildDoc {
  id: string;
  teamId: string;
  name: string;
  avatarUrl?: string;
  birthYear?: number;
  /**
   * Vilka föräldrar som delar DEN HÄR kalendern.
   *
   * Delningen sitter på barnet, inte på teamet: kalendern ÄR barnet, och
   * allt som hör till barnet (schema, chatt, listor, barninfo) delas med
   * exakt de här personerna. Att lämna en kalender tar därför bort den
   * bara för en själv — den andra föräldern behåller sin och kan bjuda
   * in någon ny i stället.
   *
   * Saknas fältet gäller teamets parentIds, så kalendrar som skapades
   * innan delningen flyttades hit fortsätter fungera oförändrat.
   */
  parentIds?: string[];
  createdAt: FirestoreTimestamp;
}

/** Vilka föräldrar delar kalendern? Faller tillbaka på teamets. */
export function calendarParentIds(
  child: { parentIds?: string[] } | null | undefined,
  team: { parentIds?: string[] } | null | undefined,
): string[] {
  const own = child?.parentIds;
  if (own && own.length > 0) return own;
  return team?.parentIds ?? [];
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

/**
 * /children/{childId}/balanceRequests/{id}
 *
 * En begäran om att justera ställningen utan att flytta specifika dagar —
 * t.ex. när föräldrarna kommit överens muntligt om att kvitta några dagar.
 * Kräver motpartens godkännande, precis som ett dagbyte, eftersom
 * ställningen annars skulle kunna skrivas om ensidigt.
 */
export interface BalanceRequestDoc {
  id: string;
  teamId: string;
  childId: string;
  requestedBy: string;
  /** Signerat mot referensföräldern, samma konvention som DayBalanceDoc. */
  deltaDays: number;
  note?: string;
  status: ShiftRequestStatus;
  respondedBy?: string;
  respondedAt?: FirestoreTimestamp;
  createdAt: FirestoreTimestamp;
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
  /** Vilken kalender anteckningen hör till. Saknas = äldre, teamgemensam. */
  childId?: string;
  title: string;
  content: string;
  createdBy: string;
  createdAt: FirestoreTimestamp;
  updatedAt: FirestoreTimestamp;
}

export interface TodoDoc {
  id: string;
  teamId: string;
  /** Vilken kalender uppgiften hör till. Saknas = äldre, teamgemensam. */
  childId?: string;
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
  /** Vilken kalender meddelandet hör till. Saknas = äldre, teamgemensamt. */
  childId?: string;
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
