"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { CustodyCycleDoc, ShiftRequestDoc, EventDoc } from "../types/schema";
import { getScheduledParentForDate } from "../lib/custodyCycle";
import { expandEvents, EventOccurrence } from "../lib/recurrence";
import { atSwitchHour, addDays } from "../lib/calendarActions";
import { PushPermissionState } from "../lib/pushNotifications";
import { ParentColorId } from "../types/schema";
import { CalendarFeedLinks } from "../lib/calendarExport";
import DayActionModal from "./DayActionModal";
import CalendarSettingsPanel from "./CalendarSettingsPanel";

interface ParentMeta {
  id: string;
  name: string;
  color: string; // hex ur PARENT_PALETTE, t.ex. "#D50000"
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
  monthDate: Date;
  childId: string;
  childName: string;
  cycle: CustodyCycleDoc;
  parents: [ParentMeta, ParentMeta];
  approvedShiftRequests: ShiftRequestDoc[];
  events: EventDoc[];
  currentUserId: string;
  onCreateActivity: (date: Date, title: string, recurring: boolean) => void;
  onProposeShift: (date: Date, takingOverParentId: string) => void;
  onProposeShiftBatch: (changes: DayChange[]) => Promise<void>;
  pushPermission: PushPermissionState | null;
  onEnablePush: () => void;
  reminderPrefs: ReminderPrefs;
  onUpdateReminderPrefs: (prefs: ReminderPrefs) => void;
  /** Inloggad förälders valda schemafärg, och den andras (för att blockera dubbletter). */
  myColorId?: ParentColorId;
  onSelectColor: (colorId: ParentColorId) => Promise<void>;
  otherParentColorHex: string;
  feedLinks: CalendarFeedLinks | null;
  onCreateFeed: () => Promise<void>;
  onChangeSwitchHour: (hh: string, mm: string) => Promise<void>;
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
  myColorId,
  onSelectColor,
  otherParentColorHex,
  feedLinks,
  onCreateFeed,
  onChangeSwitchHour,
}: CalendarViewProps) {
  const [activeDay, setActiveDay] = useState<Date | null>(null);
  const [parentA, parentB] = parents;
  const switchHour = cycle.switchHour;

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

  const [editMode, setEditMode] = useState(false);
  const [shiftOffsetDays, setShiftOffsetDays] = useState(0);
  const [dayOverrides, setDayOverrides] = useState<Map<string, DayChange>>(new Map());
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressFired = useRef(false);

  const weeks = useMemo(() => buildWeekRows(monthDate), [monthDate]);
  const monthLabel = monthDate.toLocaleDateString("sv-SE", { month: "long", year: "numeric" });

  const eventsByDay = useMemo(() => {
    const rangeStart = new Date(monthDate.getFullYear(), monthDate.getMonth() - 1, 1);
    const rangeEnd = new Date(monthDate.getFullYear(), monthDate.getMonth() + 2, 1);
    const map = new Map<string, EventOccurrence[]>();
    for (const occurrence of expandEvents(events, rangeStart, rangeEnd)) {
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

  function originalParentAt(instant: Date): ParentMeta {
    const override = approvedShiftRequests.find((r) => isInstantWithinShift(instant, r));
    const parentId = override ? override.takingOverParentId : getScheduledParentForDate(cycle, instant).parentId;
    return parentMetaFor(parentId);
  }

  function previewParentAt(instant: Date): ParentMeta {
    const explicit = dayOverrides.get(dayKey(segmentDayFor(instant, switchHour)));
    if (explicit) return parentMetaFor(explicit.takingOverParentId);
    return originalParentAt(addDays(instant, -shiftOffsetDays));
  }

  /** Förälder för dagens EFTERMIDDAG (från bytestiden och framåt). */
  function afternoonParent(day: Date, preview: boolean): ParentMeta {
    const instant = atSwitchHour(day, switchHour);
    return preview ? previewParentAt(instant) : originalParentAt(instant);
  }

  /** Förälder för dagens MORGON (gårdagens block, fram till bytestiden). */
  function morningParent(day: Date, preview: boolean): ParentMeta {
    const instant = new Date(atSwitchHour(day, switchHour).getTime() - ONE_MINUTE_MS);
    return preview ? previewParentAt(instant) : originalParentAt(instant);
  }

  function toggleDay(day: Date) {
    const instant = atSwitchHour(day, switchHour);
    const original = originalParentAt(addDays(instant, -shiftOffsetDays)).id;
    const next = previewParentAt(instant).id === parentA.id ? parentB.id : parentA.id;
    const key = dayKey(day);
    setDayOverrides((prev) => {
      const copy = new Map(prev);
      if (next === original) copy.delete(key);
      else copy.set(key, { date: day, takingOverParentId: next });
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
    if (editMode) toggleDay(day);
    else setActiveDay(day);
  }

  function exitEditMode() {
    setEditMode(false);
    setShiftOffsetDays(0);
    setDayOverrides(new Map());
    setSubmitError(null);
  }

  const visibleDays = useMemo(() => weeks.flat(), [weeks]);

  const pendingChangesSummary = useMemo(() => {
    if (!editMode) return [] as DayChange[];
    const changes: DayChange[] = [];
    for (const day of visibleDays) {
      const instant = atSwitchHour(day, switchHour);
      const original = originalParentAt(instant).id;
      const preview = previewParentAt(instant).id;
      if (original !== preview) changes.push({ date: day, takingOverParentId: preview });
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
  const dayColOffset = showWeekNumbers ? 2 : 1;
  const gridCols = showWeekNumbers ? "26px repeat(7, minmax(0, 1fr))" : "repeat(7, minmax(0, 1fr))";

  return (
    <div className="overflow-hidden rounded-2xl bg-white shadow-sm">
      <header className="relative flex items-center justify-between px-3 py-3">
        <button
          onClick={() => setEditMode(true)}
          aria-label="Ändringsläge"
          className="grid h-9 w-9 place-items-center rounded-full text-stone-400 hover:bg-stone-50 hover:text-rose-500"
        >
          <EditCalendarIcon />
        </button>
        <div className="text-center">
          <h2 className="text-xl font-bold capitalize leading-tight text-stone-800">{monthLabel}</h2>
          <span className="text-xs text-stone-400">{childName}s schema</span>
        </div>
        <button
          onClick={() => setSettingsOpen((v) => !v)}
          aria-label="Kalenderinställningar"
          className="grid h-9 w-9 place-items-center rounded-full text-stone-400 hover:bg-stone-50 hover:text-rose-500"
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
            myColorId={myColorId}
            onSelectColor={onSelectColor}
            otherParentColorHex={otherParentColorHex}
            feedLinks={feedLinks}
            onCreateFeed={onCreateFeed}
            switchHour={switchHour}
            onChangeSwitchHour={onChangeSwitchHour}
            childName={childName}
            cycle={cycle}
          />
        )}
      </header>

      {editMode && (
        <div className="flex items-center justify-between gap-2 border-y border-rose-100 bg-rose-50 px-3 py-2">
          <p className="text-[11px] font-semibold leading-tight text-rose-600">
            Ändringsläge — tryck på dagar, eller förskjut hela schemat
          </p>
          <div className="flex shrink-0 items-center gap-1">
            <button
              onClick={() => setShiftOffsetDays((d) => d - 1)}
              aria-label="Förskjut bakåt"
              className="rounded-full bg-white px-2 py-0.5 text-rose-500 shadow-sm"
            >
              ←
            </button>
            {shiftOffsetDays !== 0 && (
              <span className="text-[11px] font-bold text-rose-500">
                {shiftOffsetDays > 0 ? "+" : ""}
                {shiftOffsetDays}
              </span>
            )}
            <button
              onClick={() => setShiftOffsetDays((d) => d + 1)}
              aria-label="Förskjut framåt"
              className="rounded-full bg-white px-2 py-0.5 text-rose-500 shadow-sm"
            >
              →
            </button>
          </div>
        </div>
      )}

      {/* Veckodagsrubriker */}
      <div
        className="grid border-y border-stone-100 text-center text-xs font-medium text-stone-400"
        style={{ gridTemplateColumns: gridCols }}
      >
        {showWeekNumbers && <div className="py-1.5 text-[10px] text-stone-300">v.</div>}
        {WEEKDAY_LABELS.map((d, i) => (
          <div key={i} className="py-1.5">
            {d}
          </div>
        ))}
      </div>

      {weeks.map((week, wIdx) => {
        // Vem som har ansvaret varje dag den här veckan, plus om dagen
        // är en bytesdag (morgon och eftermiddag har olika förälder).
        const days: DayInfo[] = week.map((day) => {
          const morning = morningParent(day, editMode);
          const afternoon = afternoonParent(day, editMode);
          return {
            date: day,
            morning,
            afternoon,
            isHandover: morning.id !== afternoon.id,
            isChanged:
              editMode &&
              (morning.id !== morningParent(day, false).id || afternoon.id !== afternoonParent(day, false).id),
            isToday: isSameDay(day, today),
            inMonth: day.getMonth() === monthDate.getMonth(),
            events: eventsByDay.get(dayKey(day)) ?? [],
          };
        });

        const bars = buildBars(days);

        return (
          <div
            key={wIdx}
            className="grid border-b border-stone-100 last:border-b-0"
            style={{
              gridTemplateColumns: gridCols,
              // rad 1: datumsiffror · rad 2: ansvarsstapel · rad 3: aktiviteter
              gridTemplateRows: "18px 22px minmax(46px, auto)",
            }}
          >
            {showWeekNumbers && (
              <div
                className="flex items-start justify-center pt-0.5 text-[10px] font-medium text-stone-300"
                style={{ gridRow: "1 / -1" }}
              >
                {getISOWeek(week[0])}
              </div>
            )}

            {/* Klickytor: en per dag, hela höjden. Ligger underst så att
                staplar/etiketter ovanpå aldrig äter upp trycket. */}
            {days.map((info, i) => (
              <button
                key={`hit-${i}`}
                onPointerDown={() => startLongPress(info.date)}
                onPointerUp={cancelLongPress}
                onPointerLeave={cancelLongPress}
                onPointerCancel={cancelLongPress}
                onClick={() => handleDayClick(info.date)}
                aria-label={info.date.toLocaleDateString("sv-SE", { weekday: "long", day: "numeric", month: "long" })}
                className={`border-l border-stone-100 ${i === 0 ? "border-l-0" : ""} ${
                  info.isToday ? "bg-stone-50" : ""
                }`}
                style={{ gridColumn: dayColOffset + i, gridRow: "1 / -1" }}
              />
            ))}

            {/* Datumsiffror */}
            {days.map((info, i) => (
              <span
                key={`num-${i}`}
                className={`pointer-events-none justify-self-center text-[11px] leading-[18px] ${
                  info.isToday ? "font-bold text-stone-800" : "text-stone-400"
                } ${!info.inMonth ? "opacity-40" : ""}`}
                style={{ gridColumn: dayColOffset + i, gridRow: 1 }}
              >
                {info.date.getDate()}
              </span>
            ))}

            {/* Ansvarsstaplar. Ett eget lager över alla sju dagkolumner, så
                att en stapel kan sluta MITT i en ruta vid ett byte i stället
                för att snappa till kolumnkanterna. */}
            <div
              className="pointer-events-none relative self-center"
              style={{ gridColumn: `${dayColOffset} / -1`, gridRow: 2, height: 20 }}
            >
              {bars.map((bar, bi) => (
                <div
                  key={`bar-${bi}`}
                  className={`absolute inset-y-0 flex items-center justify-center overflow-hidden px-1 ${
                    bar.hasChange ? "ring-2 ring-inset ring-stone-800" : ""
                  }`}
                  style={{
                    background: bar.parent.color,
                    left: `${(bar.from / 7) * 100}%`,
                    width: `${((bar.to - bar.from) / 7) * 100}%`,
                    borderTopLeftRadius: bar.roundedStart ? 6 : 0,
                    borderBottomLeftRadius: bar.roundedStart ? 6 : 0,
                    borderTopRightRadius: bar.roundedEnd ? 6 : 0,
                    borderBottomRightRadius: bar.roundedEnd ? 6 : 0,
                    // 1px luft i varje bytespunkt så att de två halvorna läses
                    // som två block som möts, inte ett enda långt fält.
                    marginLeft: bar.roundedStart ? 1 : 0,
                    marginRight: bar.roundedEnd ? 1 : 0,
                  }}
                >
                  <span className="truncate text-[11px] font-semibold leading-none text-white">
                    {shortName(bar.parent.name)}
                  </span>
                </div>
              ))}
            </div>

            {/* Bytestiden, under stapeln på just bytesdagen. */}
            {days.map((info, i) =>
              info.isHandover ? (
                <span
                  key={`sw-${i}`}
                  className={`pointer-events-none justify-self-center pt-0.5 text-[10px] font-medium leading-4 ${
                    info.isChanged ? "text-rose-600" : "text-stone-400"
                  }`}
                  style={{ gridColumn: dayColOffset + i, gridRow: 3 }}
                >
                  {formatSwitchHourShort(switchHour)}
                </span>
              ) : null
            )}

            {/* Aktiviteter */}
            {days.map((info, i) =>
              info.events.length > 0 ? (
                <div
                  key={`ev-${i}`}
                  className="pointer-events-none z-10 min-w-0 space-y-0.5 self-end px-0.5 pb-0.5"
                  style={{ gridColumn: dayColOffset + i, gridRow: 3 }}
                >
                  {info.events.slice(0, 2).map((ev, ei) => (
                    <div
                      key={ei}
                      className="truncate rounded bg-amber-300 px-1 text-[10px] font-medium leading-4 text-amber-900"
                    >
                      {ev.title}
                    </div>
                  ))}
                  {info.events.length > 2 && (
                    <div className="px-1 text-[9px] font-medium text-stone-400">+{info.events.length - 2}</div>
                  )}
                </div>
              ) : null
            )}
          </div>
        );
      })}

      {editMode && (
        <div className="flex items-center gap-2 border-t border-stone-100 px-3 py-3">
          <button onClick={exitEditMode} className="text-sm text-stone-400 hover:text-rose-500">
            Avbryt
          </button>
          <div className="flex-1" />
          {submitError && <p className="text-xs text-rose-600">{submitError}</p>}
          {pendingChangesSummary.length > 0 && (
            <span className="text-xs text-stone-400">{pendingChangesSummary.length} dagar</span>
          )}
          <button
            disabled={pendingChangesSummary.length === 0 || submitting}
            onClick={submitChanges}
            className="rounded-full bg-rose-500 px-4 py-2 text-sm font-semibold text-white disabled:opacity-40"
          >
            {submitting ? "Skickar…" : "Skicka förslag"}
          </button>
        </div>
      )}

      {activeDay && !editMode && (
        <DayActionModal
          date={activeDay}
          childName={childName}
          otherParent={parents.find((p) => p.id !== afternoonParent(activeDay, false).id) ?? parents[1]}
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

interface DayInfo {
  date: Date;
  morning: ParentMeta;
  afternoon: ParentMeta;
  /** Morgon och eftermiddag hos olika föräldrar → själva överlämningsdagen. */
  isHandover: boolean;
  isChanged: boolean;
  isToday: boolean;
  inMonth: boolean;
  events: EventOccurrence[];
}

interface Bar {
  /** Vänsterkant i dagar från veckans början (0–7). Halvtal = mitt i en bytesdag. */
  from: number;
  /** Högerkant i dagar från veckans början (0–7). */
  to: number;
  parent: ParentMeta;
  /** Blocket börjar här — annars fortsätter det in från förra veckan (rak kant). */
  roundedStart: boolean;
  /** Blocket slutar här — annars fortsätter det in i nästa vecka (rak kant). */
  roundedEnd: boolean;
  hasChange: boolean;
}

/**
 * Delar upp veckan i sammanhängande ansvarsintervall längs en tidslinje där
 * varje dag är 1 enhet bred. En bytesdag delas PÅ MITTEN: den avgående
 * föräldern sträcker sig in till mitten av rutan, den tillträdande tar vid
 * därifrån. Alltså finns inga tomma dagar — varje ruta är alltid täckt, och
 * bytesdagar är halvdag för vardera föräldern från varsitt håll.
 *
 * Exempel (byte kl 8 på onsdag den 9): Livias stapel går från tisdagens
 * början till mitten av onsdagsrutan, och Kennys från mitten av onsdags-
 * rutan vidare fram till nästa byte.
 */
function buildBars(days: DayInfo[]): Bar[] {
  const bars: Bar[] = [];
  if (days.length === 0) return bars;

  let parent = days[0].morning;
  let from = 0;
  let changed = false;

  for (let i = 0; i < days.length; i++) {
    changed = changed || days[i].isChanged;
    if (!days[i].isHandover) continue;

    // Bytet sker mitt i den här rutan: stäng föregående intervall där,
    // och låt den tillträdande föräldern ta vid från samma punkt.
    const boundary = i + 0.5;
    bars.push({
      from,
      to: boundary,
      parent,
      roundedStart: from > 0,
      roundedEnd: true,
      hasChange: changed,
    });
    parent = days[i].afternoon;
    from = boundary;
    changed = days[i].isChanged;
  }

  bars.push({
    from,
    to: days.length,
    parent,
    roundedStart: from > 0,
    roundedEnd: false,
    hasChange: changed,
  });

  return bars;
}

/** "Kenny Sjöstedt" → "Kenny". Staplarna är smala; efternamn får ändå inte plats. */
function shortName(name: string): string {
  const first = name.trim().split(/\s+/)[0] ?? name;
  return first.length > 12 ? `${first.slice(0, 11)}…` : first;
}

function buildWeekRows(monthDate: Date): Date[][] {
  const first = new Date(monthDate.getFullYear(), monthDate.getMonth(), 1);
  const last = new Date(monthDate.getFullYear(), monthDate.getMonth() + 1, 0);
  const firstMonday = addDays(first, -((first.getDay() + 6) % 7));
  const lastSunday = addDays(last, 6 - ((last.getDay() + 6) % 7));

  const weeks: Date[][] = [];
  let cursor = firstMonday;
  while (cursor.getTime() <= lastSunday.getTime()) {
    weeks.push(Array.from({ length: 7 }, (_, i) => addDays(cursor, i)));
    cursor = addDays(cursor, 7);
  }
  return weeks;
}

/** ISO-8601 veckonummer (vecka 1 = veckan med årets första torsdag). */
function getISOWeek(date: Date): number {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7) + 3);
  const firstThursday = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  firstThursday.setUTCDate(firstThursday.getUTCDate() - ((firstThursday.getUTCDay() + 6) % 7) + 3);
  return 1 + Math.round((d.getTime() - firstThursday.getTime()) / (7 * 24 * 3600 * 1000));
}

/** "08:00" → "8:00", som i originalappen. */
function formatSwitchHourShort(switchHour: string): string {
  const [h, m] = switchHour.split(":");
  return `${Number(h)}:${m}`;
}

function dayKey(date: Date): string {
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

function isSameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function isInstantWithinShift(instant: Date, request: ShiftRequestDoc): boolean {
  const start = new Date(request.startAt.seconds * 1000);
  const end = request.endAt ? new Date(request.endAt.seconds * 1000) : null;
  return end ? instant >= start && instant < end : instant >= start;
}

/** Dygnet [switchHour(D), switchHour(D+1)) hör till dag D. */
function segmentDayFor(instant: Date, switchHour: string): Date {
  const midnight = new Date(instant.getFullYear(), instant.getMonth(), instant.getDate());
  return instant < atSwitchHour(midnight, switchHour) ? addDays(midnight, -1) : midnight;
}

// ---------------------------------------------------------------------------
// Ikoner
// ---------------------------------------------------------------------------

function EditCalendarIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <rect x="3" y="4" width="18" height="17" rx="2" />
      <path d="M3 9h18" />
      <path d="m15.5 17.5 3-3 1.5 1.5-3 3h-1.5v-1.5Z" fill="currentColor" stroke="none" />
    </svg>
  );
}

function SettingsIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M4 7h9M17 7h3M4 12h3M11 12h9M4 17h9M17 17h3" strokeLinecap="round" />
      <circle cx="15" cy="7" r="2" />
      <circle cx="9" cy="12" r="2" />
      <circle cx="15" cy="17" r="2" />
    </svg>
  );
}
