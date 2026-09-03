"use client";

import { doc, updateDoc, arrayUnion, arrayRemove } from "firebase/firestore";
import { app, db } from "./firebase";

/**
 * Push-notiser (Firebase Cloud Messaging). Allt här körs bara i
 * webbläsaren — SSR/prerendering har varken `window`, `navigator` eller
 * notification-API:er, så varje funktion kollar det innan den rör vid
 * något av det.
 *
 * Flödet:
 *   1. requestAndSavePushToken() — frågar om lov, registrerar service
 *      workern (public/firebase-messaging-sw.js), hämtar en FCM-token
 *      och sparar den på users/{uid}.fcmTokens.
 *   2. Cloud Functions (functions/src/notifications.ts) skickar sedan
 *      pushar till de token:erna när t.ex. ett byte föreslås/besvaras.
 *   3. listenForForegroundMessages() visar en enkel banderoll om en
 *      push kommer in medan fliken redan är öppen — annars syns den
 *      bara som en vanlig OS-notis (service workerns jobb).
 */

export type PushPermissionState = "unsupported" | "default" | "granted" | "denied";

export async function getPushPermissionState(): Promise<PushPermissionState> {
  if (typeof window === "undefined" || !("Notification" in window)) return "unsupported";
  const { isSupported } = await import("firebase/messaging");
  if (!(await isSupported())) return "unsupported";
  return Notification.permission as PushPermissionState;
}

/**
 * Frågar om lov (om det inte redan avgjorts), registrerar service
 * workern och sparar en FCM-token på användaren. Måste anropas från en
 * användarinitierad händelse (t.ex. en knapptryckning) — annars
 * blockerar vissa webbläsare behörighetsdialogen.
 */
export interface PushSetupResult {
  permission: PushPermissionState;
  /** Sant bara när en token faktiskt hämtats OCH sparats på användaren. */
  registered: boolean;
  /** Ifylld när något gick fel efter att lov getts. Visas för användaren. */
  error?: string;
}

/**
 * Frågar om lov, registrerar service workern och sparar en FCM-token.
 *
 * Returnerar `registered` separat från `permission`: att webbläsaren
 * gett lov betyder INTE att notiser fungerar. Utan giltig VAPID-nyckel,
 * eller om getToken misslyckas, finns ingen token att skicka till — och
 * då kommer inga notiser fram trots att behörigheten ser rätt ut.
 * Tidigare rapporterades bara behörigheten, vilket gjorde att appen
 * påstod att notiser var på när de i själva verket var trasiga.
 */
export async function requestAndSavePushToken(uid: string): Promise<PushSetupResult> {
  if (typeof window === "undefined" || !("Notification" in window)) {
    return { permission: "unsupported", registered: false };
  }

  const { isSupported, getMessaging, getToken } = await import("firebase/messaging");
  if (!(await isSupported())) {
    return {
      permission: "unsupported",
      registered: false,
      error:
        "Webbläsaren stöder inte webbpush. På iPhone måste appen läggas till på hemskärmen — i Safari-fliken fungerar notiser inte.",
    };
  }

  const permission = await Notification.requestPermission();
  if (permission !== "granted") {
    return { permission: permission as PushPermissionState, registered: false };
  }

  const vapidKey = process.env.NEXT_PUBLIC_FIREBASE_VAPID_KEY;
  if (!vapidKey) {
    return {
      permission: "granted",
      registered: false,
      error:
        "Appen saknar nyckeln som krävs för notiser (VAPID). Det är ett konfigurationsfel i appen, inte i din telefon.",
    };
  }

  try {
    const registration = await navigator.serviceWorker.register("/firebase-messaging-sw.js");
    // Vänta in service workern: getToken misslyckas tyst om den ännu
    // inte är aktiv, vilket är vanligt precis efter första laddningen.
    await navigator.serviceWorker.ready;

    const messaging = getMessaging(app);
    const token = await getToken(messaging, { vapidKey, serviceWorkerRegistration: registration });
    if (!token) {
      return {
        permission: "granted",
        registered: false,
        error: "Ingen notistoken kunde hämtas. Ladda om sidan och försök igen.",
      };
    }

    await updateDoc(doc(db, "users", uid), { fcmTokens: arrayUnion(token) });
    return { permission: "granted", registered: true };
  } catch (err: any) {
    return {
      permission: "granted",
      registered: false,
      error: err?.message ?? "Något gick fel när notiser skulle aktiveras.",
    };
  }
}

/**
 * Ser till att en giltig token finns när lov redan getts.
 *
 * FCM-tokens roteras och kan bli ogiltiga (ny webbläsarinstallation,
 * rensad lagring, utgången token). Utan det här kunde en användare ha
 * "notiser på" i månader utan att någonsin få en enda, eftersom den
 * sparade token slutat gälla och ingenting hämtade en ny.
 */
