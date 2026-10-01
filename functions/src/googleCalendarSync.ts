/**
 * googleCalendarSync.ts
 * ---------------------
 * Frivillig koppling till Google Kalender via OAuth. Skriver
 * ansvarsblock och aktiviteter till en EGEN, separat kalender per
 * Varannan-kalender i användarens Google-konto ("Lova – Varannan").
 * Rör aldrig användarens övriga kalendrar.
 *
 * Finns parallellt med ICS-prenumerationen (calendarFeed.ts), som är
 * kvar som den stabila basen. Skillnaden: här kan vi aktivt ta bort och
 * ändra händelser, och färga varje ansvarsblock i förälderns färg —
 * något en ICS-prenumeration aldrig kan i Google.
 *
 * FLÖDE
 *   1. Klienten anropar startGoogleCalendarConnect → får en URL till
 *      Googles samtyckesfönster. `state` sparas i oauthStates/{state}
 *      (kopplar svaret till rätt uid, skyddar mot CSRF, giltig 10 min).
 *   2. Google skickar tillbaka till https://varannan.se/oauth/google/callback
 *      (Hosting-rewrite → googleCalendarOAuthCallback). Funktionen byter
 *      koden mot en refresh-token, sparar den i googleCalendarTokens/{uid},
 *      kör en första synk och skickar användaren tillbaka till appen.
 *   3. Synk körs sedan vid ändringar (triggers längst ner) och varje natt.
 *   4. disconnectGoogleCalendar tar bort Varannan-kalendrarna i Google,
 *      återkallar token hos Google och raderar den hos oss.
 *
 * SÄKERHET — integritetspolicyn (app/integritetspolicy/page.tsx) lovar
 * följande, håll det sant:
 *   - Token ligger i googleCalendarTokens/{uid}. firestore.rules saknar
 *     match för den samlingen = nekad för all klientåtkomst. Bara Admin
 *     SDK (här) läser den. Lägg ALDRIG token på users/{uid}, som klienten
 *     läser.
 *   - Koppla bort = token raderas OCH återkallas hos Google.
 *
 * KRÄVER (en gång, se docs/google-calendar-sync.md):
 *   firebase functions:secrets:set GOOGLE_OAUTH_CLIENT_ID
 *   firebase functions:secrets:set GOOGLE_OAUTH_CLIENT_SECRET
 *   + redirect-URI:n registrerad på OAuth-klienten i Google Cloud Console.
 *
 * Använder REST via fetch i stället för `googleapis` (4 MB, dyr kallstart).
 */

import * as admin from "firebase-admin";
import * as crypto from "crypto";
import { defineSecret } from "firebase-functions/params";
import { onCall, onRequest, HttpsError } from "firebase-functions/v2/https";
import { onDocumentWritten } from "firebase-functions/v2/firestore";
import { onSchedule } from "firebase-functions/v2/scheduler";
import {
  ChildDoc,
  CustodyCycleDoc,
  EventDoc,
  ShiftRequestDoc,
  TeamParentProfile,
  DEFAULT_PARENT_COLOR_IDS,
  ParentColorId,
} from "../../types/schema";
import { switchInstantForDate } from "../../lib/custodyCycle";
import { resolveResponsibleParent } from "../../lib/handoffPreview";
import { expandEvents } from "../../lib/recurrence";

export const GOOGLE_OAUTH_CLIENT_ID = defineSecret("GOOGLE_OAUTH_CLIENT_ID");
export const GOOGLE_OAUTH_CLIENT_SECRET = defineSecret("GOOGLE_OAUTH_CLIENT_SECRET");
const OAUTH_SECRETS = [GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET];

/** Webbplatsen användaren kommer från och skickas tillbaka till. */
const APP_ORIGIN = "https://varannan.se";
/** Måste stå EXAKT så under "Authorized redirect URIs" på OAuth-klienten. */
const REDIRECT_URI = `${APP_ORIGIN}/oauth/google/callback`;
const CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar";
const CAL_API = "https://www.googleapis.com/calendar/v3";

/**
 * Triggers, schemajobb och callbacken ligger i us-central1, samma skäl
 * som övriga triggers/schemajobb i projektet (Eventarc/Cloud Scheduler,
 * se index.ts och handoffReminders.ts) — och Hosting-rewriten för
 * callbacken pekar hit. Callables följer default (europe-north1).
 */
