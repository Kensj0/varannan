import { httpsCallable } from "firebase/functions";
import { functions } from "./firebase";

/**
 * Klientsidan av Google Kalender-kopplingen. Själva token hanteras helt
 * på servern (functions/src/googleCalendarSync.ts) — klienten ser bara
 * status via users/{uid}.googleCalendar.
 */

/**
 * Skickar användaren till Googles samtyckesfönster. Kommer tillbaka till
 * /?google=…. teamId/childId (valfria) är vilken kalender knappen
 * klickades från — skickas med så att OAuth-callbacken kan lägga med dem
 * i returadressen och användaren hamnar tillbaka på SAMMA kalender,
 * inte en slumpmässig förstavalsflik.
 */
export async function startGoogleCalendarConnect(teamId?: string, childId?: string): Promise<void> {
  const fn = httpsCallable<{ teamId?: string; childId?: string }, { url: string }>(
    functions,
    "startGoogleCalendarConnect",
  );
  const { data } = await fn({ teamId, childId });
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

export interface GoogleCalendarStatus {
  /** Är Google-kontot kopplat alls (styr om "Koppla"-knappen ska gå via full OAuth eller inte). */
  accountConnected: boolean;
  /** Har just DET HÄR barnet en egen kalender just nu. */
  connected: boolean;
  /**
   * Fanns kopplad, men en synk upptäckte att kalendern raderats i Google
   * (vem som helst kan göra det manuellt i sin Google Kalender) — inte
   * samma sak som att användaren kopplat bort den i appen. UI:t ska visa
   * "Kalendern togs bort i Google" + "Koppla igen", INTE bara återskapa
   * den tyst.
   */
  removedInGoogle: boolean;
}

/** Per-barn-status i kalenderns inställningspanel (CalendarSettingsPanel). */
export async function getGoogleCalendarStatus(teamId: string, childId: string): Promise<GoogleCalendarStatus> {
  const fn = httpsCallable<{ teamId: string; childId: string }, GoogleCalendarStatus>(
    functions,
    "getGoogleCalendarStatus",
  );
  const { data } = await fn({ teamId, childId });
  return data;
}

/** Lägger till (eller lägger tillbaka) det här barnets kalender. Kräver att kontot redan är kopplat. */
export async function connectGoogleCalendarForChild(teamId: string, childId: string): Promise<void> {
  const fn = httpsCallable(functions, "connectGoogleCalendarForChild");
  await fn({ teamId, childId });
}

/**
 * Tar bort DET HÄR barnets kalender ur Google. Var det barnets kalender
 * den SISTA som fanns på kontot återkallas hela Google-kopplingen —
 * `accountDisconnected` talar om vilket som hände, så UI:t kan visa rätt
 * besked (bara den här kalendern borta, eller hela kontot).
 */
export async function disconnectGoogleCalendarForChild(
  teamId: string,
  childId: string,
): Promise<{ accountDisconnected: boolean }> {
  const fn = httpsCallable<{ teamId: string; childId: string }, { ok: boolean; accountDisconnected: boolean }>(
    functions,
    "disconnectGoogleCalendarForChild",
  );
  const { data } = await fn({ teamId, childId });
  return { accountDisconnected: data.accountDisconnected };
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
