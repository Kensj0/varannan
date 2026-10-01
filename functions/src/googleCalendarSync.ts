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
 *      koden mot en refresh-token, sparar den i googleCalendarTokens/{uid}
 *      och skickar DIREKT användaren tillbaka till appen — se varning nedan.
 *   3. Skrivningen till googleCalendarTokens/{uid} triggar gcalSyncOnConnect
 *      (längst ner), som gör den första synken. Samma synk körs sedan vid
 *      ändringar (övriga triggers) och varje natt.
 *   4. disconnectGoogleCalendar tar bort Varannan-kalendrarna i Google,
 *      återkallar token hos Google och raderar den hos oss.
 *
 * VARNING — kör ALDRIG syncUser() inline i googleCalendarOAuthCallback:
 *   Firebase Hostings rewrite till Cloud Functions har en HÅRD 60s-gräns,
 *   oavsett funktionens egna timeoutSeconds. syncUser loopar sekventiella
 *   Google Calendar-anrop per barn/kalender och kan lätt ta längre tid än
 *   så för en användare med flera barn eller lång historik. Körs den
 *   inline hinner Hosting kapa anslutningen innan redirecten skickas —
 *   webbläsaren visar ett timeout-fel i stället för /?google=connected,
 *   trots att token redan sparats. Därför triggas synken separat (se 3).
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
export const OAUTH_SECRETS = [GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET];

/** Webbplatsen användaren kommer från och skickas tillbaka till. */
const APP_ORIGIN = "https://varannan.se";
/** Måste stå EXAKT så under "Authorized redirect URIs" på OAuth-klienten. */
const REDIRECT_URI = `${APP_ORIGIN}/oauth/google/callback`;
/**
 * Smalast möjliga scope för det appen faktiskt gör: skapar sekundära
 * kalendrar och hanterar (listar/skapar/ändrar/raderar) händelser i DEM —
 * aldrig användarens primärkalender, övriga kalendrar eller kalenderlistan
 * (ingen kod i den här filen rör "primary", calendarList, ACL eller
 * settings). Verifierat metod för metod mot Googles API-referens att
 * calendar.app.created täcker allt vi gör: calendars.insert/get/patch/
 * delete och events.list/insert/update/delete tar alla emot det scopet.
 * MÅSTE matcha exakt det scope som är registrerat i Google Cloud Console
 * OCH det integritetspolicyn (app/integritetspolicy/page.tsx) beskriver —
 * ändras det ena, ändra alla tre.
 */
const CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar.app.created";
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
  /**
   * childPath:ar användaren uttryckligen kopplat bort via
   * disconnectGoogleCalendarForChild, trots att kontot i övrigt är
   * kopplat. Utan den här listan skulle nästa synk (natt eller en
   * ändring på barnet) bara skapa tillbaka kalendern — se syncUser().
   */
  excludedChildPaths?: string[];
  /**
   * Delmängd av excludedChildPaths där ANLEDNINGEN är att ensureChildCalendar
   * hittade kalendern raderad i Google (404/410) vid en synk — till
   * skillnad från att användaren själv klickade "Koppla bort" i appen.
   * Styr bara vilket meddelande CalendarSettingsPanel visar ("Kalendern
   * togs bort i Google" + "Koppla igen", i stället för den vanliga
   * "Koppla Google Kalender"-knappen) — se getGoogleCalendarStatus.
   */
  externallyRemovedChildPaths?: string[];
  /**
   * childPath → tidsstämpel (ms) för en pågående kalenderskapning — se
   * ensureChildCalendar(). Förhindrar att två samtidiga synkar för samma
   * uid+barn skapar varsin Google-kalender (den ursprungliga dubblett-
   * buggen). Städas bort så fort skapandet är klart eller har kraschat.
   */
  pendingCalendarClaims?: Record<string, number>;
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

  // Valfritt: vilken kalender knappen klickades från (CalendarSettingsPanel
  // skickar alltid med det). Sparas bara för att kunna lägga med i
  // redirecten tillbaka — se googleCalendarOAuthCallback — så användaren
  // kommer tillbaka till SAMMA kalender, inte Profil eller en slumpmässig
  // förstavalsflik.
  const { teamId, childId } = (request.data ?? {}) as { teamId?: string; childId?: string };

  const db = admin.firestore();
  const state = crypto.randomBytes(24).toString("base64url");
  await db.doc(`oauthStates/${state}`).set({
    uid,
    ...(teamId && childId ? { teamId, childId } : {}),
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
    // teamId/childId: vilken kalender startGoogleCalendarConnect kördes
    // från (se där) — så användaren kommer tillbaka till SAMMA kalender,
    // inte Profil eller en slumpmässig förstavalsflik. `v`: ett unikt
    // query-värde varje gång, så att INGEN cache (webbläsarens HTTP-cache,
    // en proxy, etc) någonsin kan servera en tidigare besökares svar för
    // den här exakta URL:en — bara en försiktighetsåtgärd, själva appens
    // Cache-Control-headers (firebase.json) tillåter redan ingen caching
    // av index.html.
    const back = (result: string, coords?: { teamId?: string; childId?: string }) => {
      const params = new URLSearchParams({ google: result, v: Date.now().toString() });
      if (coords?.teamId && coords?.childId) {
        params.set("teamId", coords.teamId);
        params.set("childId", coords.childId);
      }
      res.redirect(302, `${APP_ORIGIN}/?${params.toString()}`);
    };

    const state = String(req.query.state ?? "");
    const code = String(req.query.code ?? "");
    const googleError = req.query.error ? String(req.query.error) : null;

    const db = admin.firestore();
    if (!state) return back("error");
    const stateRef = db.doc(`oauthStates/${state}`);
    const stateSnap = await stateRef.get();
    // Engångs: ta bort direkt, oavsett utfall.
    await stateRef.delete().catch(() => undefined);
    const stateData = stateSnap.data() as
      | { uid?: string; teamId?: string; childId?: string; expiresAt?: admin.firestore.Timestamp }
      | undefined;
    if (!stateSnap.exists || !stateData?.uid || (stateData.expiresAt?.toMillis() ?? 0) < Date.now()) {
      return back("error");
    }
    const coords = { teamId: stateData.teamId, childId: stateData.childId };
    if (googleError) return back(googleError === "access_denied" ? "denied" : "error", coords);
    if (!code) return back("error", coords);

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
        return back("error", coords);
      }
      // Användaren kan bocka ur kalender-rättigheten i samtyckesfönstret.
      if (!String(tokens.scope ?? "").split(" ").includes(CALENDAR_SCOPE)) {
        await revokeToken(tokens.refresh_token);
        return back("scope", coords);
      }

      // Byte av konto/återkoppling: rensa ev. gammal koppling först, så
      // vi inte lämnar en föräldralös token eller dubbla kalendrar.
      const tokenRef = db.doc(`googleCalendarTokens/${uid}`);
      const previous = (await tokenRef.get()).data() as TokenDoc | undefined;
      if (previous?.refreshToken) await revokeToken(previous.refreshToken);

      await tokenRef.set({
        refreshToken: tokens.refresh_token,
        connectedAt: admin.firestore.FieldValue.serverTimestamp(),
        // Behåll tidigare kända kalendrar vid omkoppling (t.ex. för att
        // uppdatera scope) — en tom karta hade fått nästa synk att tro att
        // INGEN av barnen hade en kalender än och försöka skapa nya åt
        // alla, trots att de redan fanns kvar i samma Google-konto.
        calendars: previous?.calendars ?? {},
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

      // Redirecta DIREKT — se VARNING i filhuvudet för varför synken inte
      // körs här. gcalSyncOnConnect (längst ner) triggas av skrivningen
      // till tokenRef ovan och gör den första synken i en egen invocation.
      return back("connected", coords);
    } catch (err) {
      console.error("OAuth-callback misslyckades", err);
      return back("error", coords);
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

/**
 * Kör syncUser() och omvandlar ett oväntat fel till ett begripligt
 * meddelande i stället för att låta det nå klienten som "INTERNAL" (det
 * generiska, oläsliga felet onCall annars visar för en okänd kastad
 * Error) — exakt det en användare såg vid andra trycket på "Synka nu"
 * innan FieldPath-fixen ovan (se ensureChildCalendar). HttpsError som
 * redan är tänkta att visas (t.ex. "invalid_grant" i syncUser självt)
 * slipper igenom oförändrade.
 */
async function syncUserOrFriendlyError(uid: string, onlyChildPath?: string): Promise<void> {
  try {
    await syncUser(uid, onlyChildPath);
  } catch (err) {
    if (err instanceof HttpsError) throw err;
    console.error("syncUser misslyckades", uid, onlyChildPath, err);
    throw new HttpsError("internal", "Kunde inte synka med Google just nu. Försök igen om en stund.");
  }
}

export const syncGoogleCalendarNow = onCall({ secrets: OAUTH_SECRETS, timeoutSeconds: 120 }, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Du måste vara inloggad.");
  const snap = await admin.firestore().doc(`googleCalendarTokens/${uid}`).get();
  if (!snap.exists) throw new HttpsError("failed-precondition", "Google Kalender är inte kopplad.");
  await syncUserOrFriendlyError(uid);
  return { ok: true };
});

// ---------------------------------------------------------------------------
// 3b. Per-barn-status (kalenderns inställningspanel, CalendarSettingsPanel.tsx)
//
// Token och kalender-id:n ligger i googleCalendarTokens/{uid}, som
// firestore.rules nekar all klientläsning av — se SÄKERHET i filhuvudet.
// Klienten får därför bara EXAKT det den behöver (två booleaner) via en
// callable, aldrig själva dokumentet.
// ---------------------------------------------------------------------------

async function assertChildMember(teamId: string, childId: string, uid: string): Promise<void> {
  const child = (await admin.firestore().doc(`teams/${teamId}/children/${childId}`).get()).data() as
    | ChildDoc
    | undefined;
  const memberUids = child?.memberUids ?? child?.parentIds ?? [];
  if (!memberUids.includes(uid)) throw new HttpsError("permission-denied", "Du är inte med på den här kalendern.");
}

export const getGoogleCalendarStatus = onCall({ secrets: OAUTH_SECRETS }, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Du måste vara inloggad.");
  const { teamId, childId } = request.data as { teamId?: string; childId?: string };
  if (!teamId || !childId) throw new HttpsError("invalid-argument", "teamId och childId krävs.");
  await assertChildMember(teamId, childId, uid);

  const token = (await admin.firestore().doc(`googleCalendarTokens/${uid}`).get()).data() as TokenDoc | undefined;
  const childPath = `${teamId}/${childId}`;
  return {
    /** Är Google-kontot kopplat alls (styr om "Fortsätt" ska gå via OAuth eller inte). */
    accountConnected: !!token?.refreshToken,
    /** Har just DET HÄR barnet en egen kalender just nu. */
    connected: !!token?.calendars?.[childPath],
    /**
     * Fanns kopplad, men en synk upptäckte att kalendern raderats i
     * Google (vem som helst kan göra det manuellt) — se ensureChildCalendar.
     * UI:t visar då "Kalendern togs bort i Google" + "Koppla igen" i
     * stället för den vanliga "Koppla Google Kalender"-knappen.
     */
    removedInGoogle: !token?.calendars?.[childPath] && !!token?.externallyRemovedChildPaths?.includes(childPath),
  };
});

/**
 * Lägger till (eller lägger tillbaka efter en tidigare frånkoppling) det
 * här barnets kalender. Kräver att kontot redan är kopplat — annars är
 * det startGoogleCalendarConnect (full OAuth) som gäller, inte den här.
 */
export const connectGoogleCalendarForChild = onCall(
  { secrets: OAUTH_SECRETS, timeoutSeconds: 120 },
  async (request) => {
    const uid = request.auth?.uid;
    if (!uid) throw new HttpsError("unauthenticated", "Du måste vara inloggad.");
    const { teamId, childId } = request.data as { teamId?: string; childId?: string };
    if (!teamId || !childId) throw new HttpsError("invalid-argument", "teamId och childId krävs.");
    await assertChildMember(teamId, childId, uid);

    const tokenRef = admin.firestore().doc(`googleCalendarTokens/${uid}`);
    const token = (await tokenRef.get()).data() as TokenDoc | undefined;
    if (!token?.refreshToken) {
      throw new HttpsError("failed-precondition", "Google-kontot är inte kopplat än.");
    }
    const childPath = `${teamId}/${childId}`;
    if (token.excludedChildPaths?.includes(childPath) || token.externallyRemovedChildPaths?.includes(childPath)) {
      await tokenRef.update({
        excludedChildPaths: admin.firestore.FieldValue.arrayRemove(childPath),
        externallyRemovedChildPaths: admin.firestore.FieldValue.arrayRemove(childPath),
      });
    }
    await syncUserOrFriendlyError(uid, childPath);
    return { ok: true };
  },
);

/**
 * Tar bort DET HÄR barnets kalender ur Google. Är det barnets kalender
 * det SISTA som fanns kvar på kontot återkallas hela kopplingen — precis
 * som den gamla globala frånkopplingen (disconnectGoogleCalendar) gjorde
 * — så att integritetspolicyns löfte om att alltid kunna återkalla
 * åtkomsten helt och hållet fortsätter stämma även utan den knappen kvar
 * i Inställningar.
 */
export const disconnectGoogleCalendarForChild = onCall({ secrets: OAUTH_SECRETS }, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Du måste vara inloggad.");
  const { teamId, childId } = request.data as { teamId?: string; childId?: string };
  if (!teamId || !childId) throw new HttpsError("invalid-argument", "teamId och childId krävs.");
  await assertChildMember(teamId, childId, uid);

  const tokenRef = admin.firestore().doc(`googleCalendarTokens/${uid}`);
  const token = (await tokenRef.get()).data() as TokenDoc | undefined;
  if (!token?.refreshToken) return { ok: true, accountDisconnected: false }; // inget konto kopplat — inget att göra

  const childPath = `${teamId}/${childId}`;
  const entry = token.calendars?.[childPath];
  if (entry) {
    try {
      const accessToken = await getAccessToken(token.refreshToken);
      await gfetch(accessToken, "DELETE", `/calendars/${encodeURIComponent(entry.googleCalendarId)}`).catch(
        () => undefined,
      );
    } catch {
      // Token ogiltig — inget att ta bort hos Google, städa bort lokalt ändå.
    }
  }

  const remainingPaths = Object.keys(token.calendars ?? {}).filter((p) => p !== childPath);
  if (remainingPaths.length === 0) {
    // Sista barnet — hela kontot (token + ev. kvarvarande kalendrar) bort.
    // removeCalendars:true låter disconnectUser göra en fräsch läsning och
    // städa upp även om något hann ändras sedan vi läste token ovan.
    await disconnectUser(uid, { removeCalendars: true });
    return { ok: true, accountDisconnected: true };
  }

  // FieldPath (inte en sträng-"dot path" — childPath innehåller "/", vilket
  // Firestore vägrar i ett strängfält, se calField), och per fält i stället
  // för en överskrivning av hela calendars-mappen — annars kan det här
  // anropet tappa en ANNAN samtidig körnings nyss skapade kalender för ett
  // annat barn (se ensureChildCalendar för samma resonemang).
  await tokenRef.update(
    calField("calendars", childPath), admin.firestore.FieldValue.delete(),
    "excludedChildPaths", admin.firestore.FieldValue.arrayUnion(childPath),
  );
  return { ok: true, accountDisconnected: false };
});