const BACKGROUND_REGION = "us-central1";

/** Samma fönster som ICS-flödet: 3 månader bak, 12 fram. */
const MONTHS_BACK = 3;
const MONTHS_FORWARD = 12;

/** Varannans färg-id:n heter som Googles händelsefärger — mappa till Googles colorId. */
const GOOGLE_EVENT_COLOR_ID: Record<ParentColorId, string> = {
  grape: "3",
  banana: "5",
  tangerine: "6",
  peacock: "7",
  basil: "10",
  tomato: "11",
};

interface TokenDoc {
  refreshToken: string;
  connectedAt: admin.firestore.Timestamp;
  /** childPath ("teamId/childId") → Google-kalenderns id + namnet den skapades med. */
  calendars?: Record<string, { googleCalendarId: string; name: string }>;
}

interface DesiredEntry {
  /** Stabil nyckel för en händelse — sparas i extendedProperties och avgör Google-id:t. */
  key: string;
  summary: string;
  start: Date;
  end: Date;
  colorId?: string;
  /** Ansvarsblock blockerar inte tid ("ledig"); aktiviteter gör det. */
  transparent: boolean;
}

// ---------------------------------------------------------------------------
// 1. Starta kopplingen
// ---------------------------------------------------------------------------

export const startGoogleCalendarConnect = onCall({ secrets: [GOOGLE_OAUTH_CLIENT_ID] }, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Du måste vara inloggad.");

  const db = admin.firestore();
  const state = crypto.randomBytes(24).toString("base64url");
  await db.doc(`oauthStates/${state}`).set({
    uid,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    expiresAt: admin.firestore.Timestamp.fromMillis(Date.now() + 10 * 60 * 1000),
  });

  const params = new URLSearchParams({
    client_id: GOOGLE_OAUTH_CLIENT_ID.value(),
    redirect_uri: REDIRECT_URI,
    response_type: "code",
    scope: CALENDAR_SCOPE,
    // offline + consent: krävs för att Google ska ge en refresh-token,
    // även om användaren kopplat förut.
    access_type: "offline",
    prompt: "consent",
    state,
    ...(request.auth?.token?.email ? { login_hint: String(request.auth.token.email) } : {}),
  });
  return { url: `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}` };
});

// ---------------------------------------------------------------------------
// 2. Google skickar tillbaka hit
// ---------------------------------------------------------------------------

export const googleCalendarOAuthCallback = onRequest(
  {
    region: BACKGROUND_REGION,
    // Användarens webbläsare kommer hit via Hosting-rewriten, oinloggad
    // i Cloud Runs mening. Skyddet är `state` (engångs, kopplat till uid).
    invoker: "public",
    secrets: OAUTH_SECRETS,
    timeoutSeconds: 120,
  },
  async (req, res) => {
    const back = (result: string) => res.redirect(302, `${APP_ORIGIN}/?google=${result}`);

    const state = String(req.query.state ?? "");
    const code = String(req.query.code ?? "");
    const googleError = req.query.error ? String(req.query.error) : null;

    const db = admin.firestore();
    if (!state) return back("error");
    const stateRef = db.doc(`oauthStates/${state}`);
    const stateSnap = await stateRef.get();
    // Engångs: ta bort direkt, oavsett utfall.
    await stateRef.delete().catch(() => undefined);
    const stateData = stateSnap.data();
    if (!stateSnap.exists || !stateData?.uid || stateData.expiresAt?.toMillis() < Date.now()) {
      return back("error");
    }
    if (googleError) return back(googleError === "access_denied" ? "denied" : "error");
    if (!code) return back("error");

    const uid: string = stateData.uid;
    try {
      const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          code,
          client_id: GOOGLE_OAUTH_CLIENT_ID.value(),
          client_secret: GOOGLE_OAUTH_CLIENT_SECRET.value(),
          redirect_uri: REDIRECT_URI,
          grant_type: "authorization_code",
        }),
      });
      const tokens = (await tokenRes.json()) as { refresh_token?: string; scope?: string; error?: string };
      if (!tokenRes.ok || !tokens.refresh_token) {
        console.error("Tokenbytet misslyckades", tokenRes.status, tokens.error);
        return back("error");
      }
      // Användaren kan bocka ur kalender-rättigheten i samtyckesfönstret.
      if (!String(tokens.scope ?? "").split(" ").includes(CALENDAR_SCOPE)) {
        await revokeToken(tokens.refresh_token);
        return back("scope");
      }

      // Byte av konto/återkoppling: rensa ev. gammal koppling först, så
      // vi inte lämnar en föräldralös token eller dubbla kalendrar.
      const tokenRef = db.doc(`googleCalendarTokens/${uid}`);
      const previous = (await tokenRef.get()).data() as TokenDoc | undefined;
      if (previous?.refreshToken) await revokeToken(previous.refreshToken);

      await tokenRef.set({
        refreshToken: tokens.refresh_token,
        connectedAt: admin.firestore.FieldValue.serverTimestamp(),
        calendars: {},
      });
      await db.doc(`users/${uid}`).set(
        {
          googleCalendar: {
            connected: true,
            connectedAt: admin.firestore.FieldValue.serverTimestamp(),
            lastError: admin.firestore.FieldValue.delete(),
          },
        },
        { merge: true },
      );

      // Första synken direkt, så kalendern finns när användaren tittar.
      // Misslyckas den är kopplingen ändå gjord — natt-synken tar igen det.
      await syncUser(uid).catch((err) => console.error("Första synken misslyckades", uid, err));
      return back("connected");
    } catch (err) {
      console.error("OAuth-callback misslyckades", err);
      return back("error");
    }
  },
);

