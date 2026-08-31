/**
 * Skriver public/firebase-messaging-sw.js med de riktiga
 * NEXT_PUBLIC_FIREBASE_*-värdena inbakade, som en vanlig statisk fil.
 *
 * Körs som ett "prebuild"-steg (se package.json) innan `next build`,
 * så env-värdena läses från samma .env.local som resten av appen.
 * Tidigare gjordes detta av en Next.js Route Handler
 * (app/firebase-messaging-sw.js/route.ts) med `force-dynamic`, men det
 * tvingade hela appen att köras som en SSR Cloud Run-tjänst istället för
 * en statisk export. Värdena är samma publika config som redan skickas
 * till varje sida i huvud-JS-bunten — de är inga hemligheter, det är
 * firestore.rules som faktiskt skyddar data.
 */
const fs = require("fs");
const path = require("path");

// Next.js läser .env.local automatiskt vid `next build`, men det här
// scriptet körs som ett fristående Node-script innan dess — så vi
// laddar filen själva om den finns (samma beteende i lokal dev).
try {
  const dotenvPath = path.join(__dirname, "..", ".env.local");
  if (fs.existsSync(dotenvPath)) {
    for (const line of fs.readFileSync(dotenvPath, "utf8").split("\n")) {
      const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (match && !(match[1] in process.env)) {
        process.env[match[1]] = match[2].trim();
      }
    }
  }
} catch {
  // Inget .env.local (t.ex. i CI där env sätts på annat sätt) — ok.
}

const config = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY ?? "",
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN ?? "",
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID ?? "",
  storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET ?? "",
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID ?? "",
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID ?? "",
};

if (!config.apiKey || !config.projectId) {
  console.warn(
    "[generate-sw] Varning: NEXT_PUBLIC_FIREBASE_* saknas i miljön — " +
      "firebase-messaging-sw.js byggs med tomma värden. Push-notiser " +
      "kommer inte fungera förrän .env.local (eller byggmiljöns env) är ifyllt."
  );
}

const body = `
importScripts("https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js");
importScripts("https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging-compat.js");

firebase.initializeApp(${JSON.stringify(config)});

const messaging = firebase.messaging();

// Pushar som kommer in medan appen INTE är öppen i en flik visas här.
// (Är fliken öppen hanteras de istället av onMessage i lib/pushNotifications.ts,
// eftersom webbläsaren inte visar OS-notiser för en flik som redan har fokus.)
messaging.onBackgroundMessage((payload) => {
  const title = (payload.notification && payload.notification.title) || "Varannan";
  const body = (payload.notification && payload.notification.body) || "";
  self.registration.showNotification(title, {
    body,
    data: payload.data,
  });
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(clients.openWindow("/"));
});
`.trim();

const outPath = path.join(__dirname, "..", "public", "firebase-messaging-sw.js");
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, body + "\n");
console.log(`[generate-sw] Skrev ${outPath}`);
