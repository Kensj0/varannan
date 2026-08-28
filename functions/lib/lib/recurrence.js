"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.expandEvent = expandEvent;
exports.expandEvents = expandEvents;
const MAX_OCCURRENCES = 500; // skyddsnät mot oändliga loopar vid trasig data
/**
 * Expanderar ett event till alla tillfällen som överlappar [rangeStart, rangeEnd).
 * Ett event utan `recurrence` ger noll eller ett tillfälle.
 */
function expandEvent(event, rangeStart, rangeEnd) {
    const start = fromTs(event.startAt);
    const end = fromTs(event.endAt);
    const durationMs = Math.max(0, end.getTime() - start.getTime());
    if (!event.recurrence) {
        return start >= rangeStart && start < rangeEnd
            ? [toOccurrence(event, start, durationMs, false)]
            : [];
    }
    const rule = event.recurrence;
    const until = rule.until ? fromTs(rule.until) : null;
    const hardStop = until && until < rangeEnd ? until : rangeEnd;
    const occurrences = [];
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
            }
            else {
                occurrences.push(toOccurrence(event, cursor, durationMs, cursor.getTime() !== start.getTime()));
            }
        }
        cursor = advance(cursor, rule);
    }
    // Dedupliceras och sorteras — byWeekday-grenen kan ge dubbletter i
    // gränsfall när intervallet spänner över samma vecka två gånger.
    const seen = new Set();
    return occurrences
        .filter((o) => (seen.has(o.occurrenceId) ? false : seen.add(o.occurrenceId)))
        .sort((a, b) => a.startAt.getTime() - b.startAt.getTime());
}
/** Expanderar en hel lista events — det UI:t faktiskt anropar. */
function expandEvents(events, rangeStart, rangeEnd) {
    return events
        .flatMap((event) => expandEvent(event, rangeStart, rangeEnd))
        .sort((a, b) => a.startAt.getTime() - b.startAt.getTime());
}
// ---------------------------------------------------------------------------
// Hjälpfunktioner
// ---------------------------------------------------------------------------
function advance(date, rule) {
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
function alignToWeekday(weekStart, weekday, original) {
    const result = new Date(weekStart);
    const diff = weekday - result.getDay();
    result.setDate(result.getDate() + diff);
    result.setHours(original.getHours(), original.getMinutes(), 0, 0);
    return result;
}
function toOccurrence(event, startAt, durationMs, isRecurring) {
    return {
        occurrenceId: `${event.id}:${startAt.toISOString()}`,
        eventId: event.id,
        title: event.title,
        startAt,
        endAt: new Date(startAt.getTime() + durationMs),
        childId: event.childId,
        isRecurring,
    };
}
function fromTs(ts) {
    return new Date(ts.seconds * 1000 + ts.nanoseconds / 1e6);
}