// ---------------------------------------------------------------------------
// 3. Koppla bort / synka nu
// ---------------------------------------------------------------------------

export const disconnectGoogleCalendar = onCall({ secrets: OAUTH_SECRETS }, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Du måste vara inloggad.");
  await disconnectUser(uid, { removeCalendars: true });
  return { ok: true };
});

export const syncGoogleCalendarNow = onCall({ secrets: OAUTH_SECRETS, timeoutSeconds: 120 }, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Du måste vara inloggad.");
  const snap = await admin.firestore().doc(`googleCalendarTokens/${uid}`).get();
  if (!snap.exists) throw new HttpsError("failed-precondition", "Google Kalender är inte kopplad.");
  await syncUser(uid);
  return { ok: true };
});

async function disconnectUser(uid: string, opts: { removeCalendars: boolean }) {
  const db = admin.firestore();
  const tokenRef = db.doc(`googleCalendarTokens/${uid}`);
  const token = (await tokenRef.get()).data() as TokenDoc | undefined;

  if (token?.refreshToken) {
    if (opts.removeCalendars) {
      // Ta bort det VI skapat — bara de dedikerade Varannan-kalendrarna.
      try {
        const accessToken = await getAccessToken(token.refreshToken);
        for (const cal of Object.values(token.calendars ?? {})) {
          await gfetch(accessToken, "DELETE", `/calendars/${encodeURIComponent(cal.googleCalendarId)}`).catch(
            () => undefined,
          );
        }
      } catch {
        // Token redan ogiltig — inget att ta bort med, gå vidare.
      }
    }
    await revokeToken(token.refreshToken);
  }
  await tokenRef.delete();
  await db.doc(`users/${uid}`).set({ googleCalendar: { connected: false } }, { merge: true });
}

// ---------------------------------------------------------------------------
// 4. Synk-motorn
// ---------------------------------------------------------------------------

/**
 * Synkar alla (eller en) av användarens kalendrar. Idempotent: räknar
 * fram hur Google-kalendern SKA se ut och rättar skillnaden, så den tål
 * att köras hur ofta som helst och reparerar sig själv efter fel.
 */
