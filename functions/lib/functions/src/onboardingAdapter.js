"use strict";
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
exports.createOnboardingAdapter = createOnboardingAdapter;
const admin = __importStar(require("firebase-admin"));
/**
 * Samma trick som applyApprovedShiftToBalance i functions/src/index.ts:
 * den "rena" logiken i lib/onboarding.ts vet ingenting om Firebase, den
 * bara pratar mot ett litet interface. Här kopplar vi in admin SDK bakom
 * det interfacet, så Cloud Functions och ev. framtida tester delar exakt
 * samma regler för t.ex. cykel-validering.
 */
function createOnboardingAdapter(db) {
    return {
        async createTeam(doc) {
            const ref = db.collection("teams").doc();
            await ref.set({ ...doc, id: ref.id, createdAt: admin.firestore.FieldValue.serverTimestamp() });
            return ref.id;
        },
        async updateUser(uid, patch) {
            await db.doc(`users/${uid}`).set(patch, { merge: true });
        },
        async createInvite(teamId, code, expiresAt) {
            await db.doc(`teamInvites/${code}`).set({
                teamId,
                code,
                used: false,
                expiresAt: admin.firestore.Timestamp.fromDate(expiresAt),
                createdAt: admin.firestore.FieldValue.serverTimestamp(),
            });
        },
        async peekInvite(code) {
            const snap = await db.doc(`teamInvites/${code}`).get();
            if (!snap.exists)
                return null;
            const data = snap.data();
            if (data.used)
                return null;
            if (data.expiresAt.toDate().getTime() < Date.now())
                return null;
            return { teamId: data.teamId };
        },
        async getTeam(teamId) {
            const snap = await db.doc(`teams/${teamId}`).get();
            return snap.exists ? snap.data() : null;
        },
        async consumeInvite(code) {
            const ref = db.doc(`teamInvites/${code}`);
            return db.runTransaction(async (tx) => {
                const snap = await tx.get(ref);
                if (!snap.exists)
                    return null;
                const data = snap.data();
                if (data.used)
                    return null;
                if (data.expiresAt.toDate().getTime() < Date.now())
                    return null;
                tx.update(ref, { used: true, usedAt: admin.firestore.FieldValue.serverTimestamp() });
                return { teamId: data.teamId };
            });
        },
        async addParentToTeam(teamId, uid, profile) {
            // Transaktion, inte arrayUnion: två personer som löser in koder
            // samtidigt skulle annars båda kunna slinka in och ge tre föräldrar.
            const ref = db.doc(`teams/${teamId}`);
            await db.runTransaction(async (tx) => {
                const snap = await tx.get(ref);
                if (!snap.exists)
                    throw new Error("Team saknas");
                const parentIds = snap.data().parentIds ?? [];
                if (parentIds.includes(uid))
                    return;
                if (parentIds.length >= 2)
                    throw new Error("team_full");
                tx.update(ref, {
                    parentIds: [...parentIds, uid],
                    [`parentProfiles.${uid}`]: profile,
                });
            });
        },
        async createChild(doc) {
            const teamRef = db.doc(`teams/${doc.teamId}`);
            const childRef = teamRef.collection("children").doc();
            await db.runTransaction(async (tx) => {
                tx.set(childRef, { ...doc, id: childRef.id });
                tx.update(teamRef, { childIds: admin.firestore.FieldValue.arrayUnion(childRef.id) });
            });
            return childRef.id;
        },
        async writeCustodyCycle(teamId, childId, doc) {
            await db.doc(`teams/${teamId}/children/${childId}/custodyCycle/main`).set(doc);
        },
        async initDayBalance(teamId, childId, doc) {
            await db.doc(`teams/${teamId}/children/${childId}/dayBalance/main`).set(doc);
        },
    };
}
