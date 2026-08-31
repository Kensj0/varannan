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
export async function requestAndSavePushToken(uid: string): Promise<PushPermissionState> {
  if (typeof window === "undefined" || !("Notification" in window)) return "unsupported";

  const { isSupported, getMessaging, getToken } = await import("firebase/messaging");
  if (!(await isSupported())) return "unsupported";

  const permission = await Notification.requestPermission();
  if (permission !== "granted") return permission as PushPermissionState;

  const registration = await navigator.serviceWorker.register("/firebase-messaging-sw.js");
  const messaging = getMessaging(app);
  const vapidKey = process.env.NEXT_PUBLIC_FIREBASE_VAPID_KEY;
  if (!vapidKey) {
    // eslint-disable-next-line no-console
    console.error("NEXT_PUBLIC_FIREBASE_VAPID_KEY saknas — kan inte hämta push-token.");
    return "denied";
  }

  const token = await getToken(messaging, { vapidKey, serviceWorkerRegistration: registration });
  if (token) {
    await updateDoc(doc(db, "users", uid), { fcmTokens: arrayUnion(token) });
  }
  return "granted";
}

/** Städa bort den här enhetens token, t.ex. vid utloggning. */
export async function removePushToken(uid: string, token: string): Promise<void> {
  await updateDoc(doc(db, "users", uid), { fcmTokens: arrayRemove(token) });
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