async function syncUser(uid: string, onlyChildPath?: string): Promise<void> {
  const db = admin.firestore();
  const tokenRef = db.doc(`googleCalendarTokens/${uid}`);
  const token = (await tokenRef.get()).data() as TokenDoc | undefined;
  if (!token?.refreshToken) return;

  let accessToken: string;
  try {
    accessToken = await getAccessToken(token.refreshToken);
  } catch (err) {
    if ((err as Error).message === "invalid_grant") {
      // Användaren har återkallat åtkomsten i sitt Google-konto.
      await tokenRef.delete();
      await db.doc(`users/${uid}`).set(
        { googleCalendar: { connected: false, lastError: "Åtkomsten till Google drogs tillbaka." } },
        { merge: true },
      );
      return;
    }
    throw err;
  }

  // Alla kalendrar användaren är med i, oavsett roll (samma fråga som
  // index.ts redan använder i produktion).
  const childSnaps = await db.collectionGroup("children").where("memberUids", "array-contains", uid).get();
  const calendars = { ...(token.calendars ?? {}) };
  let calendarsChanged = false;

  for (const childSnap of childSnaps.docs) {
    const teamId = childSnap.ref.parent.parent?.id;
    if (!teamId) continue;
    const childPath = `${teamId}/${childSnap.id}`;
    if (onlyChildPath && childPath !== onlyChildPath) continue;

    const child = childSnap.data() as ChildDoc;
    const childName = child.name || "Barnet";
    const cycleSnap = await childSnap.ref.collection("custodyCycle").doc("main").get();
    const cycle = cycleSnap.exists ? (cycleSnap.data() as CustodyCycleDoc) : null;
    const timeZone = cycle?.timezone || "Europe/Stockholm";

    // Se till att den dedikerade kalendern finns.
    let entry: { googleCalendarId: string; name: string } | undefined = calendars[childPath];
    if (entry) {
      const check = await gfetch(accessToken, "GET", `/calendars/${encodeURIComponent(entry.googleCalendarId)}`);
      if (check.status === 404 || check.status === 410) entry = undefined; // användaren tog bort den — skapa en ny
    }
    const wantedName = `${childName} – Varannan`;
    if (!entry) {
      const created = await gfetch(accessToken, "POST", "/calendars", {
        summary: wantedName,
        description: "Skapad av Varannan. Ändringar görs i Varannan-appen — den här kalendern skrivs över automatiskt.",
        timeZone,
      });
      if (!created.ok) throw new Error(`Kunde inte skapa kalender: ${created.status}`);
      const body = (await created.json()) as { id: string };
      entry = { googleCalendarId: body.id, name: wantedName };
      calendars[childPath] = entry;
      calendarsChanged = true;
    } else if (entry.name !== wantedName) {
      await gfetch(accessToken, "PATCH", `/calendars/${encodeURIComponent(entry.googleCalendarId)}`, {
        summary: wantedName,
      });
      calendars[childPath] = { ...entry, name: wantedName };
      calendarsChanged = true;
    }

    const desired = await computeDesiredEntries(db, teamId, childSnap.id, child, cycle);
    await reconcileCalendar(accessToken, calendars[childPath].googleCalendarId, desired, timeZone);
  }

  // Kalendrar för barn man inte längre är med i: ta bort ur Google.
  if (!onlyChildPath) {
    const currentPaths = new Set(
      childSnaps.docs.map((d) => `${d.ref.parent.parent?.id}/${d.id}`),
    );
    for (const [path, cal] of Object.entries(calendars)) {
      if (currentPaths.has(path)) continue;
      await gfetch(accessToken, "DELETE", `/calendars/${encodeURIComponent(cal.googleCalendarId)}`).catch(
        () => undefined,
      );
      delete calendars[path];
      calendarsChanged = true;
    }
  }

  if (calendarsChanged) await tokenRef.update({ calendars });
  await db.doc(`users/${uid}`).set(
    {
      googleCalendar: {
        connected: true,
        lastSyncedAt: admin.firestore.FieldValue.serverTimestamp(),
        lastError: admin.firestore.FieldValue.delete(),
      },
    },
    { merge: true },
  );
}

/**
 * Samma uträkning som ICS-flödet (calendarFeed.ts): ett block per
 * sammanhängande period hos en person, plus aktiviteter för barnet.
 */
