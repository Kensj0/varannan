"use client";

import { useMemo, useRef, useState } from "react";
import { CustodyCycleDoc, ShiftRequestDoc, EventDoc } from "../types/schema";
import { getScheduledParentForDate } from "../lib/custodyCycle";
import { expandEvents, EventOccurrence } from "../lib/recurrence";
import { atSwitchHour, addDays } from "../lib/calendarActions";
import DayActionModal from "./DayActionModal";

interface ParentMeta {
  id: string;
  name: string;
  color: string; // tailwind bg-class, t.ex. "bg-rose-500"
}

interface DayChange {
  date: Date;
  takingOverParentId: string;
}

interface CalendarViewProps {
  monthDate: Date; // valfritt datum inom önskad månad
  childId: string;
  childName: string;
  cycle: CustodyCycleDoc;
  parents: [ParentMeta, ParentMeta];
  /** Godkända byten som ska ritas ovanpå den fasta cykeln. */
  approvedShiftRequests: ShiftRequestDoc[];
  /** Aktiviteter som ska visas i dagrutorna. */
  events: EventDoc[];
  currentUserId: string;
  onCreateActivity: (date: Date, title: string, recurring: boolean) => void;
  onProposeShift: (date: Date, takingOverParentId: string) => void;
  /** Skickar flera dagändringar (från ändringsläget) som ETT samlat förslag. */
  onProposeShiftBatch: (changes: DayChange[]) => Promise<void>;
}

const WEEKDAY_LABELS = ["M", "T", "O", "T", "F", "L", "S"];
const LONG_PRESS_MS = 500;
const ONE_MINUTE_MS = 60 * 1000;

