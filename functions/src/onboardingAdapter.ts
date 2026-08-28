import * as admin from "firebase-admin";
import { OnboardingFirestore } from "../../lib/onboarding";
import { TeamDoc, TeamParentProfile, UserDoc, ChildDoc, CustodyCycleDoc, DayBalanceDoc } from "../../types/schema";

/**
 * Samma trick som applyApprovedShiftToBalance i functions/src/index.ts:
 * den "rena" logiken i lib/onboarding.ts vet ingenting om Firebase, den
 * bara pratar mot ett litet interface. Här kopplar vi in admin SDK bakom
 * det interfacet, så Cloud Functions och ev. framtida tester delar exakt
 * samma regler för t.ex. cykel-validering.
 */
export function createOnboardingAdapter(db: admin.firestore.Firestore): OnboardingFirestore {
  return {
    async createTeam(doc: Omit<TeamDoc, "id">) {
      const ref = db.collection("teams").doc();
      await ref.set({ ...doc, id: ref.id, createdAt: admin.firestore.FieldValue.serverTimestamp() });
      return ref.id;
    },

    async updateUser(uid: string, patch: Partial<UserDoc>) {
      await db.doc(`users/${uid}`).set(patch, { merge: true });
    },

    async createInvite(teamId: string, code: string, expiresAt: Date) {
      await db.doc(`teamInvites/${code}`).set({
        teamId,
        code,
        used: false,
        expiresAt: admin.firestore.Timestamp.fromDate(expiresAt),
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    },

    async peekInvite(code: string) {
      const snap = await db.doc(`teamInvites/${code}`).get();
      if (!snap.exists) return null;
      const data = snap.data()!;
      if (data.used) return null;
      if ((data.expiresAt as admin.firestore.Timestamp).toDate().getTime() < Date.now()) return null;
      return { teamId: data.teamId as string };
    },

    async getTeam(teamId: string) {
      const snap = await db.doc(`teams/${teamId}`).get();
      return snap.exists ? (snap.data() as TeamDoc) : null;
    },

    async consumeInvite(code: string) {
      const ref = db.doc(`teamInvites/${code}`);
      return db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        if (!snap.exists) return null;
        const data = snap.data()!;
        if (data.used) return null;
        if ((data.expiresAt as admin.firestore.Timestamp).toDate().getTime() < Date.now()) return null;
        tx.update(ref, { used: true, usedAt: admin.firestore.FieldValue.serverTimestamp() });
        return { teamId: data.teamId as string };
      });
    },

    async addParentToTeam(teamId: string, uid: string, profile: TeamParentProfile) {
      // Transaktion, inte arrayUnion: två personer som löser in koder
      // samtidigt skulle annars båda kunna slinka in och ge tre föräldrar.
      const ref = db.doc(`teams/${teamId}`);
      await db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        if (!snap.exists) throw new Error("Team saknas");
        const parentIds: string[] = snap.data()!.parentIds ?? [];
        if (parentIds.includes(uid)) return;
        if (parentIds.length >= 2) throw new Error("team_full");
        tx.update(ref, {
          parentIds: [...parentIds, uid],
          [`parentProfiles.${uid}`]: profile,
        });
      });
    },

    async createChild(doc: Omit<ChildDoc, "id">) {
      const teamRef = db.doc(`teams/${doc.teamId}`);
      const childRef = teamRef.collection("children").doc();
      await db.runTransaction(async (tx) => {
        tx.set(childRef, { ...doc, id: childRef.id });
        tx.update(teamRef, { childIds: admin.firestore.FieldValue.arrayUnion(childRef.id) });
      });
      return childRef.id;
    },

    async writeCustodyCycle(teamId: string, childId: string, doc: CustodyCycleDoc) {
      await db.doc(`teams/${teamId}/children/${childId}/custodyCycle/main`).set(doc);
    },

    async initDayBalance(teamId: string, childId: string, doc: DayBalanceDoc) {
      await db.doc(`teams/${teamId}/children/${childId}/dayBalance/main`).set(doc);
    },
  };
}