async function computeDesiredEntries(
  db: admin.firestore.Firestore,
  teamId: string,
  childId: string,
  child: ChildDoc,
  cycle: CustodyCycleDoc | null,
): Promise<DesiredEntry[]> {
  const childName = child.name || "Barnet";
  const now = new Date();
  const rangeStart = new Date(now.getFullYear(), now.getMonth() - MONTHS_BACK, 1);
  const rangeEnd = new Date(now.getFullYear(), now.getMonth() + MONTHS_FORWARD, 1);
  const out: DesiredEntry[] = [];

  const teamSnap = await db.doc(`teams/${teamId}`).get();
  const teamParentIds: string[] = teamSnap.data()?.parentIds ?? [];
  const profiles: Record<string, TeamParentProfile> = teamSnap.data()?.parentProfiles ?? {};

  // Namn: teamets profiler för föräldrar, users/{uid} för anhöriga.
  const nameCache = new Map<string, string>();
  const nameFor = async (personUid: string) => {
    if (profiles[personUid]?.displayName) return profiles[personUid].displayName as string;
    if (nameCache.has(personUid)) return nameCache.get(personUid)!;
    const u = await db.doc(`users/${personUid}`).get();
    const name = (u.data()?.displayName as string | undefined) || "Andra föräldern";
    nameCache.set(personUid, name);
    return name;
  };
  const colorFor = (personUid: string): string | undefined => {
    const idx = teamParentIds.indexOf(personUid);
    if (idx < 0) return undefined; // anhörig — Googles standardfärg
    const colorId = (profiles[personUid]?.colorId as ParentColorId | undefined) ??
      DEFAULT_PARENT_COLOR_IDS[idx % DEFAULT_PARENT_COLOR_IDS.length];
    return GOOGLE_EVENT_COLOR_ID[colorId];
  };

  if (cycle) {
    const shiftsSnap = await db
      .collection(`teams/${teamId}/shiftRequests`)
      .where("childId", "==", childId)
      .where("status", "==", "approved")
      .get();
    const approvedShifts = shiftsSnap.docs.map((d) => d.data() as ShiftRequestDoc);

    let blockStart: Date | null = null;
    let blockParent: string | null = null;
    const pushBlock = async (start: Date, end: Date, personUid: string) => {
      out.push({
        key: `custody-${start.getTime()}-${personUid}`,
        summary: `${childName} hos ${await nameFor(personUid)}`,
        start,
        end,
        colorId: colorFor(personUid),
        transparent: true,
      });
    };

    for (let day = new Date(rangeStart); day < rangeEnd; day.setDate(day.getDate() + 1)) {
      const instant = switchInstantForDate(cycle, isoDate(day));
      const personUid = resolveResponsibleParent(cycle, approvedShifts, instant);
      if (blockParent === null) {
        blockParent = personUid;
        blockStart = instant;
      } else if (personUid !== blockParent) {
        await pushBlock(blockStart!, instant, blockParent);
        blockParent = personUid;
        blockStart = instant;
      }
    }
    if (blockParent && blockStart) {
      await pushBlock(blockStart, switchInstantForDate(cycle, isoDate(rangeEnd)), blockParent);
    }
  }

  const eventsSnap = await db.collection(`teams/${teamId}/events`).get();
  const events = eventsSnap.docs
    .map((d) => ({ ...(d.data() as EventDoc), id: d.id }))
    .filter((e) => !e.childId || e.childId === childId);
  for (const occ of expandEvents(events, rangeStart, rangeEnd)) {
    out.push({
      key: `event-${occ.eventId}-${occ.startAt.getTime()}`,
      summary: occ.title,
      start: occ.startAt,
      end: occ.endAt,
      transparent: false,
    });
  }
  return out;
}

interface GoogleEvent {
  id: string;
  summary?: string;
  colorId?: string;
  transparency?: string;
  start?: { dateTime?: string };
  end?: { dateTime?: string };
  extendedProperties?: { private?: Record<string, string> };
}

