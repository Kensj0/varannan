import { httpsCallable } from "firebase/functions";
import { functions } from "./firebase";

/**
 * Klientsidan av Google Kalender-kopplingen. Själva token hanteras helt
 * på servern (functions/src/googleCalendarSync.ts) — klienten ser bara
 * status via users/{uid}.googleCalendar.
 */

/** Skickar användaren till Googles samtyckesfönster. Kommer tillbaka till /?google=… */
export async function startGoogleCalendarConnect(): Promise<void> {
  const fn = httpsCallable<void, { url: string }>(functions, "startGoogleCalendarConnect");
  const { data } = await fn();
  window.location.assign(data.url);
}

/** Tar bort Varannan-kalendrarna i Google, återkallar och raderar token. */
export async function disconnectGoogleCalendar(): Promise<void> {
  const fn = httpsCallable(functions, "disconnectGoogleCalendar");
  await fn();
}

export async function syncGoogleCalendarNow(): Promise<void> {
  const fn = httpsCallable(functions, "syncGoogleCalendarNow");
  await fn();
}

/** Text för resultatet i ?google=… efter att Google skickat tillbaka användaren. */
export function googleConnectResultMessage(result: string): { ok: boolean; text: string } | null {
  switch (result) {
    case "connected":
      return { ok: true, text: "Google Kalender är kopplad. Dina kalendrar finns nu i Google som \"… – Varannan\"." };
    case "denied":
      return { ok: false, text: "Du avbröt kopplingen till Google. Inget har ändrats." };
    case "scope":
      return {
        ok: false,
        text: "Varannan fick inte tillgång till Google Kalender. Försök igen och låt rutan för kalendern vara ikryssad.",
      };
    case "error":
      return { ok: false, text: "Kopplingen till Google misslyckades. Försök igen om en stund." };
    default:
      return null;
  }
}
