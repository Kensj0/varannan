"use client";

import { useMemo, useState } from "react";
import { CustodyCycleDoc, ShiftRequestDoc, EventDoc } from "../types/schema";
import { getScheduledParentForDate } from "../lib/custodyCycle";
import { expandEvents, EventOccurrence } from "../lib/recurrence";
import DayActionModal from "./DayActionModal";

interface ParentMeta {
  id: string;
  name: string;
  color: string; // tailwind bg-class, t.ex. "bg-rose-500"
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
}

const WEEKDAY_LABELS = ["M", "T", "O", "T", "F", "L", "S"];

export default function CalendarView({
  monthDate,
  childName,
  cycle,
  parents,
  approvedShiftRequests,
  events,
  onCreateActivity,
  onProposeShift,
}: CalendarViewProps) {
  const [activeDay, setActiveDay] = useState<Date | null>(null);

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

  return (
    <div className="rounded-2xl bg-white shadow-sm">
      <header className="flex items-center justify-between px-5 py-4">
        <h2 className="text-2xl font-bold capitalize text-stone-800">{monthLabel}</h2>
        <span className="text-sm text-stone-400">{childName}s schema</span>
      </header>

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
          const meta = parentFor(day);
          const isToday = isSameDay(day, new Date());
          const dayEvents = eventsByDay.get(dayKey(day)) ?? [];

          return (
            <button
              key={i}
              onClick={() => setActiveDay(day)}
              className={`relative h-24 border border-stone-50 p-1.5 text-left align-top transition hover:bg-stone-50 ${
                isToday ? "ring-2 ring-inset ring-rose-400" : ""
              }`}
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
                className={`absolute inset-x-1 bottom-1.5 truncate rounded-full px-2 py-0.5 text-[10px] font-semibold text-white ${meta.color}`}
              >
                {meta.name}
              </span>
            </button>
          );
        })}
      </div>

      {activeDay && (
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

/** "2026-08-27" — nyckel för att gruppera aktiviteter per dag. */
function dayKey(date: Date): string {
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

function atNoon(date: Date): Date {
  const d = new Date(date);
  d.setHours(12, 0, 0, 0);
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