export default function CalendarView({
  monthDate,
  childName,
  cycle,
  parents,
  approvedShiftRequests,
  events,
  onCreateActivity,
  onProposeShift,
  onProposeShiftBatch,
}: CalendarViewProps) {
  const [activeDay, setActiveDay] = useState<Date | null>(null);
  const [parentA, parentB] = parents;
  const switchHour = cycle.switchHour;

  // ---- Ändringsläge: håll in en dag för att gå in. "Förskjut" flyttar
  // HELA det synliga schemat (varje dag) ett dygn i taget — inte bara
  // enskilt markerade dagar. Man kan också trycka på enskilda dagar för
  // att rätta dem ytterligare ovanpå förskjutningen. "Skicka förslag"
  // skickar alla dagar som faktiskt ändrats som EN samlad batch. ----
  const [editMode, setEditMode] = useState(false);
  const [shiftOffsetDays, setShiftOffsetDays] = useState(0);
  const [dayOverrides, setDayOverrides] = useState<Map<string, DayChange>>(new Map());
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressFired = useRef(false);

  const weeks = useMemo(() => buildMonthGrid(monthDate), [monthDate]);
  const monthLabel = monthDate.toLocaleDateString("sv-SE", { month: "long", year: "numeric" });

  // Expandera återkommande aktiviteter till konkreta tillfällen och
  // gruppera per dag en gång, istället för att filtrera hela listan i
  // varje dagruta.
  const eventsByDay = useMemo(() => {
    const rangeStart = new Date(monthDate.getFullYear(), monthDate.getMonth() - 1, 1);
    const rangeEnd = new Date(monthDate.getFullYear(), monthDate.getMonth() + 2, 1);
    const occurrences = expandEvents(events, rangeStart, rangeEnd);

    const map = new Map<string, EventOccurrence[]>();
    for (const occurrence of occurrences) {
      const key = dayKey(occurrence.startAt);
      const list = map.get(key);
      if (list) list.push(occurrence);
      else map.set(key, [occurrence]);
    }
    return map;
  }, [events, monthDate]);

  function parentMetaFor(parentId: string): ParentMeta {
    return parents.find((p) => p.id === parentId) ?? parents[0];
  }

  /** Vem som HAR ansvaret vid en given tidpunkt enligt fasta cykeln + godkända byten. */
  function originalParentAt(instant: Date): ParentMeta {
    const override = approvedShiftRequests.find((r) => isInstantWithinShift(instant, r));
    const parentId = override ? override.takingOverParentId : getScheduledParentForDate(cycle, instant).parentId;
    return parentMetaFor(parentId);
  }

  /**
   * Vem som SKA visas vid en given tidpunkt i ändringsläget: en
   * uttrycklig dagrättelse (dayOverrides) vinner, annars den
   * förskjutna versionen av det ursprungliga schemat.
   */
  function previewParentAt(instant: Date): ParentMeta {
    const segDay = segmentDayFor(instant, switchHour);
    const explicit = dayOverrides.get(dayKey(segDay));
    if (explicit) return parentMetaFor(explicit.takingOverParentId);
    return originalParentAt(addDays(instant, -shiftOffsetDays));
  }

  function displayParentAt(instant: Date): ParentMeta {
    return editMode ? previewParentAt(instant) : originalParentAt(instant);
  }

  /** Förälder för dagens EFTERMIDDAG (dagens "segment", från bytestiden och framåt). */
  function afternoonParent(day: Date, preview: boolean): ParentMeta {
    const instant = atSwitchHour(day, switchHour);
    return preview ? previewParentAt(instant) : originalParentAt(instant);
  }

  /** Förälder för dagens MORGON (gårdagens segment, som varar fram till bytestiden). */
  function morningParent(day: Date, preview: boolean): ParentMeta {
    const instant = new Date(atSwitchHour(day, switchHour).getTime() - ONE_MINUTE_MS);
    return preview ? previewParentAt(instant) : originalParentAt(instant);
  }

  function toggleDay(day: Date) {
    const instant = atSwitchHour(day, switchHour);
    const original = originalParentAt(addDays(instant, -shiftOffsetDays)).id;
    const currentPreview = previewParentAt(instant).id;
    const next = currentPreview === parentA.id ? parentB.id : parentA.id;
    const key = dayKey(day);

    setDayOverrides((prev) => {
      const copy = new Map(prev);
      if (next === original) {
        copy.delete(key);
      } else {
        copy.set(key, { date: day, takingOverParentId: next });
      }
      return copy;
    });
  }

  function startLongPress(day: Date) {
    longPressFired.current = false;
    longPressTimer.current = setTimeout(() => {
      longPressFired.current = true;
      setEditMode(true);
      toggleDay(day);
    }, LONG_PRESS_MS);
  }

  function cancelLongPress() {
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
  }

  function handleDayClick(day: Date) {
    if (longPressFired.current) {
      longPressFired.current = false;
      return;
    }
    if (editMode) {
      toggleDay(day);
    } else {
      setActiveDay(day);
    }
  }

  function exitEditMode() {
    setEditMode(false);
    setShiftOffsetDays(0);
    setDayOverrides(new Map());
    setSubmitError(null);
  }

  const visibleDays = useMemo(() => weeks.flat().filter((d): d is Date => d !== null), [weeks]);

  // Vilka dagar som faktiskt skiljer sig från originalschemat just nu
  // (förskjutning + enskilda rättelser tillsammans) — det här är exakt
  // det som skickas när man trycker "Skicka förslag".
  const pendingChangesSummary = useMemo(() => {
    if (!editMode) return [] as DayChange[];
    const changes: DayChange[] = [];
    for (const day of visibleDays) {
      const instant = atSwitchHour(day, switchHour);
      const original = originalParentAt(instant).id;
      const preview = previewParentAt(instant).id;
      if (original !== preview) {
        changes.push({ date: day, takingOverParentId: preview });
      }
    }
    return changes;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editMode, visibleDays, shiftOffsetDays, dayOverrides, switchHour, cycle, approvedShiftRequests]);

  async function submitChanges() {
    setSubmitting(true);
    setSubmitError(null);
    try {
      await onProposeShiftBatch(pendingChangesSummary);
      exitEditMode();
    } catch {
      setSubmitError("Kunde inte skicka förslaget. Försök igen.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="rounded-2xl bg-white shadow-sm">
      <header className="flex items-center justify-between px-5 py-4">
        <h2 className="text-2xl font-bold capitalize text-stone-800">{monthLabel}</h2>
        <span className="text-sm text-stone-400">{childName}s schema</span>
      </header>

      {editMode && (
        <div className="flex items-center justify-between border-t border-rose-100 bg-rose-50 px-5 py-2">
          <p className="text-xs font-semibold text-rose-600">
            Ändringsläge — tryck på dagar för att rätta, eller förskjut hela schemat
          </p>
          <div className="flex items-center gap-1">
            <button
              onClick={() => setShiftOffsetDays((d) => d - 1)}
              aria-label="Förskjut hela schemat en dag bakåt"
              className="rounded-full bg-white px-2 py-1 text-rose-500 shadow-sm"
            >
              ←
            </button>
            <span className="px-1 text-[11px] font-semibold uppercase text-rose-400">
              Förskjut{shiftOffsetDays !== 0 ? ` (${shiftOffsetDays > 0 ? "+" : ""}${shiftOffsetDays})` : ""}
            </span>
            <button
              onClick={() => setShiftOffsetDays((d) => d + 1)}
              aria-label="Förskjut hela schemat en dag framåt"
              className="rounded-full bg-white px-2 py-1 text-rose-500 shadow-sm"
            >
              →
            </button>
          </div>
        </div>
      )}

      <div className="grid grid-cols-7 border-t border-stone-100 text-center text-xs font-medium text-stone-400">
        {WEEKDAY_LABELS.map((d, i) => (
          <div key={i} className="py-2">
            {d}
          </div>
        ))}
      </div>

      <div className="grid grid-cols-7">
        {weeks.flat().map((day, i) => {
          if (!day) return <div key={i} className="h-24 border border-stone-50" />;

          const morning = morningParent(day, editMode);
          const afternoon = afternoonParent(day, editMode);
          const isChanged =
            editMode &&
            (morning.id !== morningParent(day, false).id || afternoon.id !== afternoonParent(day, false).id);
          const isToday = isSameDay(day, new Date());
          const dayEvents = eventsByDay.get(dayKey(day)) ?? [];

          return (
            <button
              key={i}
              onPointerDown={() => startLongPress(day)}
              onPointerUp={cancelLongPress}
              onPointerLeave={cancelLongPress}
              onPointerCancel={cancelLongPress}
              onClick={() => handleDayClick(day)}
              className={`relative h-24 overflow-hidden border p-1.5 text-left align-top transition hover:opacity-90 ${
                isChanged ? "border-rose-300 ring-2 ring-inset ring-rose-300" : "border-stone-50"
              } ${isToday && !isChanged ? "ring-2 ring-inset ring-rose-400" : ""}`}
            >
              {/* Halvdags-bakgrund: bytet sker vid switchHour, inte midnatt. */}
              <div className="absolute inset-0 flex flex-col">
                <div className={`${morning.color} opacity-25`} style={{ height: `${switchHourPct(switchHour)}%` }} />
                <div className={`${afternoon.color} flex-1 opacity-25`} />
              </div>

              <span className="relative text-sm font-semibold text-stone-700">{day.getDate()}</span>

              <span className="relative mt-0.5 block space-y-0.5">
                {dayEvents.slice(0, 2).map((occurrence) => (
                  <span
                    key={occurrence.occurrenceId}
                    title={occurrence.title}
                    className="block truncate rounded bg-violet-100 px-1 text-[10px] leading-tight text-violet-800"
                  >
                    {occurrence.isRecurring && <span aria-label="Återkommande">↻ </span>}
                    {occurrence.title}
                  </span>
                ))}
                {dayEvents.length > 2 && (
                  <span className="block px-1 text-[10px] text-stone-400">+{dayEvents.length - 2} till</span>
                )}
              </span>

              <span className="absolute inset-x-1 bottom-1.5 flex gap-0.5">
                <span
                  title={`Morgon (till ${switchHour}): ${morning.name}`}
                  className={`flex-1 truncate rounded-full px-1.5 py-0.5 text-[9px] font-semibold text-white ${morning.color}`}
                >
                  {morning.name}
                </span>
                <span
                  title={`Från ${switchHour}: ${afternoon.name}`}
                  className={`flex-1 truncate rounded-full px-1.5 py-0.5 text-[9px] font-semibold text-white ${afternoon.color}`}
                >
                  {afternoon.name}
                </span>
              </span>
            </button>
          );
        })}
      </div>

      {editMode && (
        <div className="flex items-center gap-2 border-t border-stone-100 px-5 py-3">
          <button onClick={exitEditMode} className="text-sm text-stone-400 hover:text-rose-500">
            Avbryt
          </button>
          <div className="flex-1" />
          {submitError && <p className="text-xs text-rose-600">{submitError}</p>}
          {pendingChangesSummary.length > 0 && (
            <span className="text-xs text-stone-400">{pendingChangesSummary.length} ändrade dagar</span>
          )}
          <button
            disabled={pendingChangesSummary.length === 0 || submitting}
            onClick={submitChanges}
            className="rounded-full bg-rose-500 px-5 py-2 text-sm font-semibold text-white disabled:opacity-40"
          >
            {submitting ? "Skickar…" : "Skicka förslag"}
          </button>
        </div>
      )}

      {activeDay && !editMode && (
        <DayActionModal
          date={activeDay}
          childName={childName}
          otherParent={
            parents.find((p) => p.id !== afternoonParent(activeDay, false).id) ?? parents[1]
          }
          scheduledParent={afternoonParent(activeDay, false)}
          cycle={cycle}
          onClose={() => setActiveDay(null)}
          onCreateActivity={(date, title, recurring) => {
            onCreateActivity(date, title, recurring);
            setActiveDay(null);
          }}
          onProposeShift={(date, takingOverParentId) => {
            onProposeShift(date, takingOverParentId);
            setActiveDay(null);
          }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Hjälpfunktioner
// ---------------------------------------------------------------------------

function buildMonthGrid(monthDate: Date): (Date | null)[][] {
  const year = monthDate.getFullYear();
  const month = monthDate.getMonth();
  const firstOfMonth = new Date(year, month, 1);
  // Måndag = 0 i svensk kalender
  const leadingBlanks = (firstOfMonth.getDay() + 6) % 7;
  const daysInMonth = new Date(year, month + 1, 0).getDate();

  const cells: (Date | null)[] = [
    ...Array(leadingBlanks).fill(null),
    ...Array.from({ length: daysInMonth }, (_, i) => new Date(year, month, i + 1)),
  ];
  while (cells.length % 7 !== 0) cells.push(null);

  const weeks: (Date | null)[][] = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
  return weeks;
}

/** "2026-8-27" — nyckel för att gruppera aktiviteter/ändringar per dag. */
function dayKey(date: Date): string {
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

function isSameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function isInstantWithinShift(instant: Date, request: ShiftRequestDoc): boolean {
  const start = new Date(request.startAt.seconds * 1000);
  const end = request.endAt ? new Date(request.endAt.seconds * 1000) : null;
  if (end) return instant >= start && instant < end;
  return instant >= start;
}

/**
 * Vilken "segment-dag" en tidpunkt hör till: dygnet [switchHour(D),
 * switchHour(D+1)) hör till D. En tidpunkt före dagens switchHour hör
 * alltså till FÖREGÅENDE dags segment.
 */
function segmentDayFor(instant: Date, switchHour: string): Date {
  const midnight = new Date(instant.getFullYear(), instant.getMonth(), instant.getDate());
  const boundary = atSwitchHour(midnight, switchHour);
  return instant < boundary ? addDays(midnight, -1) : midnight;
}

/** Hur stor andel (%) av dygnet som ligger FÖRE bytestiden. */
function switchHourPct(switchHour: string): number {
  const [h, m] = switchHour.split(":").map(Number);
  const minutes = (h ?? 12) * 60 + (m ?? 0);
  return Math.min(100, Math.max(0, (minutes / 1440) * 100));
}
