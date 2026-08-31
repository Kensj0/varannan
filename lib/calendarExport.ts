/**
 * calendarExport.ts
 * ------------------
 * Klientsidan av kalenderprenumerationen: hämtar/roterar det hemliga
 * token som ICS-flödet skyddas av, och bygger de länkar som Google,
 * Apple respektive Outlook vill ha.
 *
 * Alla tre prenumererar på SAMMA ICS-URL (functions/src/calendarFeed.ts);
 * det som skiljer är bara hur man matar in den:
 *   - Google: en /r/settings/addbyurl-länk med URL:en som parameter
 *   - Apple:  webcal:// — iOS/macOS öppnar Kalender direkt
 *   - Outlook: addcalendar-länken i Outlook Web
 */

import { doc, getDoc } from "firebase/firestore";
import { httpsCallable } from "firebase/functions";
import { db, functions } from "./firebase";
import { ParentColorId } from "../types/schema";

/**
 * Bas-URL till den deployade calendarFeed-funktionen. Sätts i .env.local
 * (NEXT_PUBLIC_CALENDAR_FEED_URL) eftersom den innehåller projekt-id och
 * region, som skiljer sig mellan dev och prod.
 */
const FEED_BASE = process.env.NEXT_PUBLIC_CALENDAR_FEED_URL ?? "";

export interface CalendarFeedLinks {
  /** Rå https-URL till ICS-flödet — den som kan klistras in var som helst. */
  ics: string;
  /** webcal://-variant, som iOS/macOS Kalender öppnar direkt. */
  webcal: string;
  google: string;
  apple: string;
  outlook: string;
}

export function buildFeedLinks(teamId: string, childId: string, token: string): CalendarFeedLinks {
  const ics = `${FEED_BASE}?team=${encodeURIComponent(teamId)}&child=${encodeURIComponent(
    childId
  )}&token=${encodeURIComponent(token)}`;
  const webcal = ics.replace(/^https?:\/\//, "webcal://");
  const encoded = encodeURIComponent(ics);

  return {
    ics,
    webcal,
    google: `https://calendar.google.com/calendar/r/settings/addbyurl?cid=${encoded}`,
    apple: webcal,
    outlook: `https://outlook.live.com/calendar/0/addfromweb?url=${encoded}&name=${encodeURIComponent(
      "Varannan"
    )}`,
  };
}

/** Befintligt token för barnet, eller null om inget skapats än. */
export async function getCalendarFeedToken(teamId: string, childId: string): Promise<string | null> {
  const snap = await getDoc(doc(db, "teams", teamId));
  return snap.data()?.calendarFeedTokens?.[childId] ?? null;
}

/**
 * Skapar ett nytt token (eller roterar det befintliga). Roterar man,
 * slutar den gamla länken att fungera — det är så man återkallar en
 * delad prenumeration.
 */
export async function createCalendarFeedToken(teamId: string, childId: string): Promise<string> {
  const call = httpsCallable<{ teamId: string; childId: string }, { token: string }>(
    functions,
    "createCalendarFeedToken"
  );
  const result = await call({ teamId, childId });
  return result.data.token;
}

/**
 * Sparar förälderns valda schemafärg. Går via en callable eftersom
 * teams/{teamId} är låst för direkta klientskrivningar (firestore.rules)
 * — samma mönster som övriga team-skrivningar i appen.
 */
export async function updateParentColor(teamId: string, colorId: ParentColorId): Promise<void> {
  const call = httpsCallable<{ teamId: string; colorId: string }, { ok: boolean }>(
    functions,
    "setParentColor"
  );
  await call({ teamId, colorId });
}