/** Får Google-kalendern att matcha `desired`: lägg till, ändra, ta bort. */
async function reconcileCalendar(
  accessToken: string,
  calendarId: string,
  desired: DesiredEntry[],
  timeZone: string,
): Promise<void> {
  const base = `/calendars/${encodeURIComponent(calendarId)}/events`;

  // Allt som redan finns i VÅR kalender (vi skapar inga återkommande
  // händelser, så ingen expansion behövs).
  const existing = new Map<string, GoogleEvent>();
  let pageToken: string | undefined;
  do {
    const qs = new URLSearchParams({ maxResults: "2500", showDeleted: "false" });
    if (pageToken) qs.set("pageToken", pageToken);
    const r = await gfetch(accessToken, "GET", `${base}?${qs.toString()}`);
    if (!r.ok) throw new Error(`Kunde inte lista händelser: ${r.status}`);
    const body = (await r.json()) as { items?: GoogleEvent[]; nextPageToken?: string };
    for (const ev of body.items ?? []) {
      const key = ev.extendedProperties?.private?.varannanKey;
      if (key) existing.set(key, ev);
    }
    pageToken = body.nextPageToken;
  } while (pageToken);

  const desiredKeys = new Set(desired.map((d) => d.key));
  const tasks: Array<() => Promise<unknown>> = [];

  for (const d of desired) {
    const body = {
      summary: d.summary,
      start: { dateTime: d.start.toISOString(), timeZone },
      end: { dateTime: d.end.toISOString(), timeZone },
      description: "Synkad från Varannan. Ändra i appen — ändringar här skrivs över.",
      transparency: d.transparent ? "transparent" : "opaque",
      ...(d.colorId ? { colorId: d.colorId } : {}),
      // Inga påminnelser från Google — Varannan sköter egna påminnelser,
      // och 26 block om året ska inte plinga.
      reminders: { useDefault: false, overrides: [] },
      extendedProperties: { private: { varannanKey: d.key } },
      status: "confirmed",
    };
    const current = existing.get(d.key);
    if (!current) {
      const id = googleEventId(d.key);
      tasks.push(async () => {
        const r = await gfetch(accessToken, "POST", base, { ...body, id });
        // 409 = id:t finns redan (samtidig synk, eller tidigare borttagen
        // händelse som Google minns) — skriv över i stället för att dubblera.
        if (r.status === 409) await gfetch(accessToken, "PUT", `${base}/${id}`, { ...body, id });
      });
    } else if (
      current.summary !== d.summary ||
      !sameInstant(current.start?.dateTime, d.start) ||
      !sameInstant(current.end?.dateTime, d.end) ||
      (current.colorId ?? undefined) !== d.colorId
    ) {
      tasks.push(() => gfetch(accessToken, "PUT", `${base}/${current.id}`, { ...body, id: current.id }));
    }
  }

  // Ta bort det som inte längre ska finnas — men bara från fönstrets
  // början och framåt, så historik äldre än fönstret ligger kvar.
  const windowStart = desired.length ? Math.min(...desired.map((d) => d.start.getTime())) : 0;
  for (const [key, ev] of existing) {
    if (desiredKeys.has(key)) continue;
    const evEnd = ev.end?.dateTime ? Date.parse(ev.end.dateTime) : Infinity;
    if (evEnd < windowStart) continue;
    tasks.push(() => gfetch(accessToken, "DELETE", `${base}/${ev.id}`));
  }

  await runLimited(tasks, 5);
}

// ---------------------------------------------------------------------------
// 5. När synkas det?
// ---------------------------------------------------------------------------

/** Alla med en koppling som är med i barnets kalender. */
async function connectedMembers(teamId: string, childId: string): Promise<string[]> {
  const db = admin.firestore();
  const child = (await db.doc(`teams/${teamId}/children/${childId}`).get()).data() as ChildDoc | undefined;
  const uids = child?.memberUids ?? child?.parentIds ?? [];
  const out: string[] = [];
  for (const u of uids) {
    if ((await db.doc(`googleCalendarTokens/${u}`).get()).exists) out.push(u);
  }
  return out;
}

async function syncChildForConnected(teamId: string, childId: string) {
  for (const uid of await connectedMembers(teamId, childId)) {
    await syncUser(uid, `${teamId}/${childId}`).catch(async (err) => {
      console.error("Google-synk misslyckades", uid, teamId, childId, err);
      await admin
        .firestore()
        .doc(`users/${uid}`)
        .set({ googleCalendar: { lastError: "Synken misslyckades, försöker igen inatt." } }, { merge: true })
        .catch(() => undefined);
    });
  }
}

async function syncAllChildrenOfTeam(teamId: string) {
  const children = await admin.firestore().collection(`teams/${teamId}/children`).get();
  for (const c of children.docs) await syncChildForConnected(teamId, c.id);
}

const TRIGGER_OPTS = { region: BACKGROUND_REGION, secrets: OAUTH_SECRETS, timeoutSeconds: 300 };

