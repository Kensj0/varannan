"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { CustodyCycleDoc, ShiftRequestDoc, EventDoc } from "../types/schema";
import { getScheduledParentForDate } from "../lib/custodyCycle";
import { expandEvents, EventOccurrence } from "../lib/recurrence";
import { atSwitchHour, addDays } from "../lib/calendarActions";
import { PushPermissionState } from "../lib/pushNotifications";
import DayActionModal from "./DayActionModal";
import CalendarSettingsPanel from "./CalendarSettingsPanel";

interface ParentMeta {
  id: string;
  name: string;
  color: string; // tailwind bg-class, t.ex. "bg-rose-500"
}

interface DayChange {
  date: Date;
  takingOverParentId: string;
}

interface ReminderPrefs {
  dayBefore: boolean;
  sameDay: boolean;
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
  /** Push-status/inställningar — visas i inställningspanelen (kugghjulet). */
  pushPermission: PushPermissionState | null;
  onEnablePush: () => void;
  reminderPrefs: ReminderPrefs;
  onUpdateReminderPrefs: (prefs: ReminderPrefs) => void;
}

const WEEKDAY_LABELS = ["M", "T", "O", "T", "F", "L", "S"];
const LONG_PRESS_MS = 500;
const ONE_MINUTE_MS = 60 * 1000;
const SHOW_WEEK_NUMBERS_KEY = "varannan:showWeekNumbers";

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
  pushPermission,
  onEnablePush,
  reminderPrefs,
  onUpdateReminderPrefs,
}: CalendarViewProps) {
  const [activeDay, setActiveDay] = useState<Date | null>(null);
  const [parentA, parentB] = parents;
  const switchHour = cycle.switchHour;

  // Veckonummer-kolumnen är en ren visningsinställning, sparas lokalt
  // (påverkar ingen annan användare) — läses från localStorage vid
  // första render, med "visa" som default.
  const [showWeekNumbers, setShowWeekNumbers] = useState(true);
  useEffect(() => {
    const stored = typeof window !== "undefined" ? window.localStorage.getItem(SHOW_WEEK_NUMBERS_KEY) : null;
    if (stored !== null) setShowWeekNumbers(stored === "1");
  }, []);
  function toggleShowWeekNumbers(value: boolean) {
    setShowWeekNumbers(value);
    if (typeof window !== "undefined") window.localStorage.setItem(SHOW_WEEK_NUMBERS_KEY, value ? "1" : "0");
  }

  const [settingsOpen, setSettingsOpen] = useState(false);

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

  const weeks = useMemo(() => buildWeekRows(monthDate), [monthDate]);
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

  const visibleDays = useMemo(() => weeks.flat(), [weeks]);

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

  const today = new Date();
  const gridTemplate = showWeekNumbers ? "28px repeat(7, 1fr)" : "repeat(7, 1fr)";

  return (
    <div className="rounded-2xl bg-white shadow-sm">
      <header className="relative flex items-center justify-between px-4 py-3">
        <button
          onClick={() => setEditMode(true)}
          aria-label="Gå in i ändringsläge"
          className="grid h-8 w-8 place-items-center rounded-full text-stone-400 hover:bg-stone-50 hover:text-rose-500"
        >
          <EditCalendarIcon />
        </button>

        <div className="text-center">
          <h2 className="text-lg font-bold capitalize leading-tight text-stone-800">{monthLabel}</h2>
          <span className="text-xs text-stone-400">{childName}s schema</span>
        </div>

        <button
          onClick={() => setSettingsOpen((v) => !v)}
          aria-label="Kalenderinställningar"
          className="grid h-8 w-8 place-items-center rounded-full text-stone-400 hover:bg-stone-50 hover:text-rose-500"
        >
          <SettingsIcon />
        </button>

        {settingsOpen && (
          <CalendarSettingsPanel
            onClose={() => setSettingsOpen(false)}
            showWeekNumbers={showWeekNumbers}
            onToggleShowWeekNumbers={toggleShowWeekNumbers}
            onEnterEditMode={() => setEditMode(true)}
            pushPermission={pushPermission}
            onEnablePush={onEnablePush}
            reminderPrefs={reminderPrefs}
            onUpdateReminderPrefs={onUpdateReminderPrefs}
          />
        )}
      </header>

      {editMode && (
        <div className="flex items-center justify-between border-t border-rose-100 bg-rose-50 px-4 py-2">
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

      <div
        className="grid border-t border-stone-100 text-center text-xs font-medium text-stone-400"
        style={{ gridTemplateColumns: gridTemplate }}
      >
        {showWeekNumbers && (
          <div className="py-2 text-[10px] uppercase text-stone-300" aria-label="Vecka">
            V.
          </div>
        )}
        {WEEKDAY_LABELS.map((d, i) => (
          <div key={i} className="py-2">
            {d}
          </div>
        ))}
      </div>

      <div className="pb-1">
        {weeks.map((week, wIdx) => {
          const dayInfos: DayInfo[] = week.map((day) => {
            const morning = morningParent(day, editMode);
            const afternoon = afternoonParent(day, editMode);
            const type: DaySegmentType = morning.id === afternoon.id ? "block" : "handover";
            const isChanged =
              editMode &&
              (morning.id !== morningParent(day, false).id || afternoon.id !== afternoonParent(day, false).id);
            return {
              date: day,
              type,
              parent: afternoon,
              isChanged,
              isToday: isSameDay(day, today),
              inMonth: day.getMonth() === monthDate.getMonth(),
              events: eventsByDay.get(dayKey(day)) ?? [],
            };
          });

          const segments = computeBlockSegments(dayInfos);
          const dayColumnOffset = showWeekNumbers ? 2 : 1;

          return (
            <div key={wIdx} className="relative grid" style={{ gridTemplateColumns: gridTemplate }}>
              {showWeekNumbers && (
                <div className="flex items-center justify-center text-[11px] font-medium text-stone-300">
                  {getISOWeek(week[0])}
                </div>
              )}

              {dayInfos.map((info, i) => (
                <button
                  key={i}
                  onPointerDown={() => startLongPress(info.date)}
                  onPointerUp={cancelLongPress}
                  onPointerLeave={cancelLongPress}
                  onPointerCancel={cancelLongPress}
                  onClick={() => handleDayClick(info.date)}
                  className={dayButtonClasses(info, segments, i)}
                >
                  <span
                    className={`relative text-[10px] font-semibold ${
                      info.type === "block" ? "text-white/85" : "text-stone-400"
                    } ${!info.inMonth ? "opacity-40" : ""}`}
                  >
                    {info.date.getDate()}
                  </span>

                  {info.type === "handover" && (
                    <span className="relative mt-2 block text-center text-[11px] font-semibold text-stone-400">
                      {formatSwitchHourShort(switchHour)}
                    </span>
                  )}

                  {info.events.length > 0 && (
                    <span
                      title={info.events.map((e) => e.title).join(", ")}
                      className="absolute inset-x-0.5 bottom-0.5 truncate rounded bg-amber-300 px-1 text-center text-[9px] font-semibold leading-4 text-amber-900"
                    >
                      {info.events[0].title}
                      {info.events.length > 1 ? ` +${info.events.length - 1}` : ""}
                    </span>
                  )}
                </button>
              ))}

              {/* Namnetiketten för ett block ritas EN gång, centrerad över hela
                  det sammanslagna färgade intervallet, i ett overlay-lager ovanpå
                  dagknapparna (pointer-events-none så klick går igenom till dem). */}
              <div className="pointer-events-none absolute inset-0 grid" style={{ gridTemplateColumns: gridTemplate }}>
                {segments.map((seg, si) => (
                  <div
                    key={si}
                    className="flex items-center justify-center px-1"
                    style={{ gridColumn: `${dayColumnOffset + seg.startIndex} / span ${seg.length}` }}
                  >
                    <span className="truncate text-[11px] font-semibold text-white">{seg.parentName}</span>
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>

      {editMode && (
        <div className="flex items-center gap-2 border-t border-stone-100 px-4 py-3">
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

type DaySegmentType = "handover" | "block";

interface DayInfo {
  date: Date;
  type: DaySegmentType;
  /** Block: förälder som har hela dagen. Handover: förälder som TAR ÖVER. */
  parent: ParentMeta;
  isChanged: boolean;
  isToday: boolean;
  inMonth: boolean;
  events: EventOccurrence[];
}

interface BlockSegment {
  startIndex: number;
  length: number;
  parentId: string;
  parentName: string;
}

/**
 * Slår ihop sammanhängande "block"-dagar (samma förälder hela dygnet,
 * inga byten) inom EN veckorad till ett enda sammanhängande intervall,
 * så de kan ritas som en obruten färgad stapel istället för N separata
 * rutor — det är precis det som gör originalappens vy ren och läsbar.
 * Handover-dagar (halva dygnet hos vardera föräldern) bryter alltid
 * en sammanslagning och visas istället som en egen, ofärgad ruta med
 * bytestiden.
 */
function computeBlockSegments(dayInfos: DayInfo[]): BlockSegment[] {
  const segments: BlockSegment[] = [];
  let i = 0;
  while (i < dayInfos.length) {
    if (dayInfos[i].type !== "block") {
      i++;
      continue;
    }
    const parentId = dayInfos[i].parent.id;
    let j = i;
    while (j < dayInfos.length && dayInfos[j].type === "block" && dayInfos[j].parent.id === parentId) j++;
    segments.push({ startIndex: i, length: j - i, parentId, parentName: dayInfos[i].parent.name });
    i = j;
  }
  return segments;
}

function dayButtonClasses(info: DayInfo, segments: BlockSegment[], i: number): string {
  const base = "relative h-14 overflow-hidden p-1 text-left align-top transition hover:opacity-90";
  let bg = "bg-transparent";
  let rounding = "";

  if (info.type === "block") {
    bg = info.parent.color;
    const seg = segments.find((s) => i >= s.startIndex && i < s.startIndex + s.length);
    if (seg) {
      if (i === seg.startIndex) rounding += " rounded-l-lg";
      if (i === seg.startIndex + seg.length - 1) rounding += " rounded-r-lg";
    }
  }

  const ring = info.isChanged
    ? " ring-2 ring-inset ring-rose-400"
    : info.isToday
    ? " ring-2 ring-inset ring-stone-800"
    : "";

  return `${base} ${bg}${rounding}${ring}`;
}

/** Måndag-baserade, sammanhängande veckorader från månaden före till efter, så vyn
 *  aldrig visar tomma rutor (matchar originalappens obrutna veckoscroll). */
function buildWeekRows(monthDate: Date): Date[][] {
  const year = monthDate.getFullYear();
  const month = monthDate.getMonth();
  const firstOfMonth = new Date(year, month, 1);
  const lastOfMonth = new Date(year, month + 1, 0);

  const firstMonday = addDays(firstOfMonth, -((firstOfMonth.getDay() + 6) % 7));
  const lastSunday = addDays(lastOfMonth, 6 - ((lastOfMonth.getDay() + 6) % 7));

  const weeks: Date[][] = [];
  let cursor = firstMonday;
  while (cursor.getTime() <= lastSunday.getTime()) {
    weeks.push(Array.from({ length: 7 }, (_, i) => addDays(cursor, i)));
    cursor = addDays(cursor, 7);
  }
  return weeks;
}

/** ISO-8601 veckonummer (måndag = veckans start, vecka 1 innehåller årets första torsdag). */
function getISOWeek(date: Date): number {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - dayNum + 3);
  const firstThursday = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const firstThursdayDayNum = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstThursdayDayNum + 3);
  return 1 + Math.round((d.getTime() - firstThursday.getTime()) / (7 * 24 * 3600 * 1000));
}

/** "08:00" → "8:00" — matchar hur bytestiden visas i originalappen. */
function formatSwitchHourShort(switchHour: string): string {
  const [h, m] = switchHour.split(":");
  return `${Number(h)}:${m}`;
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

// ---------------------------------------------------------------------------
// Ikoner (inline SVG — inget ikonbibliotek i projektet ännu)
// ---------------------------------------------------------------------------

function EditCalendarIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <rect x="3" y="4" width="18" height="17" rx="2" />
      <path d="M3 9h18" />
      <path d="M16 15.5 18.5 13 20 14.5 17.5 17H16v-1.5Z" fill="currentColor" stroke="none" />
    </svg>
  );
}

function SettingsIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h10M18 18h2" strokeLinecap="round" />
      <circle cx="16" cy="6" r="2" />
      <circle cx="8" cy="12" r="2" />
      <circle cx="16" cy="18" r="2" />
    </svg>
  );
}
