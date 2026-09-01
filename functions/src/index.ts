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
import { onDocumentWritten, onDocumentCreated } from "firebase-functions/v2/firestore";
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
  PENDING_PARTNER_ID,
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
  await cycleRef.update({ switchHour });

  return { ok: true };
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
 * för samma dag gör schemat tvetydigt — kalendern kan bara visa en av dem,
 * och vilken blev tidigare godtyckligt. Därför avvisas ett godkännande som
 * krockar med en redan godkänd avvikelse.
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

  let notifyRequestedBy: string | null = null;
  let responderName = "Andra föräldern";

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

    notifyRequestedBy = shiftRequest.requestedBy;
    responderName = teamSnap.data()?.parentProfiles?.[uid]?.displayName ?? responderName;

    if (decision === "approved" && overlapping.length > 0) {
      throw new HttpsError(
        "failed-precondition",
        "Perioden krockar med en ändring som redan är godkänd. Avböj den ena först."
      );
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

  if (notifyRequestedBy) {
    await sendPushToUser(db, notifyRequestedBy, {
      title: decision === "approved" ? "Bytet godkändes" : "Bytet avböjdes",
      body:
        decision === "approved"
          ? `${responderName} godkände ändringen av schemat.`
          : `${responderName} avböjde ändringen av schemat.`,
    });
  }

  return { ok: true };
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
  const cycleRef = db.doc(`teams/${teamId}/children/${childId}/custodyCycle/main`);
  const balanceRef = db.doc(`teams/${teamId}/children/${childId}/dayBalance/main`);

  let notifyRequestedBy: string | null = null;
  let responderName = "Andra föräldern";
  let dayCount = 0;

  // Överlappskoll före transaktionen, av samma skäl som i
  // approveShiftRequest: en batch som krockar med redan godkända dagar
  // skulle göra schemat tvetydigt.
  if (decision === "approved") {
    const preBatch = await db
      .collection(`teams/${teamId}/shiftRequests`)
      .where("batchId", "==", batchId)
      .get();
    const batchIds = preBatch.docs.map((d) => d.id);
    for (const d of preBatch.docs) {
      const data = d.data() as ShiftRequestDoc;
      const clash = await findOverlappingApproved(
        teamId,
        childId,
        data.startAt.seconds * 1000,
        data.endAt ? data.endAt.seconds * 1000 : null,
        batchIds
      );
      if (clash.length > 0) {
        throw new HttpsError(
          "failed-precondition",
          "En eller flera dagar krockar med en ändring som redan är godkänd. Avböj den ena först."
        );
      }
    }
  }

  await db.runTransaction(async (tx) => {
    const teamSnap = await tx.get(teamRef);
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

    for (const req of requests) {
      if (req.status !== "pending") {
        throw new HttpsError("failed-precondition", "Förfrågan är redan hanterad.");
      }
      // Bara MOTPARTEN (inte den som föreslog) får godkänna/avböja.
      if (req.requestedBy === uid) {
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

    const [cycleSnap, balanceSnap] = await Promise.all([tx.get(cycleRef), tx.get(balanceRef)]);
    if (!cycleSnap.exists) throw new HttpsError("not-found", "Ingen boendecykel konfigurerad för barnet.");
    if (!balanceSnap.exists) throw new HttpsError("not-found", "Ingen ställning initierad för barnet.");

    const cycle = cycleSnap.data() as CustodyCycleDoc;
    let runningBalance = balanceSnap.data() as DayBalanceDoc;
    let totalDelta = 0;

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
      title: decision === "approved" ? "Ändringen godkändes" : "Ändringen avböjdes",
      body:
        decision === "approved"
          ? `${responderName} godkände förslaget om ${dayLabel}.`
          : `${responderName} avböjde förslaget om ${dayLabel}.`,
    });
  }

  return { ok: true };
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
  "teams/{teamId}/shiftRequests/{requestId}",
  async (event) => {
    const request = event.data?.data() as ShiftRequestDoc | undefined;
    if (!request) return;

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
