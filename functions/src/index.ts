/**
 * functions/src/index.ts
 * -----------------------
 * Två callable/trigger-funktioner:
 *
 *  1. approveShiftRequest — kör respondToShiftRequest-logiken (se
 *     ../../lib/shiftRequests.ts) i EN Firestore-transaction, så att
 *     shiftRequest.status och dayBalance ALDRIG kan hamna i otakt.
 *
 *  2. exportEventToGoogleCalendar — triggas när ett EventDoc skapas/
 *     uppdateras, och skriver en kopia till respektive förälders EGEN
 *     Google-kalender (envägs export, read-only kopia hos användaren,
 *     enligt beslutet i konversationen).
 *
 * OBS: Detta är ett fungerande skelett för en mockup. Innan produktion:
 * lägg till idempotens-skydd (kolla t.ex. redan satt googleEventIds
 * innan ny insert) och felhantering/retry vid Google API-fel.
 */

import * as admin from "firebase-admin";
import { setGlobalOptions } from "firebase-functions/v2";
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { onDocumentWritten } from "firebase-functions/v2/firestore";
import { google } from "googleapis";

// Alla functions i samma region — undviker mismatch mellan Firestore-
// triggers (Eventarc) och databasens region, vilket annars kan ge
// "Location X is not found or access is unauthorized".
setGlobalOptions({ region: "us-central1" });

import {
  CustodyCycleDoc,
  DayBalanceDoc,
  ShiftRequestDoc,
  EventDoc,
  UserDoc,
  TeamParentProfile,
} from "../../types/schema";
import { applyApprovedShiftToBalance } from "../../lib/dayBalance";
import {
  createTeam as createTeamCore,
  createParentInvite,
  acceptParentInvite,
  setupCustodyCycle,
} from "../../lib/onboarding";
import { createOnboardingAdapter } from "./onboardingAdapter";

admin.initializeApp();
const db = admin.firestore();
const onboardingDb = createOnboardingAdapter(db);

// ---------------------------------------------------------------------------
// 0. Auth-bakade onboarding-funktioner
// ---------------------------------------------------------------------------

/** Bygger den cachade profilen från auth-token — aldrig från klient-data. */
function profileFromAuth(auth: { uid: string; token: Record<string, any> }): TeamParentProfile {
  return {
    uid: auth.uid,
    displayName: auth.token.name || auth.token.email?.split("@")[0] || "Förälder",
    avatarUrl: auth.token.picture || undefined,
  };
}

/** Körs direkt efter att en ny användare loggat in första gången. */
export const createFamilyTeam = onCall(async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Du måste vara inloggad.");
  const { teamName } = request.data as { teamName: string };
  if (!teamName?.trim()) throw new HttpsError("invalid-argument", "Familjenamn saknas.");

  const teamId = await createTeamCore(onboardingDb, {
    creatorUid: uid,
    teamName: teamName.trim(),
    creatorProfile: profileFromAuth(request.auth!),
  });
  return { teamId };
});

export const createInvite = onCall(async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Du måste vara inloggad.");
  const { teamId, baseUrl } = request.data as { teamId: string; baseUrl?: string };

  const teamSnap = await db.doc(`teams/${teamId}`).get();
  if (!teamSnap.exists) throw new HttpsError("not-found", "Team saknas.");
  const parentIds: string[] = teamSnap.data()?.parentIds ?? [];
  if (!parentIds.includes(uid)) throw new HttpsError("permission-denied", "Du är inte medlem i teamet.");
  if (parentIds.length >= 2) {
    throw new HttpsError("failed-precondition", "Familjen har redan två föräldrar.");
  }

  // baseUrl kommer från klienten (window.location.origin) men valideras
  // mot en allowlist — annars kunde en angripare få appen att generera
  // inbjudningslänkar som pekar på en phishing-domän.
  const allowed = (process.env.ALLOWED_APP_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const safeBaseUrl =
    baseUrl && allowed.includes(baseUrl) ? baseUrl : allowed[0] ?? "http://localhost:3000";

  return createParentInvite(onboardingDb, teamId, safeBaseUrl);
});

export const acceptInvite = onCall(async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Du måste vara inloggad.");
  const { code } = request.data as { code: string };

  const result = await acceptParentInvite(onboardingDb, {
    uid,
    code: code.trim().toUpperCase(),
    profile: profileFromAuth(request.auth!),
  });

  if ("error" in result) {
    if (result.error === "team_full") {
      throw new HttpsError("failed-precondition", "Familjen har redan två föräldrar.");
    }
    throw new HttpsError("failed-precondition", "Koden är ogiltig eller har gått ut.");
  }
  return result;
});