/**
 * Kopplar helt bort Google för en användare: raderar Varannan-kalendrarna
 * i Google (om removeCalendars), återkallar och raderar token. Exporterad
 * så deleteMyAccount (index.ts) kan göra samma sak när KONTOT raderas —
 * annars blir token kvar för evigt, föräldralös, trots att integritets-
 * policyn lovar att den raderas och återkallas vid radering.
 */
export async function disconnectUser(uid: string, opts: { removeCalendars: boolean }) {
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
/** En skapning äldre än så här har sannolikt kraschat — en senare synk får försöka igen. */
const CALENDAR_CLAIM_STALE_MS = 2 * 60 * 1000;

/**
 * childPath ("teamId/childId") innehåller "/" — ett tecken Firestore
 * VÄGRAR i ett sträng-fältnamn som "calendars.${childPath}" (kastar
 * "...is not a valid field path" i körtid; TypeScript varnar inte, det
 * är bara admin-SDK:ts egen validering). DETTA var den faktiska orsaken
 * till "Kopplad men ingen kalender i Google" och "INTERNAL" på andra
 * tryck på Synka nu: ensureChildCalendar kraschade varje gång den
 * försökte skriva ett sådant fält, så en trasig/borttagen kalender
 * aldrig hann repareras eller rapporteras. `FieldPath` löser det: varje
 * konstruktor-argument blir ETT bokstavligt segment, oavsett tecken.
 */
function calField(...segments: string[]): admin.firestore.FieldPath {
  return new admin.firestore.FieldPath(...segments);
}

/**
 * Säkerställer att childPath har en levande Google-kalender och
 * returnerar dess id — eller null om den inte ska synkas just nu:
 * antingen för att en SAMTIDIG körning redan skapar en (vi backar
 * hellre än att skapa en dubblett; nästa synk, oavsett källa, hittar då
 * den redan skapade kalendern), eller för att den sparade kalendern
 * upptäcktes raderad i Google och vi medvetet INTE skapar en ny i
 * bakgrunden — se "upptäckt raderad i Google" nedan.
 *
 * DUBBLETTBUGGEN satt här: skapandet låg tidigare i en read-modify-
 * write på HELA calendars-mappen, utspritt över hela syncUsers körtid
 * (en Google-rundtur per barn, flera sekunder). Två samtidiga körningar
 * för samma uid+barn — t.ex. gcalSyncOnConnect (triggas automatiskt när
 * kopplingen sparas) och ett otåligt tryck på "Synka nu" strax efter,
 * eller helt enkelt två snabba klick — läste båda "ingen kalender sparad
 * än", skapade var sin hos Google, och skrev sedan båda tillbaka HELA
 * sin egen lokala kopia av calendars-mappen. Den som skrev sist vann:
 * dess kalender kom med, den andras id gick förlorat ur Firestore trots
 * att kalendern finns kvar i Google — ett nytt tryck såg då fortfarande
 * "ingen sparad" och skapade ÄNNU en.
 *
 * Fixen: reservera RÄTTEN att skapa i en Firestore-transaktion (bara
 * Firestore-operationer i den — aldrig ett nätverksanrop mot Google,
 * eftersom transaktionen kan köras om vid kollision) innan något skapas
 * hos Google, och skriv resultatet med ett eget fält som bara rör DEN
 * HÄR childPath-nyckeln — aldrig en överskrivning av hela mappen, som
 * annars kan tappa en annan samtidig körnings uppdatering av ett ANNAT
 * barn.
 */
async function ensureChildCalendar(
  tokenRef: admin.firestore.DocumentReference,
  accessToken: string,
  childPath: string,
  wantedName: string,
  timeZone: string,
): Promise<string | null> {
  const db = admin.firestore();
  const fresh = (await tokenRef.get()).data() as TokenDoc | undefined;
  let entry = fresh?.calendars?.[childPath];
  if (entry) {
    const check = await gfetch(accessToken, "GET", `/calendars/${encodeURIComponent(entry.googleCalendarId)}`);
    if (check.status === 404 || check.status === 410) {
      // Upptäckt raderad i Google — vem som helst kan göra det manuellt
      // (en användare gjorde precis det i test). Tolkas som att barnet
      // kopplats bort: ta bort det sparade id:t så synken slutar skriva
      // mot en kalender som inte finns, men skapa ALDRIG tyst en ny i
      // bakgrunden — då kommer den bara tillbaka för någon som just
      // ville bli av med den. CalendarSettingsPanel visar i stället
      // "Kalendern togs bort i Google" + en "Koppla igen"-knapp
      // (connectGoogleCalendarForChild), som uttryckligen skapar en ny.
      await tokenRef
        .update(
          calField("calendars", childPath), admin.firestore.FieldValue.delete(),
          "excludedChildPaths", admin.firestore.FieldValue.arrayUnion(childPath),
          "externallyRemovedChildPaths", admin.firestore.FieldValue.arrayUnion(childPath),
        )
        .catch(() => undefined);
      return null;
    }
  }
  if (entry) {
    if (entry.name !== wantedName) {
      await gfetch(accessToken, "PATCH", `/calendars/${encodeURIComponent(entry.googleCalendarId)}`, {
        summary: wantedName,
      });
      await tokenRef.update(calField("calendars", childPath, "name"), wantedName).catch(() => undefined);
    }
    return entry.googleCalendarId;
  }

  // Ingen levande kalender sparad — reservera skapandet innan vi rör Google.
  const claimed = await db.runTransaction(async (tx) => {
    const snap = await tx.get(tokenRef);
    const t = snap.data() as TokenDoc | undefined;
    if (t?.calendars?.[childPath]) return false; // skapad under tiden — inget att göra här
    const claimedAt = t?.pendingCalendarClaims?.[childPath];
    if (claimedAt && Date.now() - claimedAt < CALENDAR_CLAIM_STALE_MS) return false; // en annan körning håller redan på
    tx.update(tokenRef, calField("pendingCalendarClaims", childPath), Date.now());
    return true;
  });
  if (!claimed) return null; // backa — en samtidig körning äger skapandet just nu

  try {
    const created = await gfetch(accessToken, "POST", "/calendars", {
      summary: wantedName,
      description: "Skapad av Varannan. Ändringar görs i Varannan-appen — den här kalendern skrivs över automatiskt.",
      timeZone,
    });
    if (!created.ok) throw new Error(`Kunde inte skapa kalender: ${created.status}`);
    const body = (await created.json()) as { id: string };
    await tokenRef.update(
      calField("calendars", childPath), { googleCalendarId: body.id, name: wantedName },
      calField("pendingCalendarClaims", childPath), admin.firestore.FieldValue.delete(),
    );
    return body.id;
  } catch (err) {
    // Släpp reservationen igen, annars blir barnet permanent "pending"
    // om anropet ovan kraschade — en senare synk måste få försöka om.
    await tokenRef
      .update(calField("pendingCalendarClaims", childPath), admin.firestore.FieldValue.delete())
      .catch(() => undefined);
    throw err;
  }
}

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

  for (const childSnap of childSnaps.docs) {
    const teamId = childSnap.ref.parent.parent?.id;
    if (!teamId) continue;
    const childPath = `${teamId}/${childSnap.id}`;
    if (onlyChildPath && childPath !== onlyChildPath) continue;
    // Uttryckligen bortkopplad via disconnectGoogleCalendarForChild — annars
    // skulle den här synken bara skapa tillbaka kalendern (konto fortfarande
    // kopplat, barnet fortfarande medlem).
    if (token.excludedChildPaths?.includes(childPath)) continue;

    const child = childSnap.data() as ChildDoc;
    const childName = child.name || "Barnet";
    const cycleSnap = await childSnap.ref.collection("custodyCycle").doc("main").get();
    const cycle = cycleSnap.exists ? (cycleSnap.data() as CustodyCycleDoc) : null;
    const timeZone = cycle?.timezone || "Europe/Stockholm";

    const wantedName = `${childName} – Varannan`;
    const googleCalendarId = await ensureChildCalendar(tokenRef, accessToken, childPath, wantedName, timeZone);
    if (!googleCalendarId) continue; // en samtidig synk skapar/äger den här just nu — hoppa över denna gång

    const desired = await computeDesiredEntries(db, teamId, childSnap.id, child, cycle);
    await reconcileCalendar(accessToken, googleCalendarId, desired, timeZone);
  }

  // Kalendrar för barn man inte längre är med i: ta bort ur Google. Läser
  // fräscht (inte den `token` som lästes i funktionens början) så att en
  // ANNAN samtidig körnings nyss skapade kalender för ett annat barn inte
  // försvinner härifrån — och skriver bort posterna en och en (FieldPath,
  // se calField), aldrig som en överskrivning av hela calendars-mappen.
  if (!onlyChildPath) {
    const currentPaths = new Set(childSnaps.docs.map((d) => `${d.ref.parent.parent?.id}/${d.id}`));
    const latest = (await tokenRef.get()).data() as TokenDoc | undefined;
    for (const [path, cal] of Object.entries(latest?.calendars ?? {})) {
      if (currentPaths.has(path)) continue;
      await gfetch(accessToken, "DELETE", `/calendars/${encodeURIComponent(cal.googleCalendarId)}`).catch(
        () => undefined,
      );
      await tokenRef.update(calField("calendars", path), admin.firestore.FieldValue.delete()).catch(() => undefined);
    }
  }

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
    .filter((e) => (!e.childId || e.childId === childId) && e.startAt && e.endAt);
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

/**
 * Gör den första synken när en användare kopplar (eller kopplar om) sitt
 * Google-konto. Triggas av skrivningen till googleCalendarTokens/{uid} i
 * googleCalendarOAuthCallback — INTE inline där, se VARNING i filhuvudet.
 *
 * Jämför refreshToken före/efter i stället för att bara kolla att
 * dokumentet skrevs: syncUser() skriver själv tillbaka till samma
 * dokument (tokenRef.update({ calendars })) när kalendrar skapas, vilket
 * annars skulle trigga ett varv till av sig själv för varje connect.
 */
export const gcalSyncOnConnect = onDocumentWritten(
  { ...TRIGGER_OPTS, document: "googleCalendarTokens/{uid}" },
  async (event) => {
    const before = event.data?.before?.data() as TokenDoc | undefined;
    const after = event.data?.after?.data() as TokenDoc | undefined;
    if (!after?.refreshToken) return; // frånkoppling — inget att synka
    if (before?.refreshToken === after.refreshToken) return; // bara calendars-fältet ändrades
    await syncUser(event.params.uid).catch((err) =>
      console.error("Första synken misslyckades", event.params.uid, err),
    );
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
