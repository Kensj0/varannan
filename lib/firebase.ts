import { initializeApp, getApps, getApp } from "firebase/app";
import { getAuth, connectAuthEmulator } from "firebase/auth";
import {
  getFirestore,
  initializeFirestore,
  persistentLocalCache,
  persistentMultipleTabManager,
  connectFirestoreEmulator,
} from "firebase/firestore";
import { getFunctions, connectFunctionsEmulator } from "firebase/functions";

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

export const app = getApps().length ? getApp() : initializeApp(firebaseConfig);
export const auth = getAuth(app);

/**
 * Firestore med disk-cache (IndexedDB). En återkommande besökare renderar
 * schema, ställning och chatt direkt ur cachen medan onSnapshot-lyssnarna
 * revaliderar i bakgrunden — appen är daglig och samma familj öppnar den
 * om och om igen. `persistentMultipleTabManager` gör att flera öppna
 * flikar delar en cache utan att slå ut varandras lås.
 *
 * initializeFirestore får bara anropas en gång och bara i webbläsaren
 * (IndexedDB saknas under Next-bygget och vid HMR-omladdning återanvänds
 * appen) — därför fallbacken till getFirestore.
 */
function initDb() {
  if (typeof window === "undefined") return getFirestore(app);
  try {
    return initializeFirestore(app, {
      localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
    });
  } catch {
    return getFirestore(app);
  }
}

export const db = initDb();
export const functions = getFunctions(app, "europe-north1"); // matchar regionen de user-vända callables deployas till

// Lokal utveckling: `npm run emulators` i ett annat fönster, sätt sedan
// NEXT_PUBLIC_USE_FIREBASE_EMULATORS=true i .env.local
if (process.env.NEXT_PUBLIC_USE_FIREBASE_EMULATORS === "true" && typeof window !== "undefined") {
  connectAuthEmulator(auth, "http://localhost:9099", { disableWarnings: true });
  connectFirestoreEmulator(db, "localhost", 8080);
  connectFunctionsEmulator(functions, "localhost", 5001);
}
