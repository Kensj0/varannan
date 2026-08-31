/**
 * calendarFeed.ts
 * ----------------
 * Serverar barnets schema som ett ICS-flöde (RFC 5545) på en hemlig URL.
 *
 * Varför ICS och inte tre olika API-integrationer: Google Calendar, Apple
 * Calendar och Outlook prenumererar alla på samma sorts ICS-URL. Ett enda
 * flöde täcker alltså alla tre, utan OAuth, utan att användaren behöver ge
 * appen skrivrättigheter i sin kalender, och det uppdateras av sig självt
 * när schemat ändras. (Den befintliga exportEventToGoogleCalendar skriver
 * in kopior i Googles kalender via OAuth — det är en annan sak och finns
 * kvar; det här är den läsbara prenumerationen.)
 *
 * Åtkomst styrs av ett hemligt token på team-dokumentet
 * (teams/{teamId}.calendarFeedTokens[childId]), skapat av den callable
 * createCalendarFeedToken. Vem som helst med URL:en kan läsa schemat —
 * så URL:en behandlas som en hemlighet, och kan återkallas genom att
 * generera ett nytt token (då slutar det gamla att fungera).
 */

import * as admin from "firebase-admin";
import * as crypto from "crypto";
import { onRequest } from "firebase-functions/v2/https";
import { onCall, HttpsError } from "firebase-functions/v2/https";
import {
  CustodyCycleDoc,
  ShiftRequestDoc,
  EventDoc,
  TeamParentProfile,
  PARENT_PALETTE,
} from "../../types/schema";
import { switchInstantForDate } from "../../lib/custodyCycle";
import { resolveResponsibleParent } from "../../lib/handoffPreview";
import { expandEvents } from "../../lib/recurrence";

/** Hur långt bak/fram flödet sträcker sig. Kalenderappar hämtar om det med jämna mellanrum. */
const MONTHS_BACK = 3;
const MONTHS_FORWARD = 12;

// ---------------------------------------------------------------------------
// callable: skapa (eller rotera) prenumerationstoken för ett barn
// ---------------------------------------------------------------------------

export const createCalendarFeedToken = onCall(async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Du måste vara inloggad.");

  const { teamId, childId } = request.data as { teamId?: string; childId?: string };
  if (!teamId || !childId) throw new HttpsError("invalid-argument", "teamId och childId krävs.");

  const db = admin.firestore();
  const teamRef = db.doc(`teams/${teamId}`);
  const teamSnap = await teamRef.get();
  if (!teamSnap.exists) throw new HttpsError("not-found", "Teamet finns inte.");

  const parentIds: string[] = teamSnap.data()?.parentIds ?? [];
  if (!parentIds.includes(uid)) throw new HttpsError("permission-denied", "Du tillhör inte teamet.");

  const token = crypto.randomBytes(24).toString("base64url");
  await teamRef.set({ calendarFeedTokens: { [childId]: token } }, { merge: true });

  return { token };
});

// ---------------------------------------------------------------------------
// HTTP: själva ICS-flödet
// ---------------------------------------------------------------------------

