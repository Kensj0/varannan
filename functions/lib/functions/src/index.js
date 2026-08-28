"use strict";
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
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.exportEventToGoogleCalendar = exports.approveShiftRequest = exports.saveCustodyCycle = exports.syncDisplayNameToTeam = exports.acceptInvite = exports.createInvite = exports.createFamilyTeam = void 0;
const admin = __importStar(require("firebase-admin"));
const https_1 = require("firebase-functions/v2/https");
const firestore_1 = require("firebase-functions/v2/firestore");
const googleapis_1 = require("googleapis");
const dayBalance_1 = require("../../lib/dayBalance");
const onboarding_1 = require("../../lib/onboarding");
const onboardingAdapter_1 = require("./onboardingAdapter");
admin.initializeApp();
const db = admin.firestore();
const onboardingDb = (0, onboardingAdapter_1.createOnboardingAdapter)(db);
// ---------------------------------------------------------------------------
// 0. Auth-bakade onboarding-funktioner
// ---------------------------------------------------------------------------
/** Bygger den cachade profilen från auth-token — aldrig från klient-data. */
function profileFromAuth(auth) {
    return {
        uid: auth.uid,
        displayName: auth.token.name || auth.token.email?.split("@")[0] || "Förälder",
        avatarUrl: auth.token.picture || undefined,
    };
}
/** Körs direkt efter att en ny användare loggat in första gången. */
exports.createFamilyTeam = (0, https_1.onCall)(async (request) => {
    const uid = request.auth?.uid;
    if (!uid)
        throw new https_1.HttpsError("unauthenticated", "Du måste vara inloggad.");
    const { teamName } = request.data;
    if (!teamName?.trim())
        throw new https_1.HttpsError("invalid-argument", "Familjenamn saknas.");
    const teamId = await (0, onboarding_1.createTeam)(onboardingDb, {
        creatorUid: uid,
        teamName: teamName.trim(),
        creatorProfile: profileFromAuth(request.auth),
    });
    return { teamId };
});
exports.createInvite = (0, https_1.onCall)(async (request) => {
    const uid = request.auth?.uid;
    if (!uid)
        throw new https_1.HttpsError("unauthenticated", "Du måste vara inloggad.");
    const { teamId, baseUrl } = request.data;
    const teamSnap = await db.doc(`teams/${teamId}`).get();
    if (!teamSnap.exists)
        throw new https_1.HttpsError("not-found", "Team saknas.");
    const parentIds = teamSnap.data()?.parentIds ?? [];
    if (!parentIds.includes(uid))
        throw new https_1.HttpsError("permission-denied", "Du är inte medlem i teamet.");
    if (parentIds.length >= 2) {
        throw new https_1.HttpsError("failed-precondition", "Familjen har redan två föräldrar.");
    }
    // baseUrl kommer från klienten (window.location.origin) men valideras
    // mot en allowlist — annars kunde en angripare få appen att generera
    // inbjudningslänkar som pekar på en phishing-domän.
    const allowed = (process.env.ALLOWED_APP_ORIGINS ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    const safeBaseUrl = baseUrl && allowed.includes(baseUrl) ? baseUrl : allowed[0] ?? "http://localhost:3000";
    return (0, onboarding_1.createParentInvite)(onboardingDb, teamId, safeBaseUrl);
});
exports.acceptInvite = (0, https_1.onCall)(async (request) => {
    const uid = request.auth?.uid;
    if (!uid)
        throw new https_1.HttpsError("unauthenticated", "Du måste vara inloggad.");
    const { code } = request.data;
    const result = await (0, onboarding_1.acceptParentInvite)(onboardingDb, {
        uid,
        code: code.trim().toUpperCase(),
        profile: profileFromAuth(request.auth),
    });
    if ("error" in result) {
        if (result.error === "team_full") {
            throw new https_1.HttpsError("failed-precondition", "Familjen har redan två föräldrar.");
        }
        throw new https_1.HttpsError("failed-precondition", "Koden är ogiltig eller har gått ut.");
    }
    return result;
});
/**
 * Håller den cachade kopian i teams/{teamId}.parentProfiles i synk när
 * en förälder byter namn eller profilbild i users/{uid}.
 */
exports.syncDisplayNameToTeam = (0, firestore_1.onDocumentWritten)("users/{uid}", async (event) => {
    const after = event.data?.after?.data();
    const before = event.data?.before?.data();
    if (!after?.teamId)
        return;
    const nameChanged = before?.displayName !== after.displayName;
    const avatarChanged = before?.avatarUrl !== after.avatarUrl;
    const teamChanged = before?.teamId !== after.teamId;
    if (!nameChanged && !avatarChanged && !teamChanged)
        return;
    await db.doc(`teams/${after.teamId}`).update({
        [`parentProfiles.${event.params.uid}`]: {
            uid: event.params.uid,
            displayName: after.displayName,
            avatarUrl: after.avatarUrl ?? null,
        },
    });
});
exports.saveCustodyCycle = (0, https_1.onCall)(async (request) => {
    const uid = request.auth?.uid;
    if (!uid)
        throw new https_1.HttpsError("unauthenticated", "Du måste vara inloggad.");
    const raw = request.data;
    const teamSnap = await db.doc(`teams/${raw.teamId}`).get();
    const parentIds = teamSnap.data()?.parentIds ?? [];
    if (!parentIds.includes(uid))
        throw new https_1.HttpsError("permission-denied", "Du är inte medlem i teamet.");
    // Blocken måste peka på teamets faktiska föräldrar — annars blir
    // schemat omöjligt att rendera (uid:t matchar ingen användare).
    const blockParents = new Set(raw.blocks.map((b) => b.parentId));
    for (const pid of blockParents) {
        if (!parentIds.includes(pid)) {
            throw new https_1.HttpsError("invalid-argument", `Okänd förälder i schemat: ${pid}`);
        }
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(raw.cycleStartDate)) {
        throw new https_1.HttpsError("invalid-argument", "cycleStartDate måste vara YYYY-MM-DD.");
    }
    await (0, onboarding_1.setupCustodyCycle)(onboardingDb, { ...raw, updatedBy: uid });
    return { ok: true };
});
// ---------------------------------------------------------------------------
// 1. approveShiftRequest — atomiskt godkännande + ställnings-uppdatering
// ---------------------------------------------------------------------------
exports.approveShiftRequest = (0, https_1.onCall)(async (request) => {
    const uid = request.auth?.uid;
    if (!uid)
        throw new https_1.HttpsError("unauthenticated", "Du måste vara inloggad.");
    const { teamId, childId, shiftRequestId, decision } = request.data;
    if (!["approved", "declined"].includes(decision)) {
        throw new https_1.HttpsError("invalid-argument", "decision måste vara 'approved' eller 'declined'.");
    }
    const teamRef = db.doc(`teams/${teamId}`);
    const requestRef = db.doc(`teams/${teamId}/shiftRequests/${shiftRequestId}`);
    const cycleRef = db.doc(`teams/${teamId}/children/${childId}/custodyCycle/main`);
    const balanceRef = db.doc(`teams/${teamId}/children/${childId}/dayBalance/main`);
    const historyRef = db.collection(`teams/${teamId}/children/${childId}/dayBalanceHistory`).doc();
    await db.runTransaction(async (tx) => {
        const [teamSnap, requestSnap] = await Promise.all([tx.get(teamRef), tx.get(requestRef)]);
        if (!teamSnap.exists)
            throw new https_1.HttpsError("not-found", "Team saknas.");
        const parentIds = teamSnap.data().parentIds;
        if (!parentIds.includes(uid)) {
            throw new https_1.HttpsError("permission-denied", "Du är inte medlem i det här teamet.");
        }
        if (!requestSnap.exists)
            throw new https_1.HttpsError("not-found", "Förfrågan saknas.");
        const shiftRequest = requestSnap.data();
        if (shiftRequest.status !== "pending") {
            throw new https_1.HttpsError("failed-precondition", "Förfrågan är redan hanterad.");
        }
        // Bara MOTPARTEN (inte den som föreslog) får godkänna/avböja.
        if (shiftRequest.requestedBy === uid) {
            throw new https_1.HttpsError("permission-denied", "Du kan inte godkänna din egen förfrågan.");
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
        if (!cycleSnap.exists)
            throw new https_1.HttpsError("not-found", "Ingen boendecykel konfigurerad för barnet.");
        if (!balanceSnap.exists)
            throw new https_1.HttpsError("not-found", "Ingen ställning initierad för barnet.");
        const cycle = cycleSnap.data();
        const currentBalance = balanceSnap.data();
        const approvedRequest = {
            ...shiftRequest,
            status: "approved",
            respondedBy: uid,
        };
        const { updatedBalance, deltaDays } = (0, dayBalance_1.applyApprovedShiftToBalance)(currentBalance, cycle, approvedRequest);
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
exports.exportEventToGoogleCalendar = (0, firestore_1.onDocumentWritten)("teams/{teamId}/events/{eventId}", async (event) => {
    const after = event.data?.after?.data();
    if (!after)
        return; // borttaget event — hantera ev. borttag av Google-eventet separat
    const teamSnap = await db.doc(`teams/${event.params.teamId}`).get();
    const parentIds = teamSnap.data()?.parentIds ?? [];
    const googleEventIds = { ...(after.googleEventIds ?? {}) };
    for (const parentUid of parentIds) {
        const userSnap = await db.doc(`users/${parentUid}`).get();
        const user = userSnap.data();
        if (!user?.googleCalendar?.connected || !user.googleCalendar.refreshTokenRef)
            continue;
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
        }
        else {
            const inserted = await calendar.events.insert({ calendarId, requestBody });
            if (inserted.data.id)
                googleEventIds[parentUid] = inserted.data.id;
        }
    }
    await event.data.after.ref.set({ googleEventIds }, { merge: true });
});
// ---------------------------------------------------------------------------
// Hjälpfunktioner
// ---------------------------------------------------------------------------
async function getCalendarClientForUser(refreshTokenRef) {
    // I produktion: hämta den faktiska refresh-token från Secret Manager
    // via refreshTokenRef (ALDRIG lagra token direkt i Firestore).
    const refreshToken = await resolveSecret(refreshTokenRef);
    const oauth2Client = new googleapis_1.google.auth.OAuth2(process.env.GOOGLE_OAUTH_CLIENT_ID, process.env.GOOGLE_OAUTH_CLIENT_SECRET);
    oauth2Client.setCredentials({ refresh_token: refreshToken });
    return googleapis_1.google.calendar({ version: "v3", auth: oauth2Client });
}
async function resolveSecret(secretRef) {
    // Platshållare — koppla mot @google-cloud/secret-manager i produktion.
    throw new Error(`resolveSecret ej implementerad ännu för ref: ${secretRef}`);
}
function tsToIso(ts) {
    return new Date(ts.seconds * 1000 + ts.nanoseconds / 1e6).toISOString();
}
