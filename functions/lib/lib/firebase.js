"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.functions = exports.db = exports.auth = exports.app = void 0;
const app_1 = require("firebase/app");
const auth_1 = require("firebase/auth");
const firestore_1 = require("firebase/firestore");
const functions_1 = require("firebase/functions");
/**
 * Alla NEXT_PUBLIC_*-värden hämtas från Firebase Console → Project
 * settings → Your apps → Web app. De är publika (client-side) och
 * skyddar ingenting i sig själva — det är firestore.rules som gör det.
 */
const firebaseConfig = {
    apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
    authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
    projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
    storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
    messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
    appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
};
exports.app = (0, app_1.getApps)().length ? (0, app_1.getApp)() : (0, app_1.initializeApp)(firebaseConfig);
exports.auth = (0, auth_1.getAuth)(exports.app);
exports.db = (0, firestore_1.getFirestore)(exports.app);
exports.functions = (0, functions_1.getFunctions)(exports.app, "europe-west1"); // matcha regionen ni deployar Functions till
// Lokal utveckling: `npm run emulators` i ett annat fönster, sätt sedan
// NEXT_PUBLIC_USE_FIREBASE_EMULATORS=true i .env.local
if (process.env.NEXT_PUBLIC_USE_FIREBASE_EMULATORS === "true" && typeof window !== "undefined") {
    (0, auth_1.connectAuthEmulator)(exports.auth, "http://localhost:9099", { disableWarnings: true });
    (0, firestore_1.connectFirestoreEmulator)(exports.db, "localhost", 8080);
    (0, functions_1.connectFunctionsEmulator)(exports.functions, "localhost", 5001);
}
