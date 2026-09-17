/**
 * recurrence.ts
 * -------------
 * Expanderar återkommande aktiviteter till konkreta tillfällen inom ett
 * datumintervall.
 *
 * Designval: vi lagrar ALDRIG en rad per tillfälle i Firestore — bara
 * moder-eventet med sin `recurrence`-regel. Expansionen sker vid
 * rendering, precis som cykel-beräkningen i custodyCycle.ts. Det håller
 * databasen liten och gör att en ändrad regel slår igenom överallt direkt.
 */

import { EventDoc, RecurrenceRule } from "../types/schema";

/** Ett enskilt tillfälle av ett (möjligen återkommande) event. */
export interface EventOccurrence {
  /** Unikt i UI:t: "{eventId}:{ISO-datum}" — moder-eventets id finns i eventId. */
  occurrenceId: string;
  eventId: string;
  title: string;
  startAt: Date;
  endAt: Date;
  childId?: string;
  /** true om detta är ett genererat tillfälle, inte originaldatumet. */
  isRecurring: boolean;
  /**
   * true om moder-eventet har en återkommanderegel — till skillnad från
   * `isRecurring` gäller det ÄVEN seriens första tillfälle. Det är det
   * här fältet UI:t ska fråga på ("ta bort alla eller bara den här?"),
   * eftersom seriens originaldatum annars hade behandlats som en
   * engångsaktivitet.
   */
  hasRecurrence: boolean;
}

const MAX_OCCURRENCES = 500; // skyddsnät mot oändliga loopar vid trasig data

/**
 * Expanderar ett event till alla tillfällen som överlappar [rangeStart, rangeEnd).
 * Ett event utan `recurrence` ger noll eller ett tillfälle.
 */
export function expandEvent(event: EventDoc, rangeStart: Date, rangeEnd: Date): EventOccurrence[] {
  const start = fromTs(event.startAt);
  const end = fromTs(event.endAt);
  const durationMs = Math.max(0, end.getTime() - start.getTime());

  // Tillfällen som tagits bort en och en ur serien ("bara den här
  // gången") — filtreras bort efter expansionen, se EventDoc.
  const excluded = new Set(event.excludedOccurrences ?? []);
  const keep = (occurrences: EventOccurrence[]) =>
    excluded.size === 0 ? occurrences : occurrences.filter((o) => !excluded.has(o.startAt.toISOString()));

  if (!event.recurrence) {
    return keep(
      start >= rangeStart && start < rangeEnd ? [toOccurrence(event, start, durationMs, false)] : []
    );
  }

  const rule = event.recurrence;
  const until = rule.until ? fromTs(rule.until) : null;
  const hardStop = until && until < rangeEnd ? until : rangeEnd;

  const occurrences: EventOccurrence[] = [];
  let cursor = new Date(start);
  let guard = 0;

  while (cursor < hardStop && guard++ < MAX_OCCURRENCES) {
    if (cursor >= rangeStart) {
      // Veckoregler med byWeekday kan ge flera tillfällen per intervall
      // (t.ex. "varje måndag och onsdag").
      if (rule.frequency === "weekly" && rule.byWeekday?.length) {
        for (const weekday of rule.byWeekday) {
          const occurrence = alignToWeekday(cursor, weekday, start);
          if (occurrence >= rangeStart && occurrence < hardStop && occurrence >= start) {
            occurrences.push(toOccurrence(event, occurrence, durationMs, occurrence.getTime() !== start.getTime()));
          }
        }
      } else {
        occurrences.push(toOccurrence(event, cursor, durationMs, cursor.getTime() !== start.getTime()));
      }
    }
    cursor = advance(cursor, rule);
  }

  // Dedupliceras och sorteras — byWeekday-grenen kan ge dubbletter i
  // gränsfall när intervallet spänner över samma vecka två gånger.
  const seen = new Set<string>();
  return keep(
    occurrences
      .filter((o) => (seen.has(o.occurrenceId) ? false : seen.add(o.occurrenceId)))
      .sort((a, b) => a.startAt.getTime() - b.startAt.getTime())
  );
}

/** Expanderar en hel lista events — det UI:t faktiskt anropar. */
export function expandEvents(events: EventDoc[], rangeStart: Date, rangeEnd: Date): EventOccurrence[] {
  return events
    .flatMap((event) => expandEvent(event, rangeStart, rangeEnd))
    .sort((a, b) => a.startAt.getTime() - b.startAt.getTime());
}

// ---------------------------------------------------------------------------
// Hjälpfunktioner
// ---------------------------------------------------------------------------

function advance(date: Date, rule: RecurrenceRule): Date {
  const next = new Date(date);
  const step = Math.max(1, rule.interval || 1);

  switch (rule.frequency) {
    case "daily":
      next.setDate(next.getDate() + step);
      break;
    case "weekly":
      next.setDate(next.getDate() + 7 * step);
      break;
    case "monthly":
      next.setMonth(next.getMonth() + step);
      break;
    case "yearly":
      next.setFullYear(next.getFullYear() + step);
      break;
  }
  return next;
}

/**
 * Flyttar `weekStart` till angiven veckodag (0=söndag) med bibehållen
 * klockslag från originalet.
 */
function alignToWeekday(weekStart: Date, weekday: number, original: Date): Date {
  const result = new Date(weekStart);
  const diff = weekday - result.getDay();
  result.setDate(result.getDate() + diff);
  result.setHours(original.getHours(), original.getMinutes(), 0, 0);
  return result;
}

function toOccurrence(event: EventDoc, startAt: Date, durationMs: number, isRecurring: boolean): EventOccurrence {
  return {
    occurrenceId: `${event.id}:${startAt.toISOString()}`,
    eventId: event.id,
    title: event.title,
    startAt,
    endAt: new Date(startAt.getTime() + durationMs),
    childId: event.childId,
    isRecurring,
    hasRecurrence: !!event.recurrence,
  };
}

function fromTs(ts: { seconds: number; nanoseconds: number }): Date {
  return new Date(ts.seconds * 1000 + ts.nanoseconds / 1e6);
}
