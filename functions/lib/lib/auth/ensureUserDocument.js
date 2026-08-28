"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ensureUserDocument = ensureUserDocument;
const firestore_1 = require("firebase/firestore");
const firebase_1 = require("./firebase");
/**
 * Körs direkt efter lyckad inloggning/registrering. Skapar users/{uid}
 * om det inte redan finns. teamId lämnas null tills AuthGate ser att
 * det saknas och skickar användaren till onboarding-flödet.
 *
 * Tillåtet av firestore.rules (allow create: if request.auth.uid == uid) —
 * ingen Cloud Function behövs för det här steget.
 */
async function ensureUserDocument(user) {
    const ref = (0, firestore_1.doc)(firebase_1.db, "users", user.uid);
    const snap = await (0, firestore_1.getDoc)(ref);
    if (snap.exists()) {
        return snap.data();
    }
    const newUser = {
        uid: user.uid,
        displayName: user.displayName ?? user.email?.split("@")[0] ?? "Förälder",
        email: user.email ?? "",
        avatarUrl: user.photoURL ?? undefined,
        teamId: null,
        createdAt: (0, firestore_1.serverTimestamp)(),
    };
    await (0, firestore_1.setDoc)(ref, newUser);
    return newUser;
}