export const calendarFeed = onRequest({ cors: true }, async (req, res) => {
  const teamId = String(req.query.team ?? "");
  const childId = String(req.query.child ?? "");
  const token = String(req.query.token ?? "");

  if (!teamId || !childId || !token) {
    res.status(400).send("Saknar team, child eller token.");
    return;
  }

  const db = admin.firestore();
  const teamSnap = await db.doc(`teams/${teamId}`).get();
  const expected = teamSnap.data()?.calendarFeedTokens?.[childId];

  // Konstanttidsjämförelse så att token inte kan gissas fram tecken för tecken.
  if (!expected || !safeEqual(expected, token)) {
    res.status(403).send("Ogiltig eller återkallad länk.");
    return;
  }

  const childSnap = await db.doc(`teams/${teamId}/children/${childId}`).get();
  const childName = childSnap.data()?.name ?? "Barnet";

  const cycleSnap = await db.doc(`teams/${teamId}/children/${childId}/custodyCycle/main`).get();
  if (!cycleSnap.exists) {
    res.status(404).send("Inget schema uppsatt för barnet.");
    return;
  }
  const cycle = cycleSnap.data() as CustodyCycleDoc;
  const timezone = cycle.timezone || "Europe/Stockholm";

  const profiles: Record<string, TeamParentProfile> = teamSnap.data()?.parentProfiles ?? {};
  const nameFor = (uid: string) => profiles[uid]?.displayName ?? "Andra föräldern";

  const shiftsSnap = await db
    .collection(`teams/${teamId}/shiftRequests`)
    .where("childId", "==", childId)
    .where("status", "==", "approved")
    .get();
  const approvedShifts = shiftsSnap.docs.map((d) => d.data() as ShiftRequestDoc);

  const now = new Date();
  const rangeStart = new Date(now.getFullYear(), now.getMonth() - MONTHS_BACK, 1);
  const rangeEnd = new Date(now.getFullYear(), now.getMonth() + MONTHS_FORWARD, 1);

  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Varannan//Schema//SV",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${escapeText(`${childName}s schema`)}`,
    `X-WR-TIMEZONE:${timezone}`,
    // Hur ofta kalenderappen bör hämta om flödet.
    "REFRESH-INTERVAL;VALUE=DURATION:PT6H",
    "X-PUBLISHED-TTL:PT6H",
  ];

  // --- Ansvarsblock: ett event per sammanhängande period hos en förälder ---
  let blockStart: Date | null = null;
  let blockParent: string | null = null;

  for (let day = new Date(rangeStart); day < rangeEnd; day.setDate(day.getDate() + 1)) {
    const instant = switchInstantForDate(cycle, isoDate(day));
    const parentId = resolveResponsibleParent(cycle, approvedShifts, instant);

    if (blockParent === null) {
      blockParent = parentId;
      blockStart = instant;
    } else if (parentId !== blockParent) {
      lines.push(
        ...vevent({
          uid: `custody-${childId}-${blockStart!.getTime()}@varannan`,
          start: blockStart!,
          end: instant,
          summary: `${childName} hos ${nameFor(blockParent)}`,
          timezone,
        })
      );
      blockParent = parentId;
      blockStart = instant;
    }
  }

  if (blockParent && blockStart) {
    lines.push(
      ...vevent({
        uid: `custody-${childId}-${blockStart.getTime()}@varannan`,
        start: blockStart,
        end: switchInstantForDate(cycle, isoDate(rangeEnd)),
        summary: `${childName} hos ${nameFor(blockParent)}`,
        timezone,
      })
    );
  }

  // --- Aktiviteter ---
  const eventsSnap = await db.collection(`teams/${teamId}/events`).get();
  const events = eventsSnap.docs
    .map((d) => ({ ...(d.data() as EventDoc), id: d.id }))
    .filter((e) => !e.childId || e.childId === childId);

  for (const occurrence of expandEvents(events, rangeStart, rangeEnd)) {
    lines.push(
      ...vevent({
        uid: `event-${occurrence.eventId}-${occurrence.startAt.getTime()}@varannan`,
        start: occurrence.startAt,
        end: occurrence.endAt,
        summary: occurrence.title,
        timezone,
      })
    );
  }

  lines.push("END:VCALENDAR");

  res.set("Content-Type", "text/calendar; charset=utf-8");
  res.set("Cache-Control", "public, max-age=1800");
  res.set("Content-Disposition", `inline; filename="${childId}.ics"`);
  res.status(200).send(lines.join("\r\n"));
});

// ---------------------------------------------------------------------------
// ICS-hjälpare
// ---------------------------------------------------------------------------

function vevent(opts: { uid: string; start: Date; end: Date; summary: string; timezone: string }): string[] {
  return [
    "BEGIN:VEVENT",
    `UID:${opts.uid}`,
    `DTSTAMP:${utcStamp(new Date())}`,
    `DTSTART:${utcStamp(opts.start)}`,
    `DTEND:${utcStamp(opts.end)}`,
    ...foldLine(`SUMMARY:${escapeText(opts.summary)}`),
    "END:VEVENT",
  ];
}

/** "20260910T060000Z" — UTC-form, som alla tre kalenderapparna tolkar likadant. */
function utcStamp(date: Date): string {
  return `${date.toISOString().replace(/[-:]/g, "").split(".")[0]}Z`;
}

function isoDate(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

/** Komma, semikolon, backslash och radbrytning är specialtecken i ICS. */
function escapeText(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\n/g, "\\n");
}

/** RFC 5545 tillåter max 75 oktetter per rad; längre rader viks med inledande blanksteg. */
function foldLine(line: string): string[] {
  if (line.length <= 75) return [line];
  const out = [line.slice(0, 75)];
  let rest = line.slice(75);
  while (rest.length > 74) {
    out.push(` ${rest.slice(0, 74)}`);
    rest = rest.slice(74);
  }
  if (rest) out.push(` ${rest}`);
  return out;
}

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

// ---------------------------------------------------------------------------
// callable: välj schemafärg
// ---------------------------------------------------------------------------

/**
 * Sätter förälderns egen färg i teamets cachade profil. Går via en callable
 * eftersom teams/{teamId} är låst för klientskrivningar — och för att
 * garantera att man bara kan ändra SIN EGEN färg, inte den andra förälderns.
 */
export const setParentColor = onCall(async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Du måste vara inloggad.");

  const { teamId, colorId } = request.data as { teamId?: string; colorId?: string };
  if (!teamId || !colorId) throw new HttpsError("invalid-argument", "teamId och colorId krävs.");
  if (!PARENT_PALETTE.some((c) => c.id === colorId)) {
    throw new HttpsError("invalid-argument", "Okänd färg.");
  }

  const db = admin.firestore();
  const teamRef = db.doc(`teams/${teamId}`);
  const teamSnap = await teamRef.get();
  if (!teamSnap.exists) throw new HttpsError("not-found", "Teamet finns inte.");

  const parentIds: string[] = teamSnap.data()?.parentIds ?? [];
  if (!parentIds.includes(uid)) throw new HttpsError("permission-denied", "Du tillhör inte teamet.");

  await teamRef.set({ parentProfiles: { [uid]: { colorId } } }, { merge: true });
  return { ok: true };
});