/**
 * Håller den cachade kopian i teams/{teamId}.parentProfiles i synk när
 * en förälder byter namn eller profilbild i users/{uid}.
 */
export const syncDisplayNameToTeam = onDocumentWritten("users/{uid}", async (event) => {
  const after = event.data?.after?.data() as UserDoc | undefined;
  const before = event.data?.before?.data() as UserDoc | undefined;
  if (!after?.teamId) return;

  const nameChanged = before?.displayName !== after.displayName;
  const avatarChanged = before?.avatarUrl !== after.avatarUrl;
  const teamChanged = before?.teamId !== after.teamId;
  if (!nameChanged && !avatarChanged && !teamChanged) return;

  await db.doc(`teams/${after.teamId}`).update({
    [`parentProfiles.${event.params.uid}`]: {
      uid: event.params.uid,
      displayName: after.displayName,
      avatarUrl: after.avatarUrl ?? null,
    },
  });
});

export const saveCustodyCycle = onCall(async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Du måste vara inloggad.");
  const raw = request.data as Parameters<typeof setupCustodyCycle>[1];

  const teamSnap = await db.doc(`teams/${raw.teamId}`).get();
  const parentIds: string[] = teamSnap.data()?.parentIds ?? [];
  if (!parentIds.includes(uid)) throw new HttpsError("permission-denied", "Du är inte medlem i teamet.");

  // Blocken måste peka på teamets faktiska föräldrar — annars blir
  // schemat omöjligt att rendera (uid:t matchar ingen användare).
  const blockParents = new Set(raw.blocks.map((b) => b.parentId));
  for (const pid of blockParents) {
    if (!parentIds.includes(pid)) {
      throw new HttpsError("invalid-argument", `Okänd förälder i schemat: ${pid}`);
    }
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw.cycleStartDate)) {
    throw new HttpsError("invalid-argument", "cycleStartDate måste vara YYYY-MM-DD.");
  }

  await setupCustodyCycle(onboardingDb, { ...raw, updatedBy: uid });
  return { ok: true };
});

// ---------------------------------------------------------------------------
// 1. approveShiftRequest — atomiskt godkännande + ställnings-uppdatering
// ---------------------------------------------------------------------------