export const gcalSyncOnEvent = onDocumentWritten(
  { ...TRIGGER_OPTS, document: "teams/{teamId}/events/{eventId}" },
  async (event) => {
    const before = event.data?.before?.data() as EventDoc | undefined;
    const after = event.data?.after?.data() as EventDoc | undefined;
    const childId = after?.childId ?? before?.childId;
    // Familjegemensam aktivitet (inget childId) syns i alla barnens kalendrar.
    if (childId) await syncChildForConnected(event.params.teamId, childId);
    else await syncAllChildrenOfTeam(event.params.teamId);
  },
);

export const gcalSyncOnShift = onDocumentWritten(
  { ...TRIGGER_OPTS, document: "teams/{teamId}/shiftRequests/{requestId}" },
  async (event) => {
    const before = event.data?.before?.data() as ShiftRequestDoc | undefined;
    const after = event.data?.after?.data() as ShiftRequestDoc | undefined;
    // Bara godkända byten ändrar schemat.
    if (before?.status !== "approved" && after?.status !== "approved") return;
    const childId = after?.childId ?? before?.childId;
    if (childId) await syncChildForConnected(event.params.teamId, childId);
  },
);

export const gcalSyncOnCycle = onDocumentWritten(
  { ...TRIGGER_OPTS, document: "teams/{teamId}/children/{childId}/custodyCycle/{docId}" },
  async (event) => {
    await syncChildForConnected(event.params.teamId, event.params.childId);
  },
);

/** Rullar fönstret framåt och lagar det som missats (t.ex. fel i en trigger). */
export const gcalNightlySync = onSchedule(
  {
    schedule: "every day 03:30",
    timeZone: "Europe/Stockholm",
    region: BACKGROUND_REGION,
    secrets: OAUTH_SECRETS,
    timeoutSeconds: 540,
  },
  async () => {
    const tokens = await admin.firestore().collection("googleCalendarTokens").get();
    for (const t of tokens.docs) {
      await syncUser(t.id).catch((err) => console.error("Natt-synk misslyckades", t.id, err));
    }
  },
);

// ---------------------------------------------------------------------------
// Hjälpfunktioner
// ---------------------------------------------------------------------------

async function getAccessToken(refreshToken: string): Promise<string> {
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: GOOGLE_OAUTH_CLIENT_ID.value(),
      client_secret: GOOGLE_OAUTH_CLIENT_SECRET.value(),
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });
  const body = (await r.json()) as { access_token?: string; error?: string };
  if (!r.ok || !body.access_token) throw new Error(body.error || `token ${r.status}`);
  return body.access_token;
}

async function revokeToken(token: string): Promise<void> {
  await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(token)}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
  }).catch(() => undefined);
}

/** Anrop mot Calendar API med enkel retry på 429/5xx (Googles kvotgräns). */
async function gfetch(accessToken: string, method: string, path: string, body?: unknown): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const r = await fetch(`${CAL_API}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const retryable = r.status === 429 || r.status >= 500 ||
      (r.status === 403 && /rateLimitExceeded|userRateLimitExceeded/.test(await r.clone().text()));
    if (!retryable || attempt >= 4) return r;
    await new Promise((res) => setTimeout(res, 500 * 2 ** attempt + Math.random() * 250));
  }
}

async function runLimited(tasks: Array<() => Promise<unknown>>, limit: number) {
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, tasks.length) }, async () => {
    while (i < tasks.length) await tasks[i++]();
  });
  await Promise.all(workers);
}

/**
 * Deterministiskt Google-händelse-id från nyckeln: två samtidiga synkar
 * kan då aldrig skapa dubbletter (den andra får 409). Google kräver
 * tecknen a–v och 0–9 (base32hex), 5–1024 tecken.
 */
function googleEventId(key: string): string {
  const hash = crypto.createHash("sha256").update(key).digest();
  const alphabet = "0123456789abcdefghijklmnopqrstuv";
  let bits = 0;
  let value = 0;
  let out = "vrn";
  for (const byte of hash) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  return out;
}

function sameInstant(iso: string | undefined, d: Date): boolean {
  return !!iso && Date.parse(iso) === d.getTime();
}

function isoDate(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

/** Endast för enhetstest av diff-motorn (ingen produktionskod anropar detta). */
export const __testing = { googleEventId, reconcileCalendar };
