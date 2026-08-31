"use client";

import { useMemo, useRef, useState } from "react";
import { CustodyCycleDoc, ShiftRequestDoc, EventDoc } from "../types/schema";
import { getScheduledParentForDate } from "../lib/custodyCycle";
import { expandEvents, EventOccurrence } from "../lib/recurrence";
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

  // ---- Ändringsläge: håll in en dag för att gå in, tryck fler dagar för
  // att måla om dem, "förskjut" flyttar hela urvalet en dag, "Skicka
  // förslag" skickar allt som EN batch-förfrågan till andra föräldern. ----
  const [editMode, setEditMode] = useState(false);
  const [pendingChanges, setPendingChanges] = useState<Map<string, DayChange>>(new Map());
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

  function parentFor(day: Date): ParentMeta {
    // Godkända shiftRequests trumfar den fasta cykeln för de dagar de täcker.
    const override = approvedShiftRequests.find((r) => isDateWithinShift(day, r));
    const parentId = override ? override.takingOverParentId : getScheduledParentForDate(cycle, atNoon(day)).parentId;
    return parents.find((p) => p.id === parentId) ?? parents[0];
  }

  function displayParentFor(day: Date): ParentMeta {
    const pending = pendingChanges.get(dayKey(day));
    if (!pending) return parentFor(day);
    return parents.find((p) => p.id === pending.takingOverParentId) ?? parents[0];
  }

  function toggleDay(day: Date) {
    const key = dayKey(day);
    const original = parentFor(day).id;
    const current = pendingChanges.get(key)?.takingOverParentId ?? original;
    const next = current === parentA.id ? parentB.id : parentA.id;

    setPendingChanges((prev) => {
      const copy = new Map(prev);
      if (next === original) {
        // Tillbaka till hur det redan var — inget att skicka för den dagen.
        copy.delete(key);
      } else {
        copy.set(key, { date: day, takingOverParentId: next });
      }
      return copy;
    });
  }

  function shiftPendingChanges(direction: -1 | 1) {
    setPendingChanges((prev) => {
      const next = new Map<string, DayChange>();
      for (const change of prev.values()) {
        const shifted = addDays(change.date, direction);
        next.set(dayKey(shifted), { date: shifted, takingOverParentId: change.takingOverParentId });
      }
      return next;
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
      // Långtrycket redan hanterade den här interaktionen.
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
    setPendingChanges(new Map());
    setSubmitError(null);
  }

  async function submitChanges() {
    setSubmitting(true);
    setSubmitError(null);
    try {
      await onProposeShiftBatch(Array.from(pendingChanges.values()));
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
            Ändringsläge — tryck på dagar för att byta förälder
          </p>
          <div className="flex items-center gap-1">
            <button
              onClick={() => shiftPendingChanges(-1)}
              disabled={pendingChanges.size === 0}
              aria-label="Förskjut en dag bakåt"
              className="rounded-full bg-white px-2 py-1 text-rose-500 shadow-sm disabled:opacity-30"
            >
              ←
            </button>
            <span className="px-1 text-[11px] font-semibold uppercase text-rose-400">Förskjut</span>
            <button
              onClick={() => shiftPendingChanges(1)}
              disabled={pendingChanges.size === 0}
              aria-label="Förskjut en dag framåt"
              className="rounded-full bg-white px-2 py-1 text-rose-500 shadow-sm disabled:opacity-30"
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
          const meta = displayParentFor(day);
          const isPending = pendingChanges.has(dayKey(day));
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
              className={`relative h-24 border p-1.5 text-left align-top transition hover:bg-stone-50 ${
                isPending ? "border-rose-300 ring-2 ring-inset ring-rose-300" : "border-stone-50"
              } ${isToday && !isPending ? "ring-2 ring-inset ring-rose-400" : ""}`}
            >
              <span className="text-sm font-semibold text-stone-700">{day.getDate()}</span>

              <span className="mt-0.5 block space-y-0.5">
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

              <span
                className={`absolute inset-x-1 bottom-1.5 truncate rounded-full px-2 py-0.5 text-[10px] font-semibold text-white ${meta.color} ${
                  isPending ? "outline outline-2 outline-white" : ""
                }`}
              >
                {meta.name}
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
          <button
            disabled={pendingChanges.size === 0 || submitting}
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
          otherParent={parents.find((p) => p.id !== parentFor(activeDay).id) ?? parents[1]}
          scheduledParent={parentFor(activeDay)}
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

function atNoon(date: Date): Date {
  const d = new Date(date);
  d.setHours(12, 0, 0, 0);
  return d;
}

function addDays(date: Date, days: number): Date {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

function isSameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function isDateWithinShift(day: Date, request: ShiftRequestDoc): boolean {
  const start = new Date(request.startAt.seconds * 1000);
  const end = request.endAt ? new Date(request.endAt.seconds * 1000) : null;
  const noon = atNoon(day);
  if (end) return noon >= start && noon < end;
  return noon >= start; // öppen tills nästa ordinarie byte hanteras vid render av override-listan
}