export interface PushRegistrationCheck {
  ok: boolean;
  /** Läsbar orsak när det INTE gick. Visas rakt av för användaren. */
  reason?: string;
}

/**
 * Ser till att en giltig token finns när lov redan getts.
 *
 * Returnerar en LÄSBAR orsak i stället för bara false. Kedjan som måste
 * hålla — stöd, behörighet, VAPID-nyckel, service worker, getToken,
 * skrivning till users/{uid} — har sex länkar, och tidigare gav alla
 * brott samma intetsägande "inte registrerad än". Utan att veta vilken
 * länk som brast går felet inte att åtgärda.
 */
export async function ensurePushTokenRegistered(uid: string): Promise<PushRegistrationCheck> {
  if (typeof window === "undefined" || !("Notification" in window)) {
    return { ok: false, reason: "Den här webbläsaren stöder inte notiser." };
  }
  if (Notification.permission !== "granted") {
    return { ok: false, reason: "Notiser är inte tillåtna i webbläsaren." };
  }

  const { isSupported, getMessaging, getToken } = await import("firebase/messaging");
  if (!(await isSupported())) {
    return {
      ok: false,
      reason:
        "Webbläsaren stöder inte webbpush. På iPhone måste appen läggas till på hemskärmen — i Safari-fliken fungerar notiser inte.",
    };
  }

  const vapidKey = process.env.NEXT_PUBLIC_FIREBASE_VAPID_KEY;
  if (!vapidKey) {
    return {
      ok: false,
      reason:
        "Appen saknar VAPID-nyckeln som krävs för notiser. Det är ett konfigurationsfel i appen (NEXT_PUBLIC_FIREBASE_VAPID_KEY), inte något fel på din enhet.",
    };
  }

  let registration: ServiceWorkerRegistration;
  try {
    registration = await navigator.serviceWorker.register("/firebase-messaging-sw.js");
    // getToken misslyckas tyst om service workern inte hunnit bli aktiv.
    await navigator.serviceWorker.ready;
  } catch (err: any) {
    return {
      ok: false,
      reason: `Kunde inte starta bakgrundstjänsten för notiser: ${err?.message ?? "okänt fel"}`,
    };
  }

  try {
    const token = await getToken(getMessaging(app), {
      vapidKey,
      serviceWorkerRegistration: registration,
    });
    if (!token) {
      return { ok: false, reason: "Ingen notistoken kunde hämtas. Ladda om sidan och försök igen." };
    }
    await updateDoc(doc(db, "users", uid), { fcmTokens: arrayUnion(token) });
    return { ok: true };
  } catch (err: any) {
    return {
      ok: false,
      reason: `Notistoken kunde inte hämtas: ${err?.message ?? "okänt fel"}`,
    };
  }
}


/** Städa bort den här enhetens token, t.ex. vid utloggning. */
export async function removePushToken(uid: string, token: string): Promise<void> {
  await updateDoc(doc(db, "users", uid), { fcmTokens: arrayRemove(token) });
}

/**
 * Sparar när överlämnings-påminnelser ska skickas (dagen innan / samma
 * dag). Läses av den schemalagda Cloud Functionen
 * (functions/src/handoffReminders.ts) för just den här användaren.
 */
export async function updateHandoffReminderPrefs(
  uid: string,
  prefs: { dayBefore: boolean; sameDay: boolean }
): Promise<void> {
  await updateDoc(doc(db, "users", uid), { handoffReminderPrefs: prefs });
}

/**
 * Visar pushar som kommer in medan fliken är öppen (webbläsaren visar
 * INTE en OS-notis själv i det läget — service workern hanterar bara
 * bakgrundsfallet). Returnerar en avregistreringsfunktion.
 */
export async function listenForForegroundMessages(
  onMessageReceived: (title: string, body: string) => void
): Promise<() => void> {
  if (typeof window === "undefined" || !("Notification" in window)) return () => {};
  const { isSupported, getMessaging, onMessage } = await import("firebase/messaging");
  if (!(await isSupported())) return () => {};

  const messaging = getMessaging(app);
  return onMessage(messaging, (payload) => {
    onMessageReceived(payload.notification?.title ?? "Varannan", payload.notification?.body ?? "");
  });
}

/**
 * Skickar en testnotis till den inloggades egna enheter. Kastar med ett
 * läsbart meddelande när något i kedjan (token, VAPID, service worker)
 * inte stämmer, så felet går att visa direkt i gränssnittet.
 */
export async function sendTestPush(): Promise<{ sent: number; removed: number }> {
  const { httpsCallable } = await import("firebase/functions");
  const { functions } = await import("./firebase");
  const fn = httpsCallable<Record<string, never>, { sent: number; removed: number }>(
    functions,
    "sendTestPush"
  );
  const res = await fn({});
  return res.data;
}
