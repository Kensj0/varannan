/**
 * functions/src/index.ts
 * -----------------------
 * Två callable/trigger-funktioner:
 *
 *  1. approveShiftRequest — kör respondToShiftRequest-logiken (se
 *     ../../lib/shiftRequests.ts) i EN Firestore-transaction, så att
 *     shiftRequest.status och dayBalance ALDRIG kan hamna i otakt.
 *
 *  2. Google Kalender-synken (frivillig OAuth-koppling) ligger i
 *     googleCalendarSync.ts och re-exporteras härifrån.
 */

import * as admin from "firebase-admin";
import * as crypto from "crypto";
import { setGlobalOptions } from "firebase-functions/v2";
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { onDocumentWritten, onDocumentCreated } from "firebase-functions/v2/firestore";
import { sendEmailOrThrow, sendEmail, GMAIL_USER, GMAIL_APP_PASSWORD } from "./email";

// Default-region: europe-north1 (Hamina). Firestore ligger i
// europe-north2 (Stockholm), som INTE stödjer Cloud Functions v2 —
// europe-north1 är den närmaste region som gör det (~1 ms extra mot
// Stockholm). Nästan alla användare är i Sverige, och de callables de
// faktiskt väntar på (godkänn byte, spara schema, bjud in) gör flera
// Firestore-läsningar i följd: hoppet funktion→db går från ~110 ms
// (Iowa→Stockholm) till ~15 ms, plus att Atlanten-hoppet till klienten
// försvinner.
//
// UNDANTAG som pinnas till us-central1 nedan, med motivering vid varje:
//   - Firestore-triggers (Eventarc stödde inte europe-north* när de
//     sattes upp: "Location X is not found or access is unauthorized").
//   - calendarFeed: dess URL ligger redan ute i användarnas kalender-
//     prenumerationer (lib/calendarExport.ts: FEED_REGION), och den
//     anropas server-till-server av Google/Apple/Outlook, inte av en
//     användare som väntar — regionen spelar ingen roll för den.
setGlobalOptions({ region: "europe-north1" });

/** Region för de funktioner som av kompatibilitetsskäl måste ligga kvar. */
const LEGACY_REGION = "us-central1";

import {
  CustodyCycleDoc,
  DayBalanceDoc,
  ShiftRequestDoc,
  EventDoc,
  UserDoc,
  DEFAULT_HANDOFF_REMINDER_PREFS,
  TeamParentProfile,
  ScheduleChangeMode,
  scheduleChangeModeFor,
  calendarParentIds,
  calendarRoleFor,
  PENDING_PARTNER_ID,
  CalendarRole,
} from "../../types/schema";
import { applyApprovedShiftToBalance } from "../../lib/dayBalance";
import {
  createTeam as createTeamCore,
  createParentInvite,
  acceptParentInvite,
  setupCustodyCycle,
} from "../../lib/onboarding";
import { createOnboardingAdapter } from "./onboardingAdapter";
import { sendPushToUser, sendPushToUsers } from "./notifications";

export { sendHandoffReminders } from "./handoffReminders";
export { calendarFeed, createCalendarFeedToken, setParentColor } from "./calendarFeed";
export {
  startGoogleCalendarConnect,
  googleCalendarOAuthCallback,
  disconnectGoogleCalendar,
  syncGoogleCalendarNow,
  getGoogleCalendarStatus,
  connectGoogleCalendarForChild,
  disconnectGoogleCalendarForChild,
  gcalSyncOnEvent,
  gcalSyncOnShift,
  gcalSyncOnCycle,
  gcalSyncOnConnect,
  gcalNightlySync,
} from "./googleCalendarSync";

// setCustomSwitchHour — uppdatera bytestiden för ett barn
export const setCustomSwitchHour = onCall(async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Du måste vara inloggad.");

  const { teamId, childId, switchHour } = request.data as {
    teamId?: string;
    childId?: string;
    switchHour?: string;
  };
  if (!teamId || !childId || !switchHour) {
    throw new HttpsError("invalid-argument", "teamId, childId och switchHour krävs.");
  }

  // Validera format HH:MM
  if (!/^\d{2}:\d{2}$/.test(switchHour)) {
    throw new HttpsError("invalid-argument", "switchHour måste vara HH:MM (t.ex. 08:00).");
  }

  const db = admin.firestore();
  const teamSnap = await db.doc(`teams/${teamId}`).get();
  if (!teamSnap.exists) throw new HttpsError("not-found", "Teamet finns inte.");

  const parentIds: string[] = teamSnap.data()?.parentIds ?? [];
  if (!parentIds.includes(uid)) throw new HttpsError("permission-denied", "Du tillhör inte teamet.");

  const cycleRef = db.doc(`teams/${teamId}/children/${childId}/custodyCycle/main`);
  const currentHour = (await cycleRef.get()).data()?.switchHour ?? "08:00";

  const counterpart = await counterpartFor(teamId, childId, uid);
  if (structureChangeAppliesDirectly(counterpart)) {
    await cycleRef.update({ switchHour });
    if (counterpart) {
      const name = teamSnap.data()?.parentProfiles?.[uid]?.displayName ?? "Den andra föräldern";
      await sendPushToUsers(db, [counterpart], {
        title: "Bytestiden ändrades",
        body: `${name} ändrade bytestiden till ${switchHour}.`,
      });
    }
    return { ok: true, pending: false };
  }

  return createStructureRequest({
    teamId,
    childId,
    requestedBy: uid,
    addressedTo: counterpart!,
    kind: "switchHour",
    payload: { teamId, childId, switchHour },
    summary: `bytestid ${currentHour} → ${switchHour}`,
  });
});


admin.initializeApp();
// Skyddsnät: utan detta kastar Admin SDK:t på varje fält som råkar vara
// `undefined`, vilket fäller hela anropet med ett obegripligt "INTERNAL"
// istället för att bara hoppa över fältet.
admin.firestore().settings({ ignoreUndefinedProperties: true });
const db = admin.firestore();
const onboardingDb = createOnboardingAdapter(db);

// ---------------------------------------------------------------------------
// 0. Auth-bakade onboarding-funktioner
// ---------------------------------------------------------------------------