export const approveShiftRequest = onCall(async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Du måste vara inloggad.");

  const { teamId, childId, shiftRequestId, decision } = request.data as {
    teamId: string;
    childId: string;
    shiftRequestId: string;
    decision: "approved" | "declined";
  };

  if (!["approved", "declined"].includes(decision)) {
    throw new HttpsError("invalid-argument", "decision måste vara 'approved' eller 'declined'.");
  }

  const teamRef = db.doc(`teams/${teamId}`);
  const requestRef = db.doc(`teams/${teamId}/shiftRequests/${shiftRequestId}`);
  const cycleRef = db.doc(`teams/${teamId}/children/${childId}/custodyCycle/main`);
  const balanceRef = db.doc(`teams/${teamId}/children/${childId}/dayBalance/main`);
  const historyRef = db.collection(`teams/${teamId}/children/${childId}/dayBalanceHistory`).doc();

  await db.runTransaction(async (tx) => {
    const [teamSnap, requestSnap] = await Promise.all([tx.get(teamRef), tx.get(requestRef)]);

    if (!teamSnap.exists) throw new HttpsError("not-found", "Team saknas.");
    const parentIds: string[] = teamSnap.data()!.parentIds;
    if (!parentIds.includes(uid)) {
      throw new HttpsError("permission-denied", "Du är inte medlem i det här teamet.");
    }

    if (!requestSnap.exists) throw new HttpsError("not-found", "Förfrågan saknas.");
    const shiftRequest = requestSnap.data() as ShiftRequestDoc;
    if (shiftRequest.status !== "pending") {
      throw new HttpsError("failed-precondition", "Förfrågan är redan hanterad.");
    }
    // Bara MOTPARTEN (inte den som föreslog) får godkänna/avböja.
    if (shiftRequest.requestedBy === uid) {
      throw new HttpsError("permission-denied", "Du kan inte godkänna din egen förfrågan.");
    }

    if (decision === "declined") {
      tx.update(requestRef, {
        status: "declined",
        respondedBy: uid,
        respondedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      return;
    }

    const [cycleSnap, balanceSnap] = await Promise.all([tx.get(cycleRef), tx.get(balanceRef)]);
    if (!cycleSnap.exists) throw new HttpsError("not-found", "Ingen boendecykel konfigurerad för barnet.");
    if (!balanceSnap.exists) throw new HttpsError("not-found", "Ingen ställning initierad för barnet.");

    const cycle = cycleSnap.data() as CustodyCycleDoc;
    const currentBalance = balanceSnap.data() as DayBalanceDoc;

    const approvedRequest: ShiftRequestDoc = {
      ...shiftRequest,
      status: "approved",
      respondedBy: uid,
    };

    const { updatedBalance, deltaDays } = applyApprovedShiftToBalance(currentBalance, cycle, approvedRequest);

    tx.update(requestRef, {
      status: "approved",
      respondedBy: uid,
      respondedAt: admin.firestore.FieldValue.serverTimestamp(),
      balanceDeltaDays: deltaDays,
    });
    tx.set(balanceRef, {
      ...updatedBalance,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    tx.set(historyRef, {
      id: historyRef.id,
      childId,
      shiftRequestId,
      deltaDays,
      balanceAfter: updatedBalance.balanceDays,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  });

  return { ok: true };
});

// ---------------------------------------------------------------------------
// 2. exportEventToGoogleCalendar — envägs export till varje förälders
//    egen Google-kalender när ett EventDoc skapas eller ändras.
// ---------------------------------------------------------------------------

export const exportEventToGoogleCalendar = onDocumentWritten(
  "teams/{teamId}/events/{eventId}",
  async (event) => {
    const after = event.data?.after?.data() as EventDoc | undefined;
    if (!after) return; // borttaget event — hantera ev. borttag av Google-eventet separat

    const teamSnap = await db.doc(`teams/${event.params.teamId}`).get();
    const parentIds: string[] = teamSnap.data()?.parentIds ?? [];

    const googleEventIds: Record<string, string> = { ...(after.googleEventIds ?? {}) };

    for (const parentUid of parentIds) {
      const userSnap = await db.doc(`users/${parentUid}`).get();
      const user = userSnap.data() as UserDoc | undefined;
      if (!user?.googleCalendar?.connected || !user.googleCalendar.refreshTokenRef) continue;

      const calendar = await getCalendarClientForUser(user.googleCalendar.refreshTokenRef);
      const calendarId = user.googleCalendar.calendarId ?? "primary";

      const requestBody = {
        summary: after.title,
        start: { dateTime: tsToIso(after.startAt) },
        end: { dateTime: tsToIso(after.endAt) },
        // Envägs — märk tydligt så användaren förstår att redigering
        // ska göras i Varannan, inte i Google Calendar.
        description: "Synkad från Varannan (envägs export — redigera i appen).",
      };

      const existingId = googleEventIds[parentUid];
      if (existingId) {
        await calendar.events.update({ calendarId, eventId: existingId, requestBody });
      } else {
        const inserted = await calendar.events.insert({ calendarId, requestBody });
        if (inserted.data.id) googleEventIds[parentUid] = inserted.data.id;
      }
    }

    await event.data!.after!.ref.set({ googleEventIds }, { merge: true });
  }
);

// ---------------------------------------------------------------------------
// Hjälpfunktioner
// ---------------------------------------------------------------------------

async function getCalendarClientForUser(refreshTokenRef: string) {
  // I produktion: hämta den faktiska refresh-token från Secret Manager
  // via refreshTokenRef (ALDRIG lagra token direkt i Firestore).
  const refreshToken = await resolveSecret(refreshTokenRef);

  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_OAUTH_CLIENT_ID,
    process.env.GOOGLE_OAUTH_CLIENT_SECRET
  );
  oauth2Client.setCredentials({ refresh_token: refreshToken });

  return google.calendar({ version: "v3", auth: oauth2Client });
}

async function resolveSecret(secretRef: string): Promise<string> {
  // Platshållare — koppla mot @google-cloud/secret-manager i produktion.
  throw new Error(`resolveSecret ej implementerad ännu för ref: ${secretRef}`);
}

function tsToIso(ts: { seconds: number; nanoseconds: number }): string {
  return new Date(ts.seconds * 1000 + ts.nanoseconds / 1e6).toISOString();
}
