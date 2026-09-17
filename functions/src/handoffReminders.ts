/**
 * handoffReminders.ts
 * --------------------
 * Schemalagd funktion som en gång om dagen letar upp kommande
 * ansvarsbyten (för alla team/barn) och skickar push-påminnelser,
 * enligt varje förälders egna handoffReminderPrefs
 * (users/{uid}.handoffReminderPrefs — se CalendarSettingsPanel):
 *
 *   - "Samma dag": skickas dagen bytet sker, om det sker senare idag.
 *   - "Dagen innan": skickas dagen innan, om bytet sker imorgon.
 *   - "Mail": om påslaget, skickas SAMMA påminnelse som mail också,
 *     utöver push — en fallback för den som inte litar på att push
 *     kommer fram (se email.ts). Kräver secrets GMAIL_USER och
 *     GMAIL_APP_PASSWORD (Firebase Secret Manager), sätts EN gång:
 *
 *       firebase functions:secrets:set GMAIL_USER
 *       firebase functions:secrets:set GMAIL_APP_PASSWORD
 *
 *     GMAIL_APP_PASSWORD är ett Google-"app-lösenord" (kräver
 *     2-stegsverifiering på Google-kontot), inte det vanliga
 *     lösenordet: myaccount.google.com/apppasswords.
 *
 * Föräldern som TAR ÖVER får "Du tar över ansvaret", föräldern som
 * LÄMNAR ÖVER får "Du lämnar över ansvaret" — båda med antal opackade
 * saker i packlistorna, som i originalappens notis
 * ("Byte kl 12:00 idag (2 saker kvar att packa)").
 */

import * as admin from "firebase-admin";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { CustodyCycleDoc, ShiftRequestDoc, PackListDoc, UserDoc, DEFAULT_HANDOFF_REMINDER_PREFS } from "../../types/schema";
import { switchInstantForDate } from "../../lib/custodyCycle";
import { findHandoffOnDate, HandoffOnDate } from "../../lib/handoffPreview";
import { sendPushToUser } from "./notifications";
import { sendEmail, GMAIL_USER, GMAIL_APP_PASSWORD } from "./email";

function addDaysToDateString(dateStr: string, days: number): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(dt.getUTCDate()).padStart(2, "0")}`;
}

/** "2026-09-10" för `instant`, sett i `timeZone` (en-CA formaterar redan som YYYY-MM-DD). */
function dateStringInTimeZone(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(
    instant
  );
}

function timeStringInTimeZone(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("sv-SE", { timeZone, hour: "2-digit", minute: "2-digit", hour12: false }).format(
    instant
  );
}

export const sendHandoffReminders = onSchedule(
  {
    schedule: "every day 08:00",
    timeZone: "Europe/Stockholm",
    // Pinnad till us-central1, till skillnad från övriga callables som
    // ligger i europe-north1: Cloud Scheduler finns INTE i europe-north1
    // ("Location 'europe-north1' is not a valid location"), och utan
    // schemajobb triggas funktionen aldrig. Det här är ett bakgrundsjobb
    // en gång om dygnet — ingen väntar på svaret, så regionen är likgiltig.
    region: "us-central1",
    secrets: [GMAIL_USER, GMAIL_APP_PASSWORD],
  },
  async () => {
    const db = admin.firestore();
    const teamsSnap = await db.collection("teams").get();

    for (const teamDoc of teamsSnap.docs) {
      const team = teamDoc.data();
      const parentIds: string[] = team.parentIds ?? [];
      const childIds: string[] = team.childIds ?? [];
      if (parentIds.length === 0 || childIds.length === 0) continue;

      for (const childId of childIds) {
        await remindForChild(db, teamDoc.id, childId, parentIds, childIds.length > 1);
      }
    }
  }
);

async function remindForChild(
  db: admin.firestore.Firestore,
  teamId: string,
  childId: string,
  parentIds: string[],
  includeChildName: boolean
): Promise<void> {
  const cycleSnap = await db.doc(`teams/${teamId}/children/${childId}/custodyCycle/main`).get();
  if (!cycleSnap.exists) return;
  const cycle = cycleSnap.data() as CustodyCycleDoc;
  const timezone = cycle.timezone || "Europe/Stockholm";

  const shiftsSnap = await db
    .collection(`teams/${teamId}/shiftRequests`)
    .where("childId", "==", childId)
    .where("status", "==", "approved")
    .get();
  const approvedShifts = shiftsSnap.docs.map((d) => d.data() as ShiftRequestDoc);

  const todayStr = dateStringInTimeZone(new Date(), timezone);
  const tomorrowStr = addDaysToDateString(todayStr, 1);

  const sameDayHandoff = findHandoffOnDate(cycle, approvedShifts, switchInstantForDate(cycle, todayStr));
  const dayBeforeHandoff = findHandoffOnDate(cycle, approvedShifts, switchInstantForDate(cycle, tomorrowStr));
  if (!sameDayHandoff && !dayBeforeHandoff) return;

  // Antal opackade saker totalt i barnets packlistor — samma siffra som
  // originalappens notis visar.
  const packListsSnap = await db.collection(`teams/${teamId}/packLists`).where("childId", "==", childId).get();
  let unpackedCount = 0;
  for (const doc of packListsSnap.docs) {
    const list = doc.data() as PackListDoc;
    unpackedCount += list.items.filter((item) => !item.checked).length;
  }
  const packNote = unpackedCount > 0 ? ` (${unpackedCount} sak${unpackedCount === 1 ? "" : "er"} kvar att packa)` : "";

  let childName = "";
  if (includeChildName) {
    const childSnap = await db.doc(`teams/${teamId}/children/${childId}`).get();
    childName = childSnap.data()?.name ? ` · ${childSnap.data()?.name}` : "";
  }

  async function notify(handoff: HandoffOnDate, whenLabel: "idag" | "imorgon", prefKey: "sameDay" | "dayBefore") {
    const time = timeStringInTimeZone(handoff.at, timezone);
    for (const uid of parentIds) {
      if (uid !== handoff.toParentId && uid !== handoff.fromParentId) continue;

      const userSnap = await db.doc(`users/${uid}`).get();
      const user = userSnap.data() as UserDoc | undefined;
      const prefs = user?.handoffReminderPrefs ?? DEFAULT_HANDOFF_REMINDER_PREFS;
      if (!prefs[prefKey]) continue;

      const title = uid === handoff.toParentId ? "Du tar över ansvaret" : "Du lämnar över ansvaret";
      const body = `Byte kl ${time} ${whenLabel}${packNote}${childName}`;

      await sendPushToUser(db, uid, { title, body });

      // Mail är ett TILLÄGG till push (fallback för den som inte litar
      // på att push kommer fram), inte en ersättning — skickas därför
      // alltid utöver push när användaren slagit på det, oavsett om
      // push-anropet ovan lyckades eller inte (vi kan inte veta det).
      if (prefs.email && user?.email) {
        await sendEmail(user.email, title, body);
      }
    }
  }

  if (sameDayHandoff) await notify(sameDayHandoff, "idag", "sameDay");
  if (dayBeforeHandoff) await notify(dayBeforeHandoff, "imorgon", "dayBefore");
}