/** Bygger den cachade profilen från auth-token — aldrig från klient-data. */
function profileFromAuth(auth: { uid: string; token: Record<string, any> }): TeamParentProfile {
  const avatarUrl = auth.token.picture || undefined;
  return {
    uid: auth.uid,
    displayName: auth.token.name || auth.token.email?.split("@")[0] || "Förälder",
    // Fältet utelämnas helt när det saknas. Admin SDK:t kastar på ett
    // explicit `undefined`-värde (till skillnad från webb-SDK:t), och
    // konton som skapats med e-post/lösenord har ingen `picture` i
    // token — det gjorde att acceptInvite föll med "INTERNAL" för alla
    // som inte loggat in via Google.
    ...(avatarUrl ? { avatarUrl } : {}),
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

/**
 * Byter ut PENDING_PARTNER_ID mot den andra förälderns riktiga uid i alla
 * barns custodyCycle. Normalt sköts det av acceptInvite, men team som
 * anslöts innan listChildIds-buggen fixades har kvar platshållaren i
 * schemat — vilket gör att hela kalendern visar EN förälder. Anropas
 * automatiskt av klienten när den upptäcker en kvarvarande platshållare.
 */
export const repairPendingPartner = onCall(async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Du måste vara inloggad.");
  const { teamId } = request.data as { teamId: string };

  const teamSnap = await db.doc(`teams/${teamId}`).get();
  if (!teamSnap.exists) throw new HttpsError("not-found", "Team saknas.");
  const parentIds: string[] = teamSnap.data()?.parentIds ?? [];
  if (!parentIds.includes(uid)) throw new HttpsError("permission-denied", "Du är inte medlem i teamet.");
  // Kräver att båda föräldrarna finns — annars vet vi inte vem
  // platshållaren ska bli, och skulle riskera att peka ut fel person.
  if (parentIds.length < 2) return { repaired: 0 };

  const childrenSnap = await db.collection(`teams/${teamId}/children`).get();
  let repaired = 0;

  for (const child of childrenSnap.docs) {
    const ref = db.doc(`teams/${teamId}/children/${child.id}/custodyCycle/main`);
    const snap = await ref.get();
    if (!snap.exists) continue;
    const blocks = (snap.data()?.blocks ?? []) as { parentId: string; days: number }[];
    if (!blocks.some((b) => b.parentId === PENDING_PARTNER_ID)) continue;

    // Platshållaren är den förälder som INTE äger de riktiga blocken.
    const realIdInBlocks = blocks.find((b) => b.parentId !== PENDING_PARTNER_ID)?.parentId;
    const partnerId = parentIds.find((id) => id !== realIdInBlocks);
    if (!partnerId) continue;

    await ref.update({
      blocks: blocks.map((b) => (b.parentId === PENDING_PARTNER_ID ? { ...b, parentId: partnerId } : b)),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedBy: uid,
    });
    repaired++;
  }

  return { repaired };
});

/**
 * Tar bort godkända avvikelser från och med ett datum, och backar ut
 * deras påverkan på ställningen. Används när grundschemat görs om: de
 * gamla avvikelserna beskriver undantag från ett schema som inte längre
 * gäller, och deras balanceDeltaDays räknades ut mot den gamla cykeln.
 *
 * Bara framåt i tiden. Dagar som redan passerat har faktiskt inträffat,
 * och att sudda dem skulle skriva om historien och göra ställningen fel
 * åt andra hållet.
 */
/**
 * Godkända avvikelser som överlappar en period. Två motsatta godkännanden
 * för samma dag gör schemat tvetydigt — kalendern kan bara visa en av dem.
 * En NY godkänd ändring som HELT täcker en äldre ersätter den (se
 * splitContainedOverlap + cancelSupersededInTx); bara en avvikelse som
 * sticker ut UTANFÖR den nya perioden går inte att ersätta rent och
 * avvisas fortfarande.
 */
async function findOverlappingApproved(
  teamId: string,
  childId: string,
  startMs: number,
  endMs: number | null,
  excludeIds: string[]
): Promise<admin.firestore.QueryDocumentSnapshot[]> {
  const snap = await db
    .collection(`teams/${teamId}/shiftRequests`)
    .where("childId", "==", childId)
    .where("status", "==", "approved")
    .get();

  return snap.docs.filter((d) => {
    if (excludeIds.includes(d.id)) return false;
    const data = d.data();
    const s = (data.startAt?.seconds ?? 0) * 1000;
    const e = data.endAt ? data.endAt.seconds * 1000 : null;
    // Öppna perioder ("till nästa ordinarie byte") räknas som pågående
    // från sin start och framåt.
    const overlapEnd = endMs ?? Infinity;
    const otherEnd = e ?? Infinity;
    return s < overlapEnd && otherEnd > startMs;
  });
}

/**
 * Delar upp krockande godkända avvikelser i två högar:
 *  - `contained`: ligger HELT inom [startMs, endMs) — ersätts av den nya
 *    ändringen (avbryts + balans backas).
 *  - `partial`: sticker ut utanför perioden — går inte att dela, så det
 *    är fortfarande en hård krock som anroparen får avvisa.
 * En öppen befintlig period (utan endAt) räknas som contained bara om
 * den nya perioden också är öppen (endMs === null), annars partial.
 */
function splitContainedOverlap(
  clash: admin.firestore.QueryDocumentSnapshot[],
  startMs: number,
  endMs: number | null
): { contained: admin.firestore.QueryDocumentSnapshot[]; partial: admin.firestore.QueryDocumentSnapshot[] } {
  const newEnd = endMs ?? Infinity;
  const contained: admin.firestore.QueryDocumentSnapshot[] = [];
  const partial: admin.firestore.QueryDocumentSnapshot[] = [];
  for (const d of clash) {
    const data = d.data();
    const s = (data.startAt?.seconds ?? 0) * 1000;
    const e = data.endAt ? data.endAt.seconds * 1000 : Infinity;
    if (s >= startMs && e <= newEnd) contained.push(d);
    else partial.push(d);
  }
  return { contained, partial };
}

/**
 * Avbryter godkända avvikelser som ersätts av en nyare godkänd ändring och
 * backar deras balans-delta — samma mekanik som clearApprovedShiftsFrom,
 * fast för en explicit lista och inuti en pågående transaktion. Returnerar
 * summan av balanceDeltaDays som ska dras av från balanceDays (0 om inget
 * ersattes). Skriver en historikpost för reverseringen om den inte är noll.
 */
function cancelSupersededInTx(
  tx: admin.firestore.Transaction,
  teamId: string,
  childId: string,
  superseded: admin.firestore.QueryDocumentSnapshot[],
  uid: string,
  balanceDaysBeforeReversal: number
): number {
  let reversedDelta = 0;
  for (const d of superseded) {
    reversedDelta += (d.data().balanceDeltaDays as number | undefined) ?? 0;
    tx.update(d.ref, {
      status: "cancelled",
      cancelledBy: uid,
      cancelledAt: admin.firestore.FieldValue.serverTimestamp(),
      cancelledReason: "superseded_by_newer_change",
    });
  }
  if (reversedDelta !== 0) {
    const historyRef = db.collection(`teams/${teamId}/children/${childId}/dayBalanceHistory`).doc();
    tx.set(historyRef, {
      id: historyRef.id,
      childId,
      shiftRequestId: "",
      deltaDays: -reversedDelta,
      balanceAfter: balanceDaysBeforeReversal - reversedDelta,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  }
  return reversedDelta;
}

export const clearApprovedShiftsFrom = onCall(async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Du måste vara inloggad.");

  const { teamId, childId, fromDate } = request.data as {
    teamId: string;
    childId: string;
    fromDate: string; // "YYYY-MM-DD"
  };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fromDate)) {
    throw new HttpsError("invalid-argument", "fromDate måste vara YYYY-MM-DD.");
  }

  const teamSnap = await db.doc(`teams/${teamId}`).get();
  if (!teamSnap.exists) throw new HttpsError("not-found", "Team saknas.");
  const parentIds: string[] = teamSnap.data()?.parentIds ?? [];
  if (!parentIds.includes(uid)) throw new HttpsError("permission-denied", "Du är inte medlem i teamet.");

  // Jämför mot dygnets början lokalt sett; en avvikelse som börjar senare
  // samma dag som det nya schemat träder i kraft ska också bort.
  const cutoff = admin.firestore.Timestamp.fromDate(new Date(`${fromDate}T00:00:00Z`));

  const snap = await db
    .collection(`teams/${teamId}/shiftRequests`)
    .where("childId", "==", childId)
    .where("status", "==", "approved")
    .get();

  const toRemove = snap.docs.filter((d) => {
    const startAt = d.data().startAt as admin.firestore.Timestamp | undefined;
    return startAt ? startAt.toMillis() >= cutoff.toMillis() : false;
  });

  if (toRemove.length === 0) return { removed: 0, balanceAdjusted: 0 };

  const balanceRef = db.doc(`teams/${teamId}/children/${childId}/dayBalance/main`);

  const removed = await db.runTransaction(async (tx) => {
    const balanceSnap = await tx.get(balanceRef);
    const balance = balanceSnap.exists ? (balanceSnap.data() as DayBalanceDoc) : null;

    let reversedDelta = 0;
    for (const d of toRemove) {
      reversedDelta += (d.data().balanceDeltaDays as number | undefined) ?? 0;
    }

    for (const d of toRemove) {
      // Markera som borttagen i stället för att radera, så att en
      // felaktig rensning går att felsöka i efterhand.
      tx.update(d.ref, {
        status: "cancelled",
        cancelledBy: uid,
        cancelledAt: admin.firestore.FieldValue.serverTimestamp(),
        cancelledReason: "custody_cycle_changed",
      });
    }

    if (balance) {
      const newBalance = balance.balanceDays - reversedDelta;
      tx.set(balanceRef, {
        ...balance,
        balanceDays: newBalance,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      const historyRef = db.collection(`teams/${teamId}/children/${childId}/dayBalanceHistory`).doc();
      tx.set(historyRef, {
        id: historyRef.id,
        childId,
        shiftRequestId: "",
        deltaDays: -reversedDelta,
        balanceAfter: newBalance,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        note: "Godkända ändringar rensade när grundschemat gjordes om",
      });
    }

    return toRemove.length;
  });

  return { removed, balanceAdjusted: true };
});

/**
 * Begär en justering av ställningen utan att flytta specifika dagar.
 * Skapar bara förfrågan — inget skrivs till dayBalance förrän motparten
 * godkänner, av samma skäl som för dagbyten: ställningen är en
 * överenskommelse mellan två personer, inte ett värde någon sätter själv.
 */
export const proposeBalanceAdjustment = onCall(async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Du måste vara inloggad.");

  const { teamId, childId, deltaDays, note } = request.data as {
    teamId: string;
    childId: string;
    deltaDays: number;
    note?: string;
  };

  if (!Number.isInteger(deltaDays) || deltaDays === 0) {
    throw new HttpsError("invalid-argument", "Antalet dagar måste vara ett heltal skilt från noll.");
  }
  if (Math.abs(deltaDays) > 60) {
    throw new HttpsError("invalid-argument", "Justeringen är orimligt stor.");
  }

  const teamSnap = await db.doc(`teams/${teamId}`).get();
  if (!teamSnap.exists) throw new HttpsError("not-found", "Team saknas.");
  const parentIds: string[] = teamSnap.data()?.parentIds ?? [];
  if (!parentIds.includes(uid)) throw new HttpsError("permission-denied", "Du är inte medlem i teamet.");
  if (parentIds.length < 2) {
    throw new HttpsError("failed-precondition", "Den andra föräldern har inte anslutit än.");
  }

  const ref = db.collection(`teams/${teamId}/children/${childId}/balanceRequests`).doc();
  await ref.set({
    id: ref.id,
    teamId,
    childId,
    requestedBy: uid,
    deltaDays,
    ...(note ? { note } : {}),
    status: "pending",
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  const others = parentIds.filter((p) => p !== uid);
  const requesterName = teamSnap.data()?.parentProfiles?.[uid]?.displayName ?? "Andra föräldern";
  await sendPushToUsers(db, others, {
    title: "Förslag om ändrad ställning",
    body: `${requesterName} föreslår en justering på ${Math.abs(deltaDays)} dag${
      Math.abs(deltaDays) === 1 ? "" : "ar"
    }.`,
  });

  return { id: ref.id };
});

/** Godkänner eller avböjer en begärd justering av ställningen. */
export const respondToBalanceAdjustment = onCall(async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Du måste vara inloggad.");

  const { teamId, childId, requestId, decision } = request.data as {
    teamId: string;
    childId: string;
    requestId: string;
    decision: "approved" | "declined";
  };
  if (!["approved", "declined"].includes(decision)) {
    throw new HttpsError("invalid-argument", "decision måste vara 'approved' eller 'declined'.");
  }

  const teamRef = db.doc(`teams/${teamId}`);
  const reqRef = db.doc(`teams/${teamId}/children/${childId}/balanceRequests/${requestId}`);
  const balanceRef = db.doc(`teams/${teamId}/children/${childId}/dayBalance/main`);

  let notifyRequestedBy: string | null = null;
  let responderName = "Andra föräldern";

  await db.runTransaction(async (tx) => {
    const [teamSnap, reqSnap, balanceSnap] = await Promise.all([
      tx.get(teamRef),
      tx.get(reqRef),
      tx.get(balanceRef),
    ]);

    if (!teamSnap.exists) throw new HttpsError("not-found", "Team saknas.");
    const parentIds: string[] = teamSnap.data()!.parentIds ?? [];
    if (!parentIds.includes(uid)) throw new HttpsError("permission-denied", "Du är inte medlem i teamet.");
    if (!reqSnap.exists) throw new HttpsError("not-found", "Förfrågan saknas.");

    const req = reqSnap.data() as { status: string; requestedBy: string; deltaDays: number };
    if (req.status !== "pending") throw new HttpsError("failed-precondition", "Förfrågan är redan hanterad.");
    if (req.requestedBy === uid) {
      throw new HttpsError("permission-denied", "Du kan inte godkänna din egen förfrågan.");
    }

    notifyRequestedBy = req.requestedBy;
    responderName = teamSnap.data()?.parentProfiles?.[uid]?.displayName ?? responderName;

    tx.update(reqRef, {
      status: decision,
      respondedBy: uid,
      respondedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    if (decision !== "approved") return;
    if (!balanceSnap.exists) throw new HttpsError("not-found", "Ingen ställning initierad för barnet.");

    const balance = balanceSnap.data() as DayBalanceDoc;
    const newBalance = balance.balanceDays + req.deltaDays;
    tx.set(balanceRef, {
      ...balance,
      balanceDays: newBalance,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    const historyRef = db.collection(`teams/${teamId}/children/${childId}/dayBalanceHistory`).doc();
    tx.set(historyRef, {
      id: historyRef.id,
      childId,
      shiftRequestId: "",
      deltaDays: req.deltaDays,
      balanceAfter: newBalance,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      note: "Manuell justering av ställningen",
    });
  });

  if (notifyRequestedBy) {
    await sendPushToUser(db, notifyRequestedBy, {
      title: decision === "approved" ? "Ställningen ändrades" : "Justeringen avböjdes",
      body: `${responderName} ${decision === "approved" ? "godkände" : "avböjde"} förslaget om ställningen.`,
    });
  }

  return { ok: true };
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

  const joinerProfile = profileFromAuth(request.auth!);
  const teamSnap = await db.doc(`teams/${result.teamId}`).get();
  const otherParentIds: string[] = (teamSnap.data()?.parentIds ?? []).filter((id: string) => id !== uid);
  if (otherParentIds.length > 0) {
    await sendPushToUsers(db, otherParentIds, {
      title: "Din partner har anslutit!",
      body: `${joinerProfile.displayName} har gått med i Varannan. Schemat är nu aktivt.`,
    });
  }

  return result;
});

/**
 * Håller den cachade kopian i teams/{teamId}.parentProfiles i synk när
 * en förälder byter namn eller profilbild i users/{uid}.
 */
export const syncDisplayNameToTeam = onDocumentWritten(
  { document: "users/{uid}", region: LEGACY_REGION },
  async (event) => {
  const after = event.data?.after?.data() as UserDoc | undefined;
  const before = event.data?.before?.data() as UserDoc | undefined;
  if (!after) return;

  const nameChanged = before?.displayName !== after.displayName;
  const avatarChanged = before?.avatarUrl !== after.avatarUrl;
  const teamChanged = before?.teamId !== after.teamId;
  if (!nameChanged && !avatarChanged && !teamChanged) return;

  const uid = event.params.uid;

  if (after.teamId) {
    await db.doc(`teams/${after.teamId}`).update({
      [`parentProfiles.${uid}`]: {
        uid,
        displayName: after.displayName,
        avatarUrl: after.avatarUrl ?? null,
      },
    });
  }

  // Anhörig/utomstående saknar users.teamId (kan höra till flera
  // familjer), så namnet cachas i stället i child.members[uid] på
  // varje kalender man är med på — se acceptCalendarInvite. Bara
  // namnbyte synkas hit (ingen avatarUrl där, "hos {namn}"-taggen
  // behöver bara texten). role "parent" hoppas över: den cachningen
  // sker redan ovan via parentProfiles.
  if (nameChanged) {
    const memberChildren = await db
      .collectionGroup("children")
      .where("memberUids", "array-contains", uid)
      .get();
    await Promise.all(
      memberChildren.docs
        .filter((d) => (d.data().members?.[uid]?.role as CalendarRole | undefined) !== "parent" && d.data().members?.[uid])
        .map((d) => d.ref.update({ [`members.${uid}.displayName`]: after.displayName }))
    );
  }
});


// ---------------------------------------------------------------------------
// Strukturändringar: grundschema och bytestid.
//
// De skriver om hela grundmönstret och påverkar alla framtida dagar, så
// de följer samma regel som en enskild dag: motpartens läge avgör om
// ändringen gäller direkt eller måste godkännas först.
// ---------------------------------------------------------------------------

/** Vem ska svara på en ändring i den här kalendern? Null om man är ensam. */
async function counterpartFor(
  teamId: string,
  childId: string,
  uid: string,
): Promise<string | null> {
  const [teamSnap, childSnap] = await Promise.all([
    db.doc(`teams/${teamId}`).get(),
    db.doc(`teams/${teamId}/children/${childId}`).get(),
  ]);
  const members = calendarParentIds(childSnap.data() as any, teamSnap.data() as any);
  return members.find((id) => id !== uid && id !== PENDING_PARTNER_ID) ?? null;
}

/**
 * Ska en STRUKTURändring (grundschema/bytestid) gälla direkt? Bara om
 * man är ensam i kalendern (ingen motpart att fråga än, t.ex. under
 * onboarding). Finns en motpart krävs ALLTID uttryckligt godkännande —
 * till skillnad från enskilda dagsbyten (ShiftRequestDoc) styrs detta
 * INTE av förälderns notify/request-val. Se avtalstexten i appen
 * (lib/agreementText.ts): grundschemat kan aldrig ändras ensidigt.
 */
function structureChangeAppliesDirectly(counterpart: string | null): boolean {
  return !counterpart;
}

async function createStructureRequest(args: {
  teamId: string;
  childId: string;
  requestedBy: string;
  addressedTo: string;
  kind: "cycle" | "switchHour";
  payload: Record<string, unknown>;
  summary: string;
}): Promise<{ pending: true; requestId: string }> {
  const ref = db.collection(`teams/${args.teamId}/scheduleStructureRequests`).doc();
  await ref.set({
    id: ref.id,
    ...args,
    status: "pending",
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  const teamSnap = await db.doc(`teams/${args.teamId}`).get();
  const name =
    teamSnap.data()?.parentProfiles?.[args.requestedBy]?.displayName ?? "Den andra föräldern";
  await sendPushToUsers(db, [args.addressedTo], {
    title: "Förslag på schemaändring",
    body: `${name} vill ändra: ${args.summary}`,
  });

  return { pending: true, requestId: ref.id };
}

/** Verkställer en strukturändring. Delas av direktvägen och godkännandet. */
async function applyStructureChange(
  kind: "cycle" | "switchHour",
  payload: any,
  uid: string,
): Promise<void> {
  if (kind === "switchHour") {
    await db
      .doc(`teams/${payload.teamId}/children/${payload.childId}/custodyCycle/main`)
      .update({ switchHour: payload.switchHour });
    return;
  }
  await setupCustodyCycle(onboardingDb, { ...payload, updatedBy: uid });
}

export const respondToStructureRequest = onCall(async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Du måste vara inloggad.");

  const { teamId, requestId, decision } = request.data as {
    teamId?: string;
    requestId?: string;
    decision?: "approved" | "declined";
  };
  if (!teamId || !requestId || !decision) {
    throw new HttpsError("invalid-argument", "teamId, requestId och decision krävs.");
  }

  const ref = db.doc(`teams/${teamId}/scheduleStructureRequests/${requestId}`);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError("not-found", "Förslaget finns inte.");
  const req = snap.data() as any;

  if (req.status !== "pending") {
    throw new HttpsError("failed-precondition", "Förslaget är redan besvarat.");
  }
  // Bara den som förslaget riktades till får svara — annars kunde
  // förslagsställaren godkänna sitt eget förslag.
  if (req.addressedTo !== uid) {
    throw new HttpsError("permission-denied", "Det här förslaget är inte ställt till dig.");
  }

  if (decision === "approved") {
    await applyStructureChange(req.kind, req.payload, req.requestedBy);
  }

  await ref.update({
    status: decision,
    respondedBy: uid,
    respondedAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  const teamSnap = await db.doc(`teams/${teamId}`).get();
  const name = teamSnap.data()?.parentProfiles?.[uid]?.displayName ?? "Den andra föräldern";
  await sendPushToUsers(db, [req.requestedBy], {
    title: decision === "approved" ? "Schemaändring godkänd" : "Schemaändring avböjd",
    body: `${name} ${decision === "approved" ? "godkände" : "avböjde"}: ${req.summary}`,
  });

  return { ok: true };
});

export const saveCustodyCycle = onCall(async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Du måste vara inloggad.");
  const raw = request.data as Parameters<typeof setupCustodyCycle>[1];

  const teamSnap = await db.doc(`teams/${raw.teamId}`).get();
  const parentIds: string[] = teamSnap.data()?.parentIds ?? [];
  if (!parentIds.includes(uid)) throw new HttpsError("permission-denied", "Du är inte medlem i teamet.");

  // Blocken måste peka på teamets faktiska föräldrar (eller platshållaren
  // för en förälder som ännu inte bjudits in) — annars blir schemat
  // omöjligt att rendera (uid:t matchar ingen användare).
  const blockParents = new Set(raw.blocks.map((b) => b.parentId));
  for (const pid of blockParents) {
    if (pid !== PENDING_PARTNER_ID && !parentIds.includes(pid)) {
      throw new HttpsError("invalid-argument", `Okänd förälder i schemat: ${pid}`);
    }
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw.cycleStartDate)) {
    throw new HttpsError("invalid-argument", "cycleStartDate måste vara YYYY-MM-DD.");
  }

  // Ett schema som sätts upp FÖRSTA gången (onboarding) har ingen
  // motpart att fråga och inget tidigare schema att skriva över, så det
  // gäller alltid direkt. Det är bara ändringar av ett befintligt
  // schema som kan behöva godkännas.
  const cycleRef = db.doc(`teams/${raw.teamId}/children/${raw.childId}/custodyCycle/main`);
  const isFirstSetup = !(await cycleRef.get()).exists;

  const counterpart = await counterpartFor(raw.teamId, raw.childId, uid);
  if (isFirstSetup || structureChangeAppliesDirectly(counterpart)) {
    await setupCustodyCycle(onboardingDb, { ...raw, updatedBy: uid });
    if (!isFirstSetup && counterpart) {
      const name = teamSnap.data()?.parentProfiles?.[uid]?.displayName ?? "Den andra föräldern";
      await sendPushToUsers(db, [counterpart], {
        title: "Grundschemat ändrades",
        body: `${name} gjorde om grundschemat.`,
      });
    }
    return { ok: true, pending: false };
  }

  return createStructureRequest({
    teamId: raw.teamId,
    childId: raw.childId,
    requestedBy: uid,
    addressedTo: counterpart!,
    kind: "cycle",
    payload: raw as any,
    summary: "nytt grundschema",
  });
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
  const childRef = db.doc(`teams/${teamId}/children/${childId}`);
  const requestRef = db.doc(`teams/${teamId}/shiftRequests/${shiftRequestId}`);
  const cycleRef = db.doc(`teams/${teamId}/children/${childId}/custodyCycle/main`);
  const balanceRef = db.doc(`teams/${teamId}/children/${childId}/dayBalance/main`);
  const historyRef = db.collection(`teams/${teamId}/children/${childId}/dayBalanceHistory`).doc();

  let notifyRequestedBy: string | null = null;
  let responderName = "Andra föräldern";
  // true om det här svaret inte räckte för att verkställa bytet — en
  // anhörigs förslag (etapp 4) kräver BÅDA föräldrarnas ja, så ett enda
  // godkännande sparar bara framsteget och väntar på nästa.
  let stillPending = false;

  const preSnap = await requestRef.get();
  const preData = preSnap.data() as ShiftRequestDoc | undefined;
  const overlapping =
    decision === "approved" && preData
      ? await findOverlappingApproved(
          teamId,
          childId,
          preData.startAt.seconds * 1000,
          preData.endAt ? preData.endAt.seconds * 1000 : null,
          [shiftRequestId]
        )
      : [];
  // En äldre godkänd avvikelse som HELT täcks av den här förfrågan ersätts
  // (avbryts) i stället för att blockera godkännandet. En som sticker ut
  // utanför perioden går inte att dela och är kvar som hård krock.
  const { contained: supersededApproved, partial: partialOverlap } = splitContainedOverlap(
    overlapping,
    preData?.startAt ? preData.startAt.seconds * 1000 : 0,
    preData?.endAt ? preData.endAt.seconds * 1000 : null
  );

  await db.runTransaction(async (tx) => {
    const [teamSnap, childSnap, requestSnap] = await Promise.all([
      tx.get(teamRef),
      tx.get(childRef),
      tx.get(requestRef),
    ]);

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

    // Etapp 4 (docs/roller-och-medlemskap.md): räkna ALLTID ut de riktiga
    // godkännarna här, server-sidan — lita aldrig på ett requiredApprovers
    // klienten skrev vid create (samma härdning som blockingApprovers
    // redan gör för kalenderinbjudningar). En anhörigs förslag (requestedBy
    // är inte en av kalenderns riktiga föräldrar) kräver BÅDA föräldrarnas
    // ja; ett förälder-till-förälder-byte behåller dagens
    // enkelgodkännande (motparten ensam).
    const calendarParents = calendarParentIds(childSnap.data() as any, teamSnap.data() as any).filter(
      (id) => id !== PENDING_PARTNER_ID
    );
    const realRequiredApprovers = calendarParents.includes(shiftRequest.requestedBy)
      ? null
      : calendarParents;

    if (realRequiredApprovers) {
      if (!realRequiredApprovers.includes(uid)) {
        throw new HttpsError("permission-denied", "Du kan inte svara på den här förfrågan.");
      }
    } else if (shiftRequest.requestedBy === uid) {
      // Bara MOTPARTEN (inte den som föreslog) får godkänna/avböja.
      throw new HttpsError("permission-denied", "Du kan inte godkänna din egen förfrågan.");
    }

    notifyRequestedBy = shiftRequest.requestedBy;
    responderName = teamSnap.data()?.parentProfiles?.[uid]?.displayName ?? responderName;

    if (decision === "declined") {
      tx.update(requestRef, {
        status: "declined",
        respondedBy: uid,
        respondedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      return;
    }

    if (realRequiredApprovers) {
      const approvedBy = Array.from(new Set([...(shiftRequest.approvedBy ?? []), uid]));
      const stillBlocking = blockingApprovers(
        realRequiredApprovers,
        shiftRequest.requestedBy,
        approvedBy,
        teamSnap.data() as any
      );
      if (stillBlocking.length > 0) {
        // Inte alla krävda föräldrar har sagt ja än — spara framsteget,
        // men verkställ INTE (ingen ställnings-transaktion, status kvar
        // "pending") förrän den sista har godkänt.
        tx.update(requestRef, {
          requiredApprovers: realRequiredApprovers,
          approvedBy: admin.firestore.FieldValue.arrayUnion(uid),
        });
        stillPending = true;
        return;
      }
    }

    if (decision === "approved" && partialOverlap.length > 0) {
      throw new HttpsError(
        "failed-precondition",
        "Perioden överlappar bara delvis en redan godkänd ändring och går inte att ersätta automatiskt. Avböj den ena först."
      );
    }

    const [cycleSnap, balanceSnap] = await Promise.all([tx.get(cycleRef), tx.get(balanceRef)]);
    if (!cycleSnap.exists) throw new HttpsError("not-found", "Ingen boendecykel konfigurerad för barnet.");
    if (!balanceSnap.exists) throw new HttpsError("not-found", "Ingen ställning initierad för barnet.");

    const cycle = cycleSnap.data() as CustodyCycleDoc;
    const currentBalance = balanceSnap.data() as DayBalanceDoc;

    // Avbryt äldre godkända avvikelser som helt täcks av den här och backa
    // deras balans-delta, sedan appliceras den nya ovanpå.
    let baseBalance = currentBalance;
    if (supersededApproved.length > 0) {
      const reversed = cancelSupersededInTx(
        tx,
        teamId,
        childId,
        supersededApproved,
        uid,
        currentBalance.balanceDays
      );
      baseBalance = { ...currentBalance, balanceDays: currentBalance.balanceDays - reversed };
    }

    const approvedRequest: ShiftRequestDoc = {
      ...shiftRequest,
      status: "approved",
      respondedBy: uid,
    };

    const { updatedBalance, deltaDays } = applyApprovedShiftToBalance(baseBalance, cycle, approvedRequest);

    tx.update(requestRef, {
      status: "approved",
      respondedBy: uid,
      respondedAt: admin.firestore.FieldValue.serverTimestamp(),
      balanceDeltaDays: deltaDays,
      ...(realRequiredApprovers
        ? { requiredApprovers: realRequiredApprovers, approvedBy: admin.firestore.FieldValue.arrayUnion(uid) }
        : {}),
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

  if (notifyRequestedBy) {
    await sendPushToUser(db, notifyRequestedBy, {
      title: stillPending ? "Ett godkännande till krävs" : decision === "approved" ? "Bytet godkändes" : "Bytet avböjdes",
      body: stillPending
        ? `${responderName} godkände — väntar på ytterligare en förälder innan bytet gäller.`
        : decision === "approved"
          ? `${responderName} godkände ändringen av schemat.`
          : `${responderName} avböjde ändringen av schemat.`,
    });
  }

  return { ok: true, pending: stillPending };
});

// ---------------------------------------------------------------------------
// 1b. approveShiftRequestBatch — samma sak som approveShiftRequest, men
//     för flera shiftRequests som skickades tillsammans (samma batchId)
//     från kalenderns ändringsläge. Godkänns/avböjs som EN atomisk
//     transaktion, så ställningen aldrig kan hamna i otakt om något
//     misslyckas halvvägs.
// ---------------------------------------------------------------------------

export const approveShiftRequestBatch = onCall(async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Du måste vara inloggad.");

  const { teamId, childId, batchId, decision } = request.data as {
    teamId: string;
    childId: string;
    batchId: string;
    decision: "approved" | "declined";
  };

  if (!["approved", "declined"].includes(decision)) {
    throw new HttpsError("invalid-argument", "decision måste vara 'approved' eller 'declined'.");
  }

  const teamRef = db.doc(`teams/${teamId}`);
  const childRef = db.doc(`teams/${teamId}/children/${childId}`);
  const cycleRef = db.doc(`teams/${teamId}/children/${childId}/custodyCycle/main`);
  const balanceRef = db.doc(`teams/${teamId}/children/${childId}/dayBalance/main`);

  let notifyRequestedBy: string | null = null;
  let responderName = "Andra föräldern";
  let dayCount = 0;
  // Se approveShiftRequest — samma etapp 4-logik, bara tillämpad på hela
  // batchen i ett svep (alla poster delar requestedBy/childId).
  let stillPending = false;

  // Överlappskoll före transaktionen, av samma skäl som i
  // approveShiftRequest. Äldre godkända avvikelser som HELT täcks av en dag
  // i batchen ersätts (avbryts); bara en som sticker ut utanför är kvar som
  // hård krock.
  const supersededById = new Map<string, admin.firestore.QueryDocumentSnapshot>();
  if (decision === "approved") {
    const preBatch = await db
      .collection(`teams/${teamId}/shiftRequests`)
      .where("batchId", "==", batchId)
      .get();
    const batchIds = preBatch.docs.map((d) => d.id);
    for (const d of preBatch.docs) {
      const data = d.data() as ShiftRequestDoc;
      const startMs = data.startAt.seconds * 1000;
      const endMs = data.endAt ? data.endAt.seconds * 1000 : null;
      const clash = await findOverlappingApproved(teamId, childId, startMs, endMs, batchIds);
      const { contained, partial } = splitContainedOverlap(clash, startMs, endMs);
      if (partial.length > 0) {
        throw new HttpsError(
          "failed-precondition",
          "En eller flera dagar överlappar bara delvis en redan godkänd ändring och går inte att ersätta automatiskt. Avböj den ena först."
        );
      }
      for (const c of contained) supersededById.set(c.id, c);
    }
  }
  const superseded = [...supersededById.values()];

  await db.runTransaction(async (tx) => {
    const [teamSnap, childSnap] = await Promise.all([tx.get(teamRef), tx.get(childRef)]);
    if (!teamSnap.exists) throw new HttpsError("not-found", "Team saknas.");
    const parentIds: string[] = teamSnap.data()!.parentIds;
    if (!parentIds.includes(uid)) {
      throw new HttpsError("permission-denied", "Du är inte medlem i det här teamet.");
    }

    const batchSnap = await tx.get(
      db.collection(`teams/${teamId}/shiftRequests`).where("batchId", "==", batchId)
    );
    if (batchSnap.empty) throw new HttpsError("not-found", "Förfrågan saknas.");

    const requests = batchSnap.docs.map((d) => d.data() as ShiftRequestDoc);
    dayCount = requests.length;
    notifyRequestedBy = requests[0]?.requestedBy ?? null;
    responderName = teamSnap.data()?.parentProfiles?.[uid]?.displayName ?? responderName;

    // Etapp 4 — se approveShiftRequest för resonemanget. Hela batchen delar
    // requestedBy/childId, så beräkningen görs en gång.
    const calendarParents = calendarParentIds(childSnap.data() as any, teamSnap.data() as any).filter(
      (id) => id !== PENDING_PARTNER_ID
    );
    const requestedBy = requests[0]?.requestedBy;
    const realRequiredApprovers =
      requestedBy && !calendarParents.includes(requestedBy) ? calendarParents : null;

    for (const req of requests) {
      if (req.status !== "pending") {
        throw new HttpsError("failed-precondition", "Förfrågan är redan hanterad.");
      }
      if (realRequiredApprovers) {
        if (!realRequiredApprovers.includes(uid)) {
          throw new HttpsError("permission-denied", "Du kan inte svara på den här förfrågan.");
        }
      } else if (req.requestedBy === uid) {
        // Bara MOTPARTEN (inte den som föreslog) får godkänna/avböja.
        throw new HttpsError("permission-denied", "Du kan inte godkänna din egen förfrågan.");
      }
    }

    if (decision === "declined") {
      for (const docSnap of batchSnap.docs) {
        tx.update(docSnap.ref, {
          status: "declined",
          respondedBy: uid,
          respondedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      }
      return;
    }

    if (realRequiredApprovers) {
      // approvedBy delas mellan alla poster i batchen (samma requestedBy) —
      // ta unionen av vad var och en redan har, plus mig.
      const approvedBySoFar = new Set<string>();
      for (const req of requests) for (const id of req.approvedBy ?? []) approvedBySoFar.add(id);
      approvedBySoFar.add(uid);
      const approvedBy = [...approvedBySoFar];
      const stillBlocking = blockingApprovers(realRequiredApprovers, requestedBy!, approvedBy, teamSnap.data() as any);
      if (stillBlocking.length > 0) {
        for (const docSnap of batchSnap.docs) {
          tx.update(docSnap.ref, {
            requiredApprovers: realRequiredApprovers,
            approvedBy: admin.firestore.FieldValue.arrayUnion(uid),
          });
        }
        stillPending = true;
        return;
      }
    }

    const [cycleSnap, balanceSnap] = await Promise.all([tx.get(cycleRef), tx.get(balanceRef)]);
    if (!cycleSnap.exists) throw new HttpsError("not-found", "Ingen boendecykel konfigurerad för barnet.");
    if (!balanceSnap.exists) throw new HttpsError("not-found", "Ingen ställning initierad för barnet.");

    const cycle = cycleSnap.data() as CustodyCycleDoc;
    let runningBalance = balanceSnap.data() as DayBalanceDoc;
    let totalDelta = 0;

    // Avbryt äldre godkända avvikelser som helt täcks av den här batchen och
    // backa deras balans-delta innan batchens dagar appliceras ovanpå.
    if (superseded.length > 0) {
      const reversed = cancelSupersededInTx(tx, teamId, childId, superseded, uid, runningBalance.balanceDays);
      runningBalance = { ...runningBalance, balanceDays: runningBalance.balanceDays - reversed };
    }

    // Applicera varje förfrågan i tur och ordning — nästa förfrågans
    // avvikelse räknas mot ställningen EFTER föregåendes justering.
    for (const docSnap of batchSnap.docs) {
      const req = docSnap.data() as ShiftRequestDoc;
      const approvedRequest: ShiftRequestDoc = { ...req, status: "approved", respondedBy: uid };
      const { updatedBalance, deltaDays } = applyApprovedShiftToBalance(runningBalance, cycle, approvedRequest);
      runningBalance = updatedBalance;
      totalDelta += deltaDays;

      tx.update(docSnap.ref, {
        status: "approved",
        respondedBy: uid,
        respondedAt: admin.firestore.FieldValue.serverTimestamp(),
        balanceDeltaDays: deltaDays,
        ...(realRequiredApprovers
          ? { requiredApprovers: realRequiredApprovers, approvedBy: admin.firestore.FieldValue.arrayUnion(uid) }
          : {}),
      });
      const historyRef = db.collection(`teams/${teamId}/children/${childId}/dayBalanceHistory`).doc();
      tx.set(historyRef, {
        id: historyRef.id,
        childId,
        shiftRequestId: docSnap.id,
        deltaDays,
        balanceAfter: runningBalance.balanceDays,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    }

    tx.set(balanceRef, {
      ...runningBalance,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  });

  if (notifyRequestedBy) {
    const dayLabel = `${dayCount} dag${dayCount === 1 ? "" : "ar"}`;
    await sendPushToUser(db, notifyRequestedBy, {
      title: stillPending ? "Ett godkännande till krävs" : decision === "approved" ? "Ändringen godkändes" : "Ändringen avböjdes",
      body: stillPending
        ? `${responderName} godkände förslaget om ${dayLabel} — väntar på ytterligare en förälder.`
        : decision === "approved"
          ? `${responderName} godkände förslaget om ${dayLabel}.`
          : `${responderName} avböjde förslaget om ${dayLabel}.`,
    });
  }

  return { ok: true, pending: stillPending };
});

// ---------------------------------------------------------------------------
// 1f. addChild / renameChild — ett barn ÄR en kalender i appen: det är
//     dokumentet som bär namnet, grundschemat och ställningen.
//
//     Måste vara en callable eftersom skapandet också ska uppdatera
//     teams/{teamId}.childIds, och team-dokumentet är låst för
//     klientskrivningar i firestore.rules. (Den tidigare klientversionen
//     skrev barnet men fick permission-denied på childIds-uppdateringen,
//     vilket bl.a. gjorde att överlämningspåminnelser aldrig skickades
//     för barn som lagts till efter onboarding.)
// ---------------------------------------------------------------------------

export const addChild = onCall(async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Du måste vara inloggad.");

  const { teamId, name, birthYear } = request.data as {
    teamId?: string;
    name?: string;
    birthYear?: number;
  };
  const trimmed = (name ?? "").trim();
  if (!teamId || !trimmed) {
    throw new HttpsError("invalid-argument", "teamId och namn krävs.");
  }
  if (trimmed.length > 40) {
    throw new HttpsError("invalid-argument", "Namnet får vara högst 40 tecken.");
  }

  const teamRef = db.doc(`teams/${teamId}`);
  const teamSnap = await teamRef.get();
  if (!teamSnap.exists) throw new HttpsError("not-found", "Teamet finns inte.");

  const parentIds: string[] = teamSnap.data()?.parentIds ?? [];
  if (!parentIds.includes(uid)) {
    throw new HttpsError("permission-denied", "Du tillhör inte teamet.");
  }

  const childRef = db.collection(`teams/${teamId}/children`).doc();
  const sharedParentIds = parentIds.filter((id: string) => id !== PENDING_PARTNER_ID);
  const now = admin.firestore.FieldValue.serverTimestamp();
  // members/memberUids speglar sharedParentIds som "parent" redan vid
  // skapandet, så nya kalendrar aldrig behöver migreringsskriptet —
  // se docs/roller-och-medlemskap.md.
  const members: Record<string, { role: "parent"; addedAt: FirebaseFirestore.FieldValue; invitedBy: string }> = {};
  for (const parentUid of sharedParentIds) {
    members[parentUid] = { role: "parent", addedAt: now, invitedBy: uid };
  }
  const batch = db.batch();
  batch.set(childRef, {
    id: childRef.id,
    teamId,
    name: trimmed,
    // Nya kalendrar delas med teamets nuvarande föräldrar. Delningen
    // ligger på barnet så att den kan ändras per kalender senare.
    parentIds: sharedParentIds,
    members,
    memberUids: sharedParentIds,
    createdAt: now,
    ...(typeof birthYear === "number" ? { birthYear } : {}),
  });
  batch.update(teamRef, {
    childIds: admin.firestore.FieldValue.arrayUnion(childRef.id),
  });
  await batch.commit();

  return { childId: childRef.id };
});

export const renameChild = onCall(async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Du måste vara inloggad.");

  const { teamId, childId, name } = request.data as {
    teamId?: string;
    childId?: string;
    name?: string;
  };
  const trimmed = (name ?? "").trim();
  if (!teamId || !childId || !trimmed) {
    throw new HttpsError("invalid-argument", "teamId, childId och namn krävs.");
  }
  if (trimmed.length > 40) {
    throw new HttpsError("invalid-argument", "Namnet får vara högst 40 tecken.");
  }

  const teamSnap = await db.doc(`teams/${teamId}`).get();
  if (!teamSnap.exists) throw new HttpsError("not-found", "Teamet finns inte.");

  const parentIds: string[] = teamSnap.data()?.parentIds ?? [];
  if (!parentIds.includes(uid)) {
    throw new HttpsError("permission-denied", "Du tillhör inte teamet.");
  }

  await db.doc(`teams/${teamId}/children/${childId}`).update({ name: trimmed });
  return { ok: true };
});

/**
 * Lämnar eller raderar en kalender — för VILKEN roll som helst (förälder,
 * anhörig eller utomstående). Kräver textbekräftelse "RADERA", samma
 * mönster som deleteMyAccount, eftersom båda utfallen är permanenta.
 *
 * Kalendern ÄR barnet, och delas av alla i child.members (föräldrar i
 * child.parentIds är alltid en delmängd). Därför finns två utfall:
 *
 *  - Är du INTE ensam medlem kvar (oavsett roll på de andra): du lämnar
 *    bara. Kalendern med allt innehåll finns kvar hos de andra. Är du
 *    förälder byts ditt uid mot PENDING_PARTNER_ID i grundschemat,
 *    precis som när man bygger ett schema innan partnern anslutit — då
 *    glider nästa person in på samma plats utan att schemat byggs om.
 *    En anhörig/utomstående som lämnar rör varken parentIds eller
 *    grundschemat — hen fanns aldrig där.
 *
 *  - Är du sista medlemmen av ALLA roller: allt raderas. Firestore
 *    kaskadraderar inte, så subkollektionerna städas uttryckligen —
 *    annars blir schema, ställning, barninfo och konton kvar som
 *    föräldralösa dokument. En kalender som fortfarande har kvarvarande
 *    anhöriga/utomstående raderas ALDRIG bara för att sista föräldern
 *    lämnat — de behåller sin läsrätt tills de också lämnar.
 *
 * Ställningen behålls när en förälder lämnar (uttryckligt val): saldot
 * är en fortsättning på kalenderns historik, inte på relationen till en
 * viss person.
 */
export const deleteChild = onCall(async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Du måste vara inloggad.");

  const { teamId, childId, confirmation } = request.data as {
    teamId?: string;
    childId?: string;
    confirmation?: string;
  };
  if (!teamId || !childId) {
    throw new HttpsError("invalid-argument", "teamId och childId krävs.");
  }
  if (confirmation !== "RADERA") {
    throw new HttpsError("invalid-argument", "Skriv RADERA för att bekräfta.");
  }

  const teamRef = db.doc(`teams/${teamId}`);
  const teamSnap = await teamRef.get();
  if (!teamSnap.exists) throw new HttpsError("not-found", "Teamet finns inte.");

  const childRef = db.doc(`teams/${teamId}/children/${childId}`);
  const childSnap = await childRef.get();
  if (!childSnap.exists) throw new HttpsError("not-found", "Kalendern finns inte.");

  const child = childSnap.data() as any;
  const team = teamSnap.data() as any;
  const role = calendarRoleFor(uid, child, team);
  if (!role) {
    throw new HttpsError("permission-denied", "Du delar inte den här kalendern.");
  }

  // "Medlem" = förälder, anhörig ELLER utomstående. Faller tillbaka på
  // calendarParentIds för kalendrar från innan members/memberUids fanns
  // (samma fallback som calendarRoleFor).
  const allMembers: string[] = (child.memberUids ?? calendarParentIds(child, team)).filter(
    (id: string) => id !== PENDING_PARTNER_ID
  );
  const remainingMembers = allMembers.filter((id) => id !== uid);

  // ---- Fall 1: någon annan medlem (vilken roll som helst) är kvar. ----
  if (remainingMembers.length > 0) {
    const batch = db.batch();
    const patch: Record<string, any> = {
      [`members.${uid}`]: admin.firestore.FieldValue.delete(),
      memberUids: admin.firestore.FieldValue.arrayRemove(uid),
    };
    if (role === "parent") {
      // KÄND LUCKA: blir detta en tom lista (sista föräldern lämnade,
      // men en anhörig/utomstående är kvar) faller calendarParentIds()
      // tillbaka på teams.parentIds, som fortfarande visar de(n)
      // förälder(-ar) som just lämnade — de dyker upp igen som
      // "kalenderns föräldrar" för den kvarvarande anhörigen tills
      // kalendern får en ny riktig förälder. Kosmetiskt (ingen krasch,
      // ingen läckt data), inte värt komplexiteten att fixa förrän någon
      // faktiskt hamnar där.
      patch.parentIds = calendarParentIds(child, team).filter(
        (id) => id !== uid && id !== PENDING_PARTNER_ID
      );
    }
    batch.update(childRef, patch);

    if (role === "parent") {
      const cycleRef = childRef.collection("custodyCycle").doc("main");
      const cycleSnap = await cycleRef.get();
      if (cycleSnap.exists) {
        // Blocken pekar på uid:n. Byt mina mot platshållaren så att den
        // som bjuds in härnäst ärver mina dagar i stället för att schemat
        // pekar på någon som inte längre är med.
        const cycle = cycleSnap.data() as CustodyCycleDoc;
        const blocks = (cycle.blocks ?? []).map((b) =>
          b.parentId === uid ? { ...b, parentId: PENDING_PARTNER_ID } : b,
        );
        batch.update(cycleRef, { blocks });
      }
    }

    await batch.commit();

    if (role === "parent") {
      // Prenumerationstoken som var mina blir meningslösa. Bara
      // föräldrar kan ha några (createCalendarFeedToken är parent-only).
      const tokens: Record<string, string> = team?.calendarFeedTokens ?? {};
      const mine = Object.keys(tokens).filter((k) => k === `${childId}:${uid}`);
      if (mine.length > 0) {
        const patch2: Record<string, any> = {};
        for (const key of mine) patch2[`calendarFeedTokens.${key}`] = admin.firestore.FieldValue.delete();
        await teamRef.update(patch2);
      }
    }

    const leaverName =
      role === "parent"
        ? team?.parentProfiles?.[uid]?.displayName ?? "Den andra föräldern"
        : child.members?.[uid]?.displayName ?? (role === "viewer" ? "En utomstående" : "En anhörig");
    const childName = child.name ?? "kalendern";
    await sendPushToUsers(db, remainingMembers, {
      title: `${leaverName} lämnade ${childName}`,
      body: "Kalendern finns kvar. Du kan bjuda in någon ny att dela den med.",
    });

    return { ok: true, left: true };
  }

  // ---- Fall 2: sista medlemmen av ALLA roller — radera allt. ----
  for (const sub of [
    "childInfo",
    "accounts",
    "custodyCycle",
    "dayBalance",
    "dayBalanceHistory",
    "balanceRequests",
  ]) {
    await deleteQueryInBatches(childRef.collection(sub));
  }

  // Team-nivådokument som pekar på barnet.
  for (const col of ["shiftRequests", "packLists", "events", "notes", "todos", "chatMessages"]) {
    await deleteQueryInBatches(
      db.collection(`teams/${teamId}/${col}`).where("childId", "==", childId)
    );
  }

  await childRef.delete();

  const allChildren = await db.collection(`teams/${teamId}/children`).get();
  await teamRef.update({ childIds: allChildren.docs.map((d) => d.id) });

  const tokens: Record<string, string> = teamSnap.data()?.calendarFeedTokens ?? {};
  const staleKeys = Object.keys(tokens).filter((k) => k.startsWith(`${childId}:`));
  if (staleKeys.length > 0) {
    const patch: Record<string, any> = {};
    for (const key of staleKeys) patch[`calendarFeedTokens.${key}`] = admin.firestore.FieldValue.delete();
    await teamRef.update(patch);
  }

  return { ok: true, left: false };
});

/** Raderar alla dokument en fråga matchar, i lagom stora batchar. */
async function deleteQueryInBatches(
  query: admin.firestore.Query | admin.firestore.CollectionReference,
  batchSize = 200
): Promise<void> {
  while (true) {
    const snap = await query.limit(batchSize).get();
    if (snap.empty) return;
    const batch = db.batch();
    for (const doc of snap.docs) batch.delete(doc.ref);
    await batch.commit();
    if (snap.size < batchSize) return;
  }
}

// ---------------------------------------------------------------------------
// deleteMyAccount — permanent radering av det egna kontot.
//
// Går igenom VARJE kalender uid:t är med på (collectionGroup-fråga på
// memberUids, samma mönster som getMyCalendars — täcker både ett eget
// hem-team OCH kalendrar man bara är anhörig/utomstående på i andra
// familjer):
//   - role != "parent": tar bara bort medlemskapet på just den
//     kalendern (members/memberUids). Rör ingenting annat — en
//     anhörig äger inget.
//   - role == "parent", andra föräldrar kvar: lämnar kalendern, samma
//     mönster som deleteChild "Fall 1" — men städar ÄVEN
//     members/memberUids, vilket deleteChild inte gör (en känd lucka
//     där, inte värd att fixa separat eftersom den bara lämnar
//     ofarlig död data kvar; här måste det göras rätt eftersom uid:t
//     om en stund inte finns alls).
//   - role == "parent", sista föräldern: raderar HELA kalendern, samma
//     mönster som deleteChild "Fall 2".
// Sist: plockar bort uid ur teams.parentIds/parentProfiles överallt
// det stod som förälder, raderar users/{uid}, och raderar till sist
// Auth-kontot. Auth-raderingen görs SIST med flit: om något innan
// kastar är kontot ändå kvar och går att försöka radera igen, i
// stället för att låsa ute någon med halvraderad data.
// ---------------------------------------------------------------------------
export const deleteMyAccount = onCall(async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Du måste vara inloggad.");

  const { confirmation } = request.data as { confirmation?: string };
  if (confirmation !== "RADERA") {
    throw new HttpsError("invalid-argument", "Bekräftelsetexten stämmer inte.");
  }

  const childrenSnap = await db.collectionGroup("children").where("memberUids", "array-contains", uid).get();
  const parentTeamIds = new Set<string>();

  for (const childDoc of childrenSnap.docs) {
    const child = childDoc.data() as any;
    const teamId = child.teamId as string;
    const childRef = childDoc.ref;
    const teamRef = db.doc(`teams/${teamId}`);
    const teamSnap = await teamRef.get();
    const team = teamSnap.data();

    const role: CalendarRole = child.members?.[uid]?.role ?? "parent";

    if (role !== "parent") {
      await childRef.update({
        [`members.${uid}`]: admin.firestore.FieldValue.delete(),
        memberUids: admin.firestore.FieldValue.arrayRemove(uid),
      });
      continue;
    }

    parentTeamIds.add(teamId);
    const parents = calendarParentIds(child, team as any);
    const remainingParents = parents.filter((id) => id !== uid && id !== PENDING_PARTNER_ID);

    if (remainingParents.length > 0) {
      // Lämnar — kalendern finns kvar hos den andra föräldern.
      const cycleRef = childRef.collection("custodyCycle").doc("main");
      const cycleSnap = await cycleRef.get();
      const batch = db.batch();
      batch.update(childRef, {
        parentIds: remainingParents,
        [`members.${uid}`]: admin.firestore.FieldValue.delete(),
        memberUids: admin.firestore.FieldValue.arrayRemove(uid),
      });
      if (cycleSnap.exists) {
        const cycle = cycleSnap.data() as CustodyCycleDoc;
        const blocks = (cycle.blocks ?? []).map((b) =>
          b.parentId === uid ? { ...b, parentId: PENDING_PARTNER_ID } : b,
        );
        batch.update(cycleRef, { blocks });
      }
      await batch.commit();

      const tokens: Record<string, string> = team?.calendarFeedTokens ?? {};
      const mine = Object.keys(tokens).filter((k) => k === `${childRef.id}:${uid}`);
      if (mine.length > 0) {
        const patch: Record<string, any> = {};
        for (const key of mine) patch[`calendarFeedTokens.${key}`] = admin.firestore.FieldValue.delete();
        await teamRef.update(patch);
      }

      const leaverName = team?.parentProfiles?.[uid]?.displayName ?? "Den andra föräldern";
      const childName = child.name ?? "kalendern";
      await sendPushToUsers(db, remainingParents, {
        title: `${leaverName} har raderat sitt konto`,
        body: `${childName} finns kvar hos dig. Du kan bjuda in någon ny att dela den med.`,
      });
    } else {
      // Sista föräldern — radera hela kalendern.
      for (const sub of [
        "childInfo",
        "accounts",
        "custodyCycle",
        "dayBalance",
        "dayBalanceHistory",
        "balanceRequests",
      ]) {
        await deleteQueryInBatches(childRef.collection(sub));
      }
      for (const col of ["shiftRequests", "packLists", "events", "notes", "todos", "chatMessages"]) {
        await deleteQueryInBatches(db.collection(`teams/${teamId}/${col}`).where("childId", "==", childRef.id));
      }
      await childRef.delete();

      const remainingChildren = await db.collection(`teams/${teamId}/children`).get();
      await teamRef.update({ childIds: remainingChildren.docs.map((d) => d.id) });

      const tokens: Record<string, string> = team?.calendarFeedTokens ?? {};
      const staleKeys = Object.keys(tokens).filter((k) => k.startsWith(`${childRef.id}:`));
      if (staleKeys.length > 0) {
        const patch: Record<string, any> = {};
        for (const key of staleKeys) patch[`calendarFeedTokens.${key}`] = admin.firestore.FieldValue.delete();
        await teamRef.update(patch);
      }
    }
  }

  for (const teamId of parentTeamIds) {
    await db.doc(`teams/${teamId}`).update({
      parentIds: admin.firestore.FieldValue.arrayRemove(uid),
      [`parentProfiles.${uid}`]: admin.firestore.FieldValue.delete(),
    });
  }

  await db.doc(`users/${uid}`).delete();
  await admin.auth().deleteUser(uid);

  return { ok: true };
});


// ---------------------------------------------------------------------------
// 1g. Inbjudan till EN kalender — förälder, anhörig eller utomstående.
//
//     Skiljer sig från createInvite (som bjuder in till hela familjen och
//     bara kan användas en gång, innan team-uppsättningen är klar). Den
//     här används när man redan har en kalender och vill dela just den —
//     t.ex. efter att den andra föräldern lämnat och man vill koppla på
//     någon ny på samma schema, eller för att bjuda in en anhörig/
//     utomstående (etapp 2, docs/roller-och-medlemskap.md).
//
//     role == "parent" (eller utelämnad — det enda flödet innan etapp 2):
//     OFÖRÄNDRAT. Kräver färre än två föräldrar på kalendern, skapar
//     inbjudan direkt med status "sent", ingen godkännande-runda.
//
//     role == "relative" | "viewer": kräver godkännande av kalenderns
//     föräldrar innan koden genereras och mailas till den inbjudna
//     (dubbelt godkännande, se docs). Den inbjudande föräldern räknas
//     som redan godkänd (hen skapade ju inbjudan), och en förälder som
//     valt "notis" i stället för "godkännande" räknas också som redan
//     godkänd — bara de som faktiskt vill godkänna innan saker händer
//     blockerar (scheduleChangeModeFor, samma logik som schemaändringar
//     använder).
// ---------------------------------------------------------------------------

/** Svensk etikett för en roll, använd i mail/notiser. */
function roleLabel(role: CalendarRole): string {
  if (role === "relative") return "anhörig";
  if (role === "viewer") return "utomstående";
  return "förälder";
}

/**
 * Vilka av `requiredApprovers` måste FORTFARANDE klicka godkänn?
 * Utesluter den inbjudande föräldern (redan godkänd genom att skapa
 * inbjudan), alla som redan finns i `approvedBy`, och alla i
 * "notis"-läge (bara föräldrar som valt "godkännande" blockerar) —
 * se scheduleChangeModeFor i types/schema.ts.
 */
function blockingApprovers(
  requiredApprovers: string[],
  invitedBy: string,
  approvedBy: string[],
  team:
    | { scheduleChangeMode?: ScheduleChangeMode; parentProfiles?: Record<string, TeamParentProfile> }
    | null
    | undefined,
): string[] {
  return requiredApprovers.filter(
    (id) => id !== invitedBy && !approvedBy.includes(id) && scheduleChangeModeFor(team, id) === "request",
  );
}

/**
 * Hur länge en anhörig/utomstående har på sig att använda inbjudnings-
 * koden, räknat från att den FAKTISKT mailas (se "Alla klara — skicka"
 * nedan — godkännande-väntan drar inte av från den här tiden). Ändras
 * den, ändras både expiresAt och mailtexten automatiskt i samma veva.
 */
const CALENDAR_INVITE_TTL_HOURS = 7 * 24;

/**
 * Mailet för en anhörig/utomstående-inbjudan. HTML + text-fallback (för
 * mailklienter som inte visar HTML) — samma innehåll i båda, se
 * sendEmail/sendEmailOrThrow i email.ts.
 */
function calendarInviteEmailBody(args: {
  inviterName: string;
  childName: string;
  role: CalendarRole;
  code: string;
  shareUrl: string;
}): { text: string; html: string } {
  const { inviterName, childName, role, code, shareUrl } = args;
  const days = CALENDAR_INVITE_TTL_HOURS / 24;
  const intro = `${inviterName} har bjudit in dig som ${roleLabel(role)} till ${childName} i Varannan.`;
  const steps = [
    "Klicka på länken ovan eller kopiera den till din webbläsare",
    "Logga in eller skapa ett konto",
    "Granska och godkänn delningen",
    "Du får tillgång till barnets kalender och kan se schemaändringarna direkt",
  ];

  const text = [
    intro,
    "",
    `Inbjudningskod: ${code}`,
    `Eller öppna länken direkt: ${shareUrl}`,
    "",
    "Har du inget konto i Varannan sedan innan får du skapa ett först",
    "(det tar en minut) — därefter går du med automatiskt.",
    "",
    "Steg för steg:",
    ...steps.map((s, i) => `${i + 1}. ${s}`),
    "",
    `Du har ${days} dagar på dig att använda koden.`,
  ].join("\n");

  const html = `
    <div style="font-family: -apple-system, Helvetica, Arial, sans-serif; max-width: 480px; margin: 0 auto; color: #44403c;">
      <p style="font-size: 15px; line-height: 1.5;">${intro}</p>
      <p style="margin: 20px 0; text-align: center;">
        <a href="${shareUrl}"
           style="display: inline-block; background: #f43f5e; color: #ffffff; font-weight: 600;
                  text-decoration: none; padding: 12px 28px; border-radius: 999px; font-size: 15px;">
          Gå med i Varannan
        </a>
      </p>
      <p style="font-size: 13px; line-height: 1.5; color: #78716c;">
        Fungerar inte knappen? Öppna den här länken i din webbläsare:<br>
        <a href="${shareUrl}" style="color: #f43f5e;">${shareUrl}</a><br>
        Inbjudningskod: <strong>${code}</strong>
      </p>
      <p style="font-size: 13px; line-height: 1.5; color: #78716c;">
        Har du inget konto i Varannan sedan innan får du skapa ett först (det tar en minut)
        — därefter går du med automatiskt.
      </p>
      <p style="font-size: 14px; font-weight: 600; margin: 24px 0 8px;">Steg för steg</p>
      <ol style="font-size: 14px; line-height: 1.6; padding-left: 20px; margin: 0;">
        ${steps.map((s) => `<li>${s}</li>`).join("\n        ")}
      </ol>
      <p style="font-size: 13px; line-height: 1.5; color: #78716c; margin-top: 24px;">
        Du har <strong>${days} dagar</strong> på dig att använda koden.
      </p>
    </div>
  `.trim();

  return { text, html };
}

export const createCalendarInvite = onCall(
  { secrets: [GMAIL_USER, GMAIL_APP_PASSWORD] },
  async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Du måste vara inloggad.");

  const { teamId, childId, baseUrl, invitedEmail } = request.data as {
    teamId?: string;
    childId?: string;
    baseUrl?: string;
    invitedEmail?: string;
  };
  const role: CalendarRole = (request.data as { role?: CalendarRole })?.role ?? "parent";
  if (!["parent", "relative", "viewer"].includes(role)) {
    throw new HttpsError("invalid-argument", "Okänd roll.");
  }
  if (!teamId || !childId) {
    throw new HttpsError("invalid-argument", "teamId och childId krävs.");
  }
  if (role !== "parent" && !invitedEmail?.trim()) {
    throw new HttpsError("invalid-argument", "invitedEmail krävs för anhörig/utomstående.");
  }

  const [teamSnap, childSnap] = await Promise.all([
    db.doc(`teams/${teamId}`).get(),
    db.doc(`teams/${teamId}/children/${childId}`).get(),
  ]);
  if (!teamSnap.exists || !childSnap.exists) {
    throw new HttpsError("not-found", "Kalendern finns inte.");
  }
  const team = teamSnap.data();
  const child = childSnap.data();

  // calendarParents är alltid FÖRÄLDRARNA på kalendern (aldrig
  // anhöriga/utomstående) — samma definition som innan etapp 2. Bara
  // en förälder får bjuda in, oavsett vilken roll den nya personen ska
  // ha (tabellen i docs/roller-och-medlemskap.md: "Bjuda in" är nej
  // för både relative och viewer).
  const calendarParents = calendarParentIds(child as any, team as any).filter(
    (id) => id !== PENDING_PARTNER_ID,
  );
  if (!calendarParents.includes(uid)) {
    throw new HttpsError("permission-denied", "Du delar inte den här kalendern.");
  }
  if (role === "parent" && calendarParents.length >= 2) {
    throw new HttpsError("failed-precondition", "Kalendern delas redan av två föräldrar.");
  }

  // Samma origin-validering som createInvite: baseUrl kommer från
  // klienten och får inte kunna peka länken mot en phishing-domän.
  const allowed = (process.env.ALLOWED_APP_ORIGINS ?? "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
  const safeBaseUrl =
    baseUrl && allowed.includes(baseUrl) ? baseUrl : allowed[0] ?? "http://localhost:3000";

  const code = generateCalendarInviteCode();
  const expiresAt = new Date(Date.now() + CALENDAR_INVITE_TTL_HOURS * 60 * 60 * 1000);
  const shareUrl = `${safeBaseUrl.replace(/\/$/, "")}/join?code=${encodeURIComponent(code)}`;
  const childName = child?.name ?? "kalendern";

  if (role === "parent") {
    // Oförändrat: ingen godkännande-runda för föräldraflödet.
    await db.doc(`teamInvites/${code}`).set({
      teamId,
      childId,
      code,
      role,
      used: false,
      status: "sent",
      invitedBy: uid,
      baseUrl: safeBaseUrl,
      expiresAt: admin.firestore.Timestamp.fromDate(expiresAt),
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    return { code, expiresAt: expiresAt.toISOString(), shareUrl, status: "sent" as const };
  }

  // relative/viewer — dubbelt godkännande.
  const requiredApprovers = calendarParents;
  const blocking = blockingApprovers(requiredApprovers, uid, [], team);
  const status = blocking.length === 0 ? "sent" : "pending_approval";
  const approvedBy = status === "sent" ? requiredApprovers : [uid];

  await db.doc(`teamInvites/${code}`).set({
    teamId,
    childId,
    code,
    role,
    invitedEmail: invitedEmail!.trim(),
    used: false,
    status,
    invitedBy: uid,
    baseUrl: safeBaseUrl,
    requiredApprovers,
    approvedBy,
    expiresAt: admin.firestore.Timestamp.fromDate(expiresAt),
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    ...(status === "sent" ? { sentAt: admin.firestore.FieldValue.serverTimestamp() } : {}),
  });

  const inviterName = team?.parentProfiles?.[uid]?.displayName ?? "En förälder";

  if (status === "sent") {
    // Ensamförälder på kalendern, eller alla andra föräldrar i
    // notis-läge — ingen behöver klicka godkänn.
    const { text, html } = calendarInviteEmailBody({ inviterName, childName, role, code, shareUrl });
    await sendEmail(invitedEmail!.trim(), "Du är inbjuden till Varannan", text, html);
    return { code, expiresAt: expiresAt.toISOString(), shareUrl, status: "sent" as const };
  }

  // Väntar på godkännande — koden mailas INTE än. Notifiera bara de som
  // faktiskt behöver klicka godkänn.
  await sendPushToUsers(db, blocking, {
    title: "Väntar på ditt godkännande",
    body: `${inviterName} vill bjuda in någon som ${roleLabel(role)} till ${childName}.`,
  });

  return { code, expiresAt: expiresAt.toISOString(), shareUrl: null, status: "pending_approval" as const };
});

/** ABCDE-FGHIJ ur ett alfabet utan tecken som lätt förväxlas (0/O, 1/I). */
function generateCalendarInviteCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.randomBytes(10);
  let out = "";
  for (let i = 0; i < 10; i++) {
    out += alphabet[bytes[i] % alphabet.length];
    if (i === 4) out += "-";
  }
  return out;
}

/**
 * En förälder på kalendern godkänner (eller nekar) en väntande
 * anhörig/utomstående-inbjudan. Koden finns redan (den ÄR inbjudans
 * dokument-id) — när den sista nödvändiga godkännaren sagt ja mailas
 * den bara till den inbjudna nu, och status blir "sent".
 */
export const approveCalendarInvite = onCall(
  { secrets: [GMAIL_USER, GMAIL_APP_PASSWORD] },
  async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Du måste vara inloggad.");

  const { code: rawCode, decision } = request.data as { code?: string; decision?: "approve" | "decline" };
  if (!rawCode) throw new HttpsError("invalid-argument", "code krävs.");
  const code = rawCode.trim().toUpperCase();
  const wantsDecline = decision === "decline";

  const inviteRef = db.doc(`teamInvites/${code}`);
  const inviteSnap = await inviteRef.get();
  const invite = inviteSnap.data();
  if (!inviteSnap.exists || !invite) throw new HttpsError("not-found", "Inbjudan finns inte.");
  if (invite.status !== "pending_approval") {
    throw new HttpsError("failed-precondition", "Inbjudan väntar inte längre på godkännande.");
  }

  const requiredApprovers: string[] = invite.requiredApprovers ?? [];
  if (!requiredApprovers.includes(uid)) {
    throw new HttpsError("permission-denied", "Du är inte en av kalenderns föräldrar.");
  }

  if (wantsDecline) {
    await inviteRef.update({
      status: "expired",
      declinedBy: uid,
      respondedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    await sendPushToUser(db, invite.invitedBy, {
      title: "Inbjudan nekades",
      body: `En förälder sa nej till inbjudan för ${invite.invitedEmail ?? "den inbjudna"}.`,
    });
    return { status: "expired" as const };
  }

  const approvedBy: string[] = invite.approvedBy ?? [];
  if (approvedBy.includes(uid)) {
    // Redan godkänt — idempotent, gör inget mer.
    return { status: invite.status as "pending_approval" };
  }

  const teamSnap = await db.doc(`teams/${invite.teamId}`).get();
  const team = teamSnap.data();
  const newApprovedBy = [...approvedBy, uid];
  const stillBlocking = blockingApprovers(requiredApprovers, invite.invitedBy, newApprovedBy, team);

  if (stillBlocking.length > 0) {
    await inviteRef.update({ approvedBy: admin.firestore.FieldValue.arrayUnion(uid) });
    return { status: "pending_approval" as const };
  }

  // Alla klara — skicka. expiresAt sattes vid SKAPANDET av inbjudan
  // (CALENDAR_INVITE_TTL_HOURS från då) — om godkännandet dröjer äter
  // den väntetiden upp av samma fönster som den inbjudna sedan har på
  // sig att använda koden, så koden kunde vara "utgången" innan den ens
  // mailades. Ge den inbjudna sin FULLA väntetid från det att koden
  // FAKTISKT skickas.
  const newExpiresAt = new Date(Date.now() + CALENDAR_INVITE_TTL_HOURS * 60 * 60 * 1000);
  await inviteRef.update({
    approvedBy: admin.firestore.FieldValue.arrayUnion(uid),
    status: "sent",
    sentAt: admin.firestore.FieldValue.serverTimestamp(),
    expiresAt: admin.firestore.Timestamp.fromDate(newExpiresAt),
  });

  const childSnap = await db.doc(`teams/${invite.teamId}/children/${invite.childId}`).get();
  const childName = childSnap.data()?.name ?? "kalendern";
  const inviterName = team?.parentProfiles?.[invite.invitedBy]?.displayName ?? "En förälder";
  const baseUrl: string =
    invite.baseUrl ?? (process.env.ALLOWED_APP_ORIGINS ?? "").split(",")[0] ?? "http://localhost:3000";
  const shareUrl = `${baseUrl.replace(/\/$/, "")}/join?code=${encodeURIComponent(code)}`;

  {
    const { text, html } = calendarInviteEmailBody({
      inviterName,
      childName,
      role: (invite.role as CalendarRole) ?? "relative",
      code,
      shareUrl,
    });
    await sendEmail(invite.invitedEmail, "Du är inbjuden till Varannan", text, html);
  }
  await sendPushToUser(db, invite.invitedBy, {
    title: "Inbjudan skickad",
    body: `${invite.invitedEmail} har fått sin inbjudningskod till ${childName}.`,
  });

  return { status: "sent" as const };
});

/**
 * Ansluter till en enskild kalender. role "parent": OFÖRÄNDRAT — den
 * som redan är med i teamet läggs bara till på kalendern, den som är
 * helt ny läggs till i båda. role "relative"/"viewer": läggs bara till
 * i child.members/memberUids — rör INTE parentIds, teams.parentIds
 * eller users.teamId (deras "hemma-team" kan vara ett helt annat, se
 * docs/roller-och-medlemskap.md "En anhörig ska kunna höra till flera
 * kalendrar i olika familjer").
 */
export const acceptCalendarInvite = onCall(async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Du måste vara inloggad.");

  const rawCode = (request.data as { code?: string })?.code;
  if (!rawCode) throw new HttpsError("invalid-argument", "code krävs.");
  const code = rawCode.trim().toUpperCase();

  const inviteRef = db.doc(`teamInvites/${code}`);
  const inviteSnap = await inviteRef.get();
  const invite = inviteSnap.data();
  if (!inviteSnap.exists || !invite?.childId) {
    throw new HttpsError("not-found", "Koden gäller ingen kalender.");
  }
  if (invite.used) throw new HttpsError("failed-precondition", "Koden är redan använd.");
  if (invite.status && invite.status !== "sent") {
    throw new HttpsError("failed-precondition", "Koden väntar fortfarande på godkännande.");
  }
  if ((invite.expiresAt as admin.firestore.Timestamp).toDate().getTime() < Date.now()) {
    throw new HttpsError("failed-precondition", "Koden har gått ut.");
  }

  const { teamId, childId } = invite as { teamId: string; childId: string };
  const role: CalendarRole = (invite.role as CalendarRole) ?? "parent";
  const teamRef = db.doc(`teams/${teamId}`);
  const childRef = db.doc(`teams/${teamId}/children/${childId}`);
  const [teamSnap, childSnap] = await Promise.all([teamRef.get(), childRef.get()]);
  if (!teamSnap.exists || !childSnap.exists) {
    throw new HttpsError("not-found", "Kalendern finns inte längre.");
  }
  const childData = childSnap.data() as any;
  const childName = childData?.name ?? "kalendern";

  const existingParents = calendarParentIds(childData, teamSnap.data() as any).filter(
    (id) => id !== PENDING_PARTNER_ID,
  );
  const profile = profileFromAuth(request.auth!);

  if (role !== "parent") {
    // Fallback som calendarRoleFor(): saknas memberUids helt (kalendern
    // är inte migrerad än) räknas bara föräldrarna som medlemmar.
    const existingMemberUids: string[] = childData?.memberUids ?? existingParents;
    if (existingMemberUids.includes(uid)) {
      await inviteRef.update({ used: true, usedAt: admin.firestore.FieldValue.serverTimestamp() });
      return { teamId, childId };
    }

    const now = admin.firestore.FieldValue.serverTimestamp();
    const batch = db.batch();
    batch.update(inviteRef, { used: true, usedAt: admin.firestore.FieldValue.serverTimestamp() });
    batch.update(childRef, {
      // displayName cachas här (till skillnad från en förälders, som
      // bara ligger i teams/{teamId}.parentProfiles): en anhörig/
      // utomstående saknar users.teamId, så det finns ingen annan plats
      // föräldrarna redan har läsrätt till för att visa VEM som fick en
      // godkänd "hos {namn}"-dag (se PendingShiftRequests/CalendarView).
      // Hålls i synk av syncDisplayNameToTeam om namnet ändras senare.
      [`members.${uid}`]: { role, addedAt: now, invitedBy: invite.invitedBy, displayName: profile.displayName },
      memberUids: admin.firestore.FieldValue.arrayUnion(uid),
    });
    await batch.commit();

    await sendPushToUsers(db, existingParents, {
      title: "Någon anslöt till kalendern",
      body: `${profile.displayName} har anslutit som ${roleLabel(role)} till ${childName}.`,
    });

    return { teamId, childId };
  }

  // role === "parent" — oförändrad logik från innan etapp 2.
  const members = existingParents;
  if (members.includes(uid)) {
    await inviteRef.update({ used: true, usedAt: admin.firestore.FieldValue.serverTimestamp() });
    return { teamId, childId };
  }
  if (members.length >= 2) {
    throw new HttpsError("failed-precondition", "Kalendern delas redan av två föräldrar.");
  }

  const teamParentIds: string[] = teamSnap.data()?.parentIds ?? [];

  const now = admin.firestore.FieldValue.serverTimestamp();
  const newParentIds = [...members, uid];
  const batch = db.batch();
  batch.update(inviteRef, { used: true, usedAt: admin.firestore.FieldValue.serverTimestamp() });
  batch.update(childRef, {
    parentIds: newParentIds,
    // Skriv members/memberUids samtidigt, för BÅDA föräldrarna — den
    // som redan fanns kan sakna fältet om kalendern skapades innan
    // roller fanns (migreringen har då inte nått den ännu).
    ...Object.fromEntries(
      newParentIds.map((parentUid) => [
        `members.${parentUid}`,
        { role: "parent", addedAt: now, invitedBy: parentUid === uid ? uid : invite.invitedBy ?? uid },
      ]),
    ),
    memberUids: newParentIds,
  });

  if (!teamParentIds.includes(uid)) {
    batch.update(teamRef, {
      parentIds: admin.firestore.FieldValue.arrayUnion(uid),
      [`parentProfiles.${uid}`]: profile,
    });
  }

  // Platshållaren i grundschemat blir den nya föräldern, så schemat
  // aktiveras direkt i stället för att behöva byggas om.
  const cycleRef = childRef.collection("custodyCycle").doc("main");
  const cycleSnap = await cycleRef.get();
  if (cycleSnap.exists) {
    const cycle = cycleSnap.data() as CustodyCycleDoc;
    const blocks = (cycle.blocks ?? []).map((b) =>
      b.parentId === PENDING_PARTNER_ID ? { ...b, parentId: uid } : b,
    );
    batch.update(cycleRef, { blocks });
  }

  await batch.commit();
  await db.doc(`users/${uid}`).set({ teamId }, { merge: true });

  await sendPushToUsers(db, members, {
    title: "Någon anslöt till kalendern",
    body: `${profile.displayName} delar nu ${childName} med dig.`,
  });

  return { teamId, childId };
});


// ---------------------------------------------------------------------------
// 1h. Mina kalendrar — för en anhörig/utomstående UTAN eget "hem-team".
//
//     acceptCalendarInvite sätter ALDRIG users/{uid}.teamId för role
//     "relative"/"viewer" (se ovan — en anhörig kan höra till flera
//     familjers kalendrar, inte bara en). Men resten av klienten
//     (AuthGate, app/page.tsx) är byggd kring precis DEN enda
//     teamId:n. Den här callablen svarar på "vilka kalendrar är jag
//     med på?" via en collectionGroup-fråga med Admin SDK (kringgår
//     rules ändå) — enklare och säkrare än att försöka bevisa att en
//     motsvarande fråga direkt från klienten är säker enligt
//     firestore.rules, och löser samtidigt att en anhörig annars inte
//     får läsa teams/{teamId} alls (bara isTeamMember får det) genom
//     att plocka ut och returnera bara det ofarliga (föräldrarnas
//     namn) härifrån.
// ---------------------------------------------------------------------------
export const getMyCalendars = onCall(async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Du måste vara inloggad.");

  const snap = await db.collectionGroup("children").where("memberUids", "array-contains", uid).get();
  if (snap.empty) return { calendars: [] as never[] };

  const teamIds = Array.from(new Set(snap.docs.map((d) => d.data().teamId as string)));
  const teamSnaps = await Promise.all(teamIds.map((id) => db.doc(`teams/${id}`).get()));
  const teamsById = new Map(teamSnaps.map((s) => [s.id, s.data()]));

  const calendars = snap.docs.map((d) => {
    const child = d.data() as any;
    const team = teamsById.get(child.teamId);
    const role: CalendarRole = child.members?.[uid]?.role ?? "parent";
    const parentIds = calendarParentIds(child, team as any).filter((id) => id !== PENDING_PARTNER_ID);
    const parentNames: Record<string, string> = {};
    for (const pid of parentIds) {
      parentNames[pid] = team?.parentProfiles?.[pid]?.displayName ?? "Förälder";
    }
    // Alla roller, inte bara föräldrar — styr om "lämna kalendern" i
    // klienten betyder lämna (någon annan kvar) eller radera helt
    // (sista medlemmen, se deleteChild).
    const memberCount: number = (
      (child.memberUids as string[] | undefined) ?? parentIds
    ).filter((id) => id !== PENDING_PARTNER_ID).length;
    return {
      teamId: child.teamId as string,
      childId: d.id,
      childName: (child.name as string) ?? "Kalender",
      role,
      parentNames,
      memberCount,
    };
  });

  return { calendars };
});


// ---------------------------------------------------------------------------
// sendTestPush — skickar en testnotis till ens EGNA enheter.
//
// Finns för att "notiser är på" är svårt att lita på: behörighet,
// service worker, VAPID-nyckel och en giltig token måste alla stämma,
// och misslyckas något av dem märks det först när en riktig notis
// uteblir. Den här stänger den loopen — och rapporterar VAD som gick
// fel i stället för att bara tystna.
// ---------------------------------------------------------------------------

export const sendTestPush = onCall(
  { secrets: [GMAIL_USER, GMAIL_APP_PASSWORD] },
  async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Du måste vara inloggad.");

  const userSnap = await db.doc(`users/${uid}`).get();
  const user = userSnap.data() as UserDoc | undefined;
  const tokens: string[] = user?.fcmTokens ?? [];
  const prefs = user?.handoffReminderPrefs ?? DEFAULT_HANDOFF_REMINDER_PREFS;

  /**
   * Mailkanalen testas SEPARAT från push och innan push-felen kastas.
   * Poängen med hela knappen är att stänga loopen om vad som faktiskt
   * fungerar — om push är trasigt är det just då man som mest behöver
   * veta att mailet kom fram, så ett push-fel får inte dölja svaret.
   * Mail skickas bara när användaren slagit på kanalen; annars vore
   * testet ett mail till någon som valt bort mail.
   */
  let emailStatus: "sent" | "off" | "no-address" | string = "off";
  if (prefs.email) {
    if (!user?.email) {
      emailStatus = "no-address";
    } else {
      try {
        await sendEmailOrThrow(
          user.email,
          "Testnotis",
          "Mailpåminnelser fungerar. Så här ser de ut."
        );
        emailStatus = "sent";
      } catch (err: any) {
        emailStatus = `fel: ${err?.message ?? "okänt fel"}`;
      }
    }
  }

  if (tokens.length === 0) {
    throw new HttpsError(
      "failed-precondition",
      emailStatus === "sent"
        ? "Mailet skickades, men den här enheten är inte registrerad för push än. Tryck på Försök igen först."
        : "Den här enheten är inte registrerad för notiser än. Tryck på Försök igen först."
    );
  }

  const response = await admin.messaging().sendEachForMulticast({
    tokens,
    notification: {
      title: "Testnotis",
      body: "Notiser fungerar. Så här ser de ut.",
    },
    data: { kind: "test" },
  });

  // Rensa tokens som FCM sagt är döda, så nästa test inte rapporterar
  // samma fel igen. Utan det växer listan med gamla enheter och testet
  // ser ut att misslyckas fast en av enheterna faktiskt fick notisen.
  const dead: string[] = [];
  response.responses.forEach((result, i) => {
    const code = result.error?.code;
    if (
      code === "messaging/registration-token-not-registered" ||
      code === "messaging/invalid-argument"
    ) {
      dead.push(tokens[i]);
    }
  });
  if (dead.length > 0) {
    await db.doc(`users/${uid}`).update({
      fcmTokens: admin.firestore.FieldValue.arrayRemove(...dead),
    });
  }

  if (response.successCount === 0) {
    const firstError = response.responses.find((r) => r.error)?.error;
    const pushProblem =
      dead.length > 0
        ? "Enhetens notistoken hade gått ut. Den är borttagen nu — tryck på Försök igen och testa på nytt."
        : `Notisen kunde inte skickas: ${firstError?.message ?? "okänt fel"}`;
    throw new HttpsError(
      "internal",
      emailStatus === "sent" ? `${pushProblem} (Mailet kom däremot fram.)` : pushProblem
    );
  }

  return { ok: true, sent: response.successCount, removed: dead.length, email: emailStatus };
});

// ---------------------------------------------------------------------------
// 1d. setScheduleChangeMode — växla mellan "förfrågan" och "notifiering"
//     för hela teamet. Ligger på teamet och inte per användare: båda
//     måste följa samma regel, annars kunde den ena ändra fritt medan
//     den andra tvingades be om lov.
// ---------------------------------------------------------------------------

export const setScheduleChangeMode = onCall(async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Du måste vara inloggad.");

  const { teamId, mode } = request.data as {
    teamId?: string;
    mode?: ScheduleChangeMode;
  };
  if (!teamId || !mode) {
    throw new HttpsError("invalid-argument", "teamId och mode krävs.");
  }
  if (mode !== "request" && mode !== "notify") {
    throw new HttpsError("invalid-argument", "mode måste vara 'request' eller 'notify'.");
  }

  const teamRef = db.doc(`teams/${teamId}`);
  const teamSnap = await teamRef.get();
  if (!teamSnap.exists) throw new HttpsError("not-found", "Teamet finns inte.");

  const parentIds: string[] = teamSnap.data()?.parentIds ?? [];
  if (!parentIds.includes(uid)) {
    throw new HttpsError("permission-denied", "Du tillhör inte teamet.");
  }

  // Läget är individuellt: det styr hur ANDRA får ändra den här
  // förälderns dagar, så var och en sätter bara sitt eget.
  await teamRef.update({ [`parentProfiles.${uid}.scheduleChangeMode`]: mode });

  // Den andra föräldern behöver veta, eftersom det ändrar vad HEN kan
  // göra: om jag slår på notifiering kan hen plötsligt ändra mina dagar
  // utan att fråga, och tvärtom.
  const changerName = teamSnap.data()?.parentProfiles?.[uid]?.displayName ?? "Andra föräldern";
  const others = parentIds.filter((id) => id !== uid && id !== PENDING_PARTNER_ID);
  if (others.length > 0) {
    await sendPushToUsers(db, others, {
      title: "Läget för schemaändringar ändrades",
      body:
        mode === "notify"
          ? `${changerName} vill inte längre godkänna ändringar. Du kan ändra ${changerName}s dagar direkt.`
          : `${changerName} vill godkänna ändringar av sina dagar först.`,
    });
  }

  return { ok: true, mode };
});

// ---------------------------------------------------------------------------
// 1e. applyScheduleChangeDirect — schemaändring UTAN godkännandesteg.
//
//     Används bara när teamets scheduleChangeMode är "notify". Skapar
//     shiftRequests som redan är approved, justerar ställningen i samma
//     transaktion och notifierar den andra föräldern i efterhand.
//
//     Att detta är en callable och inte en klientskrivning är själva
//     poängen: läget kontrolleras på servern. Annars hade en klient
//     kunnat skriva approved-dokument direkt och hoppa över
//     godkännandet även när teamet står på "request".
// ---------------------------------------------------------------------------

export const applyScheduleChangeDirect = onCall(async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Du måste vara inloggad.");

  const { teamId, childId, changes, note } = request.data as {
    teamId?: string;
    childId?: string;
    /** Varje post är en sammanhängande period, redan grupperad av klienten. */
    changes?: { startAt: string; endAt?: string | null; takingOverParentId: string }[];
    note?: string;
  };

  if (!teamId || !childId || !changes || changes.length === 0) {
    throw new HttpsError("invalid-argument", "teamId, childId och minst en ändring krävs.");
  }

  const teamRef = db.doc(`teams/${teamId}`);
  const cycleRef = db.doc(`teams/${teamId}/children/${childId}/custodyCycle/main`);
  const balanceRef = db.doc(`teams/${teamId}/children/${childId}/dayBalance/main`);

  const teamSnap = await teamRef.get();
  if (!teamSnap.exists) throw new HttpsError("not-found", "Team saknas.");

  const parentIds: string[] = teamSnap.data()?.parentIds ?? [];
  if (!parentIds.includes(uid)) {
    throw new HttpsError("permission-denied", "Du är inte medlem i det här teamet.");
  }

  // Läget som gäller är MOTPARTENS: det är hen som annars hade fått
  // godkänna, och hen som bestämt om det steget behövs. Att läsa sitt
  // eget läge här hade låtit vem som helst ändra fritt genom att slå
  // om sin egen inställning.
  const otherParentId = parentIds.find((id) => id !== uid && id !== PENDING_PARTNER_ID);
  const mode = scheduleChangeModeFor(teamSnap.data() as any, otherParentId);
  if (mode !== "notify") {
    throw new HttpsError(
      "failed-precondition",
      "Den andra föräldern vill godkänna ändringar först. Skicka en förfrågan istället."
    );
  }

  // Parsa och validera tiderna innan transaktionen.
  const parsed = changes.map((c) => {
    const startMs = Date.parse(c.startAt);
    const endMs = c.endAt ? Date.parse(c.endAt) : null;
    if (Number.isNaN(startMs) || (endMs !== null && Number.isNaN(endMs))) {
      throw new HttpsError("invalid-argument", "Ogiltigt datumformat.");
    }
    if (!parentIds.includes(c.takingOverParentId)) {
      throw new HttpsError("invalid-argument", "takingOverParentId tillhör inte teamet.");
    }
    return { startMs, endMs, takingOverParentId: c.takingOverParentId };
  });

  // En direktändring ovanpå en redan godkänd avvikelse skulle göra schemat
  // tvetydigt. Men om den nya perioden HELT täcker den gamla ersätter den
  // gamla i stället för att vägra — annars fastnar man på dagar man själv
  // ändrat, utan väg tillbaka. Bara en gammal avvikelse som sticker ut
  // utanför den nya perioden är kvar som hård krock.
  const supersededById = new Map<string, admin.firestore.QueryDocumentSnapshot>();
  for (const p of parsed) {
    const clash = await findOverlappingApproved(teamId, childId, p.startMs, p.endMs, []);
    const { contained, partial } = splitContainedOverlap(clash, p.startMs, p.endMs);
    if (partial.length > 0) {
      throw new HttpsError(
        "failed-precondition",
        "Perioden överlappar bara delvis en redan godkänd ändring och går inte att ersätta automatiskt. Ta bort den först."
      );
    }
    for (const d of contained) supersededById.set(d.id, d);
  }
  const superseded = [...supersededById.values()];

  // Flera perioder som skickas ihop hör ihop i UI:t, precis som en batch
  // av förslag gör.
  const batchId = parsed.length > 1 ? db.collection(`teams/${teamId}/shiftRequests`).doc().id : null;

  await db.runTransaction(async (tx) => {
    const [cycleSnap, balanceSnap] = await Promise.all([tx.get(cycleRef), tx.get(balanceRef)]);
    if (!cycleSnap.exists) throw new HttpsError("not-found", "Ingen boendecykel konfigurerad för barnet.");
    if (!balanceSnap.exists) throw new HttpsError("not-found", "Ingen ställning initierad för barnet.");

    const cycle = cycleSnap.data() as CustodyCycleDoc;
    let runningBalance = balanceSnap.data() as DayBalanceDoc;

    // Ersätt gamla godkända avvikelser som helt täcks av den nya ändringen:
    // avbryt dem och backa deras balans-delta innan den nya appliceras.
    if (superseded.length > 0) {
      const reversed = cancelSupersededInTx(tx, teamId, childId, superseded, uid, runningBalance.balanceDays);
      runningBalance = { ...runningBalance, balanceDays: runningBalance.balanceDays - reversed };
    }

    for (const p of parsed) {
      const ref = db.collection(`teams/${teamId}/shiftRequests`).doc();
      const approvedRequest: ShiftRequestDoc = {
        id: ref.id,
        teamId,
        childId,
        requestedBy: uid,
        takingOverParentId: p.takingOverParentId,
        startAt: admin.firestore.Timestamp.fromMillis(p.startMs) as any,
        status: "approved",
        // Den som gör ändringen är också den som "svarat" på den — det
        // finns ingen motpart att vänta på i det här läget.
        respondedBy: uid,
        createdAt: admin.firestore.Timestamp.now() as any,
        ...(p.endMs !== null
          ? { endAt: admin.firestore.Timestamp.fromMillis(p.endMs) as any }
          : {}),
        ...(note ? { note } : {}),
        ...(batchId ? { batchId } : {}),
      };

      const { updatedBalance, deltaDays } = applyApprovedShiftToBalance(
        runningBalance,
        cycle,
        approvedRequest
      );
      runningBalance = updatedBalance;

      tx.set(ref, {
        ...approvedRequest,
        respondedAt: admin.firestore.FieldValue.serverTimestamp(),
        balanceDeltaDays: deltaDays,
      });

      const historyRef = db.collection(`teams/${teamId}/children/${childId}/dayBalanceHistory`).doc();
      tx.set(historyRef, {
        id: historyRef.id,
        childId,
        shiftRequestId: ref.id,
        deltaDays,
        balanceAfter: runningBalance.balanceDays,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    }

    tx.set(balanceRef, {
      ...runningBalance,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  });

  // Notisen ÄR hela poängen med det här läget — den ersätter
  // godkännandesteget, så den andra föräldern måste få veta.
  const changerName = teamSnap.data()?.parentProfiles?.[uid]?.displayName ?? "Andra föräldern";
  const others = parentIds.filter((id) => id !== uid && id !== PENDING_PARTNER_ID);
  if (others.length > 0) {
    const dayLabel = `${parsed.length} dag${parsed.length === 1 ? "" : "ar"}`;
    await sendPushToUsers(db, others, {
      title: "Schemat ändrades",
      body:
        parsed.length > 1
          ? `${changerName} ändrade ${dayLabel} i schemat.`
          : `${changerName} ändrade en dag i schemat.`,
    });
  }

  return { ok: true, applied: parsed.length };
});

// ---------------------------------------------------------------------------
// 1c. notifyOnShiftRequestCreated — pushar till MOTPARTEN när ett nytt
//     ansvarsbyte föreslås (en enskild dag eller en hel batch från
//     kalenderns ändringsläge).
//
//     Batchar (flera shiftRequests med samma batchId, skrivna nästan
//     samtidigt av klienten) ska bara ge EN push, inte en per dag. Det
//     löses med en "claim"-transaktion: bara den trigger-körning som
//     lyckas SKAPA teams/{teamId}/shiftRequestBatchNotified/{batchId}
//     (create-semantik — kastar om dokumentet redan finns) skickar
//     pushen, resten ser att den redan är tagen och hoppar över.
// ---------------------------------------------------------------------------

export const notifyOnShiftRequestCreated = onDocumentCreated(
  { document: "teams/{teamId}/shiftRequests/{requestId}", region: LEGACY_REGION },
  async (event) => {
    const request = event.data?.data() as ShiftRequestDoc | undefined;
    if (!request) return;

    // Direktändringar (scheduleChangeMode "notify") skapas redan som
    // approved och skickar sin EGEN notis från applyScheduleChangeDirect.
    // Utan den här vakten får den andra föräldern två pushar, varav en
    // felaktigt påstår att något väntar på godkännande.
    if (request.status !== "pending") return;

    if (request.batchId) {
      const claimRef = db.doc(`teams/${event.params.teamId}/shiftRequestBatchNotified/${request.batchId}`);
      try {
        await db.runTransaction(async (tx) => {
          const claimSnap = await tx.get(claimRef);
          if (claimSnap.exists) throw new Error("already-claimed");
          tx.create(claimRef, { createdAt: admin.firestore.FieldValue.serverTimestamp() });
        });
      } catch {
        return; // en annan trigger-körning i samma batch tog redan pushen
      }
    }

    const teamSnap = await db.doc(`teams/${event.params.teamId}`).get();
    const parentIds: string[] = teamSnap.data()?.parentIds ?? [];
    const otherParentIds = parentIds.filter((id) => id !== request.requestedBy);
    if (otherParentIds.length === 0) return;

    const requesterName =
      teamSnap.data()?.parentProfiles?.[request.requestedBy]?.displayName ?? "Andra föräldern";

    // Hur många dagar hela batchen omfattar (inte bara det här enskilda
    // dokumentet, som kan vara ett flerdagars-block i sig).
    let dayCount = 1;
    if (request.batchId) {
      const batchSnap = await db
        .collection(`teams/${event.params.teamId}/shiftRequests`)
        .where("batchId", "==", request.batchId)
        .get();
      dayCount = batchSnap.size;
    }

    await sendPushToUsers(db, otherParentIds, {
      title: "Nytt förslag på ansvarsbyte",
      body:
        dayCount > 1
          ? `${requesterName} föreslår ändring av ${dayCount} dagar.`
          : `${requesterName} föreslår ett ansvarsbyte.`,
    });
  }
);
