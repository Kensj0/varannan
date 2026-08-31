import { NextResponse } from "next/server";

/**
 * Service workern MÅSTE serveras från roten (/firebase-messaging-sw.js)
 * för att FCM ska få kontrollera hela sajtens scope. Den byggs som en
 * Next.js route istället för en statisk fil i public/, så den kan
 * interpolera de riktiga NEXT_PUBLIC_FIREBASE_*-värdena vid request-
 * tid — annars hade filen behövt hårdkodas med Kennys riktiga nycklar
 * i repot, vilket varken jag (utan tillgång till dem) eller ett
 * generellt bygge-steg kan göra på ett bra sätt.
 *
 * Värdena är samma publika config som redan skickas till varje sida i
 * huvud-JS-bunten — de är inga hemligheter, det är firestore.rules som
 * faktiskt skyddar data.
 */
export const dynamic = "force-dynamic";

export async function GET() {
  const config = {
    apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
    authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
    projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
    storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
    messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
    appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
  };

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

  return new NextResponse(body, {
    headers: {
      "Content-Type": "application/javascript",
      "Cache-Control": "no-cache",
    },
  });
}
