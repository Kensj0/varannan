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
import * as crypto from "crypto";
import { setGlobalOptions } from "firebase-functions/v2";
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { onDocumentWritten, onDocumentCreated } from "firebase-functions/v2/firestore";
// OBS: `googleapis` importeras lat, inne i getCalendarClientForUser. Den
// väger ~4 MB och drog tidigare med sig laddningstid till kallstarten för
// VARJE funktion i filen, trots att bara exportEventToGoogleCalendar
// använder den.

// Default-region: europe-north1, samma som Firestore. Nästan alla
// användare är i Sverige, och de callables de faktiskt väntar på
// (godkänn byte, spara schema, bjud in) gör flera Firestore-läsningar
// i följd — med funktionen samlokaliserad med databasen försvinner
// både Atlanten-hoppet till klienten OCH hoppen mellan funktion och db.
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
  TeamParentProfile,
  ScheduleChangeMode,
  scheduleChangeModeFor,
  calendarParentIds,
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
  const currentHour = (await cycleRef.get()).data()?.switchHour ?? "08:00";

  const counterpart = await counterpartFor(teamId, childId, uid);
  if (await structureChangeAppliesDirectly(teamId, counterpart)) {
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
export const syncDisplayNameToTeam = onDocumentWritten(
  { document: "users/{uid}", region: LEGACY_REGION },
  async (event) => {
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
 * Ska ändringen gälla direkt? Ja om man är ensam i kalendern, eller om
 * motparten valt notifiering. Nej om motparten vill godkänna först.
 */
async function structureChangeAppliesDirectly(
  teamId: string,
  counterpart: string | null,
): Promise<boolean> {
  if (!counterpart) return true;
  const teamSnap = await db.doc(`teams/${teamId}`).get();
  return scheduleChangeModeFor(teamSnap.data() as any, counterpart) === "notify";
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
  if (isFirstSetup || (await structureChangeAppliesDirectly(raw.teamId, counterpart))) {
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
  const batch = db.batch();
  batch.set(childRef, {
    id: childRef.id,
    teamId,
    name: trimmed,
    // Nya kalendrar delas med teamets nuvarande föräldrar. Delningen
    // ligger på barnet så att den kan ändras per kalender senare.
    parentIds: parentIds.filter((id: string) => id !== PENDING_PARTNER_ID),
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
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
 * Lämnar eller raderar en kalender.
 *
 * Kalendern ÄR barnet, och delas av de föräldrar som står i
 * child.parentIds. Därför finns två utfall:
 *
 *  - Är du INTE ensam kvar: du lämnar bara. Kalendern med allt innehåll
 *    finns kvar hos den andra föräldern, som kan bjuda in någon ny i
 *    ditt ställe. Ditt uid byts mot PENDING_PARTNER_ID i grundschemat,
 *    precis som när man bygger ett schema innan partnern anslutit — då
 *    glider nästa person in på samma plats utan att schemat byggs om.
 *
 *  - Är du sista medlemmen: allt raderas. Firestore kaskadraderar inte,
 *    så subkollektionerna städas uttryckligen — annars blir schema,
 *    ställning, barninfo och konton kvar som föräldralösa dokument.
 *
 * Ställningen behålls när någon lämnar (uttryckligt val): saldot är en
 * fortsättning på kalenderns historik, inte på relationen till en viss
 * person.
 */
export const deleteChild = onCall(async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Du måste vara inloggad.");

  const { teamId, childId } = request.data as { teamId?: string; childId?: string };
  if (!teamId || !childId) {
    throw new HttpsError("invalid-argument", "teamId och childId krävs.");
  }

  const teamRef = db.doc(`teams/${teamId}`);
  const teamSnap = await teamRef.get();
  if (!teamSnap.exists) throw new HttpsError("not-found", "Teamet finns inte.");

  const childRef = db.doc(`teams/${teamId}/children/${childId}`);
  const childSnap = await childRef.get();
  if (!childSnap.exists) throw new HttpsError("not-found", "Kalendern finns inte.");

  const members = calendarParentIds(childSnap.data() as any, teamSnap.data() as any);
  if (!members.includes(uid)) {
    throw new HttpsError("permission-denied", "Du delar inte den här kalendern.");
  }

  const remainingMembers = members.filter((id) => id !== uid && id !== PENDING_PARTNER_ID);

  // ---- Fall 1: någon annan är kvar — lämna, radera inte. ----
  if (remainingMembers.length > 0) {
    const cycleRef = childRef.collection("custodyCycle").doc("main");
    const cycleSnap = await cycleRef.get();

    const batch = db.batch();
    batch.update(childRef, { parentIds: remainingMembers });

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

    await batch.commit();

    // Prenumerationstoken som var mina blir meningslösa.
    const tokens: Record<string, string> = teamSnap.data()?.calendarFeedTokens ?? {};
    const mine = Object.keys(tokens).filter((k) => k === `${childId}:${uid}`);
    if (mine.length > 0) {
      const patch: Record<string, any> = {};
      for (const key of mine) patch[`calendarFeedTokens.${key}`] = admin.firestore.FieldValue.delete();
      await teamRef.update(patch);
    }

    const leaverName = teamSnap.data()?.parentProfiles?.[uid]?.displayName ?? "Den andra föräldern";
    const childName = childSnap.data()?.name ?? "kalendern";
    await sendPushToUsers(db, remainingMembers, {
      title: `${leaverName} lämnade ${childName}`,
      body: "Kalendern finns kvar hos dig. Du kan bjuda in någon ny att dela den med.",
    });

    return { ok: true, left: true };
  }

  // ---- Fall 2: sista medlemmen — radera allt. ----
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
// 1g. Inbjudan till EN kalender.
//
//     Skiljer sig från createInvite (som bjuder in till hela familjen och
//     bara kan användas en gång, innan team-uppsättningen är klar). Den
//     här används när man redan har en kalender och vill dela just den —
//     t.ex. efter att den andra föräldern lämnat och man vill koppla på
//     någon ny på samma schema.
// ---------------------------------------------------------------------------

export const createCalendarInvite = onCall(async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Du måste vara inloggad.");

  const { teamId, childId, baseUrl } = request.data as {
    teamId?: string;
    childId?: string;
    baseUrl?: string;
  };
  if (!teamId || !childId) {
    throw new HttpsError("invalid-argument", "teamId och childId krävs.");
  }

  const [teamSnap, childSnap] = await Promise.all([
    db.doc(`teams/${teamId}`).get(),
    db.doc(`teams/${teamId}/children/${childId}`).get(),
  ]);
  if (!teamSnap.exists || !childSnap.exists) {
    throw new HttpsError("not-found", "Kalendern finns inte.");
  }

  const members = calendarParentIds(childSnap.data() as any, teamSnap.data() as any).filter(
    (id) => id !== PENDING_PARTNER_ID,
  );
  if (!members.includes(uid)) {
    throw new HttpsError("permission-denied", "Du delar inte den här kalendern.");
  }
  if (members.length >= 2) {
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
  const expiresAt = new Date(Date.now() + 48 * 60 * 60 * 1000);
  await db.doc(`teamInvites/${code}`).set({
    teamId,
    childId,
    code,
    used: false,
    invitedBy: uid,
    expiresAt: admin.firestore.Timestamp.fromDate(expiresAt),
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  return {
    code,
    expiresAt: expiresAt.toISOString(),
    shareUrl: `${safeBaseUrl.replace(/\/$/, "")}/join?code=${encodeURIComponent(code)}`,
  };
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
 * Ansluter till en enskild kalender. Den som redan är med i teamet
 * läggs bara till på kalendern; den som är helt ny läggs till i båda.
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
  if ((invite.expiresAt as admin.firestore.Timestamp).toDate().getTime() < Date.now()) {
    throw new HttpsError("failed-precondition", "Koden har gått ut.");
  }

  const { teamId, childId } = invite as { teamId: string; childId: string };
  const teamRef = db.doc(`teams/${teamId}`);
  const childRef = db.doc(`teams/${teamId}/children/${childId}`);
  const [teamSnap, childSnap] = await Promise.all([teamRef.get(), childRef.get()]);
  if (!teamSnap.exists || !childSnap.exists) {
    throw new HttpsError("not-found", "Kalendern finns inte längre.");
  }

  const members = calendarParentIds(childSnap.data() as any, teamSnap.data() as any).filter(
    (id) => id !== PENDING_PARTNER_ID,
  );
  if (members.includes(uid)) {
    await inviteRef.update({ used: true, usedAt: admin.firestore.FieldValue.serverTimestamp() });
    return { teamId, childId };
  }
  if (members.length >= 2) {
    throw new HttpsError("failed-precondition", "Kalendern delas redan av två föräldrar.");
  }

  const profile = profileFromAuth(request.auth!);
  const teamParentIds: string[] = teamSnap.data()?.parentIds ?? [];

  const batch = db.batch();
  batch.update(inviteRef, { used: true, usedAt: admin.firestore.FieldValue.serverTimestamp() });
  batch.update(childRef, { parentIds: [...members, uid] });

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
    body: `${profile.displayName} delar nu ${childSnap.data()?.name ?? "kalendern"} med dig.`,
  });

  return { teamId, childId };
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

export const sendTestPush = onCall(async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Du måste vara inloggad.");

  const userSnap = await db.doc(`users/${uid}`).get();
  const tokens: string[] = userSnap.data()?.fcmTokens ?? [];

  if (tokens.length === 0) {
    throw new HttpsError(
      "failed-precondition",
      "Den här enheten är inte registrerad för notiser än. Tryck på Försök igen först."
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
    throw new HttpsError(
      "internal",
      dead.length > 0
        ? "Enhetens notistoken hade gått ut. Den är borttagen nu — tryck på Försök igen och testa på nytt."
        : `Notisen kunde inte skickas: ${firstError?.message ?? "okänt fel"}`
    );
  }

  return { ok: true, sent: response.successCount, removed: dead.length };
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

  // Samma överlappskoll som vid godkännande — en direktändring ovanpå en
  // redan godkänd avvikelse skulle göra schemat tvetydigt.
  for (const p of parsed) {
    const clash = await findOverlappingApproved(teamId, childId, p.startMs, p.endMs, []);
    if (clash.length > 0) {
      throw new HttpsError(
        "failed-precondition",
        "Perioden krockar med en ändring som redan är godkänd. Ta bort den först."
      );
    }
  }

  // Flera perioder som skickas ihop hör ihop i UI:t, precis som en batch
  // av förslag gör.
  const batchId = parsed.length > 1 ? db.collection(`teams/${teamId}/shiftRequests`).doc().id : null;

  await db.runTransaction(async (tx) => {
    const [cycleSnap, balanceSnap] = await Promise.all([tx.get(cycleRef), tx.get(balanceRef)]);
    if (!cycleSnap.exists) throw new HttpsError("not-found", "Ingen boendecykel konfigurerad för barnet.");
    if (!balanceSnap.exists) throw new HttpsError("not-found", "Ingen ställning initierad för barnet.");

    const cycle = cycleSnap.data() as CustodyCycleDoc;
    let runningBalance = balanceSnap.data() as DayBalanceDoc;

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

// ---------------------------------------------------------------------------
// 2. exportEventToGoogleCalendar — envägs export till varje förälders
//    egen Google-kalender när ett EventDoc skapas eller ändras.
// ---------------------------------------------------------------------------

export const exportEventToGoogleCalendar = onDocumentWritten(
  { document: "teams/{teamId}/events/{eventId}", region: LEGACY_REGION },
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
  const { google } = await import("googleapis");

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
