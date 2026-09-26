"use client";

import { useMemo, useState } from "react";
import { useAuth } from "../lib/auth/AuthProvider";
import { MyCalendar, deleteMyAccount } from "../lib/onboardingClient";
import DeleteAccountDialog from "./DeleteAccountDialog";
import {
  useCustodyCycle,
  useEventsForMonth,
  usePackLists,
  useNotes,
  useTodos,
} from "../lib/hooks/useFirestore";
import { getScheduledParentForDate } from "../lib/custodyCycle";
import { expandEvents } from "../lib/recurrence";
import { createEvent, deleteEvent } from "../lib/calendarActions";
import {
  createPackList,
  addPackListItem,
  togglePackListItem,
  removePackListItem,
  markPackListSeen,
  deletePackList,
  createNote,
  updateNote,
  deleteNote,
  createTodo,
  toggleTodo,
  archiveTodo,
} from "../lib/listActions";
import { parentColorHex } from "../types/schema";
import PackListView from "./PackListView";
import NotesView from "./NotesView";
import TodoView from "./TodoView";

const WEEKDAY_LABELS = ["Mån", "Tis", "Ons", "Tors", "Fre", "Lör", "Sön"];
const MONTH_LABELS = [
  "Januari", "Februari", "Mars", "April", "Maj", "Juni",
  "Juli", "Augusti", "September", "Oktober", "November", "December",
];

type Tab = "schema" | "packlistor" | "anteckningar" | "todo";

/**
 * Hemvyn för en anhörig/utomstående UTAN eget "hem-team"
 * (users/{uid}.teamId) — se AuthGate.tsx. Det vanliga app/page.tsx är
 * helt byggt kring EN teamId från userDoc och kan inte återanvändas
 * rakt av: i stället en egen, enklare vy — schema + aktiviteter för en
 * viewer, plus packlistor/anteckningar/todo för en relative (chatt,
 * ställning, barninfo och inställningar är avsiktligt inte med här,
 * se docs/roller-och-medlemskap.md).
 *
 * Skiljer sig från CalendarView (parentens fullständiga vy) genom att
 * ALDRIG anropa useTeam(teamId) — en anhörig får inte läsa teams/
 * {teamId} (bara isTeamMember får det). Föräldrarnas namn kommer i
 * stället från getMyCalendars-callablen (calendar.parentNames), som
 * redan har rättighet att läsa dem server-sidan.
 */
export default function RelativeHome({
  calendars,
  onBack,
}: {
  calendars: MyCalendar[];
  /**
   * Bara satt när RelativeHome visas som ett TILLFÄLLIGT läge inifrån
   * den vanliga appen (se AuthGate.tsx — ett konto kan ha ett eget
   * hem-team OCH vara anhörig på andra familjers kalendrar samtidigt).
   * Utelämnas när det här ÄR hela kontots hem — inget att gå tillbaka
   * till (se "Logga ut" i stället).
   */
  onBack?: () => void;
}) {
  const { user, signOutUser } = useAuth();
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [monthDate, setMonthDate] = useState(() => new Date());
  const [tab, setTab] = useState<Tab>("schema");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);

  const calendar = calendars[Math.min(selectedIndex, calendars.length - 1)];
  const { teamId, childId, childName, role, parentNames } = calendar;
  const canEdit = role === "relative";

  const parentIds = useMemo(() => Object.keys(parentNames), [parentNames]);
  const colorFor = (pid: string) => parentColorHex(undefined, parentIds.indexOf(pid));
  const nameFor = (pid: string) => parentNames[pid] ?? "Okänd";

  const { data: cycle, loading: cycleLoading } = useCustodyCycle(teamId, childId);
  const { data: events } = useEventsForMonth(teamId, monthDate, childId);
  const { data: packLists } = usePackLists(teamId, childId);
  const { data: notes } = useNotes(teamId, childId, false, true);
  const { data: todos } = useTodos(teamId, false, childId, false, true);

  const days = useMemo(() => {
    const year = monthDate.getFullYear();
    const month = monthDate.getMonth();
    const count = new Date(year, month + 1, 0).getDate();
    return Array.from({ length: count }, (_, i) => new Date(year, month, i + 1, 12, 0, 0));
  }, [monthDate]);

  const occurrencesByDay = useMemo(() => {
    if (days.length === 0) return new Map<string, ReturnType<typeof expandEvents>>();
    const rangeStart = new Date(monthDate.getFullYear(), monthDate.getMonth() - 1, 1);
    const rangeEnd = new Date(monthDate.getFullYear(), monthDate.getMonth() + 2, 1);
    const occurrences = expandEvents(events, rangeStart, rangeEnd);
    const map = new Map<string, typeof occurrences>();
    for (const occ of occurrences) {
      const key = occ.startAt.toDateString();
      map.set(key, [...(map.get(key) ?? []), occ]);
    }
    return map;
  }, [events, days, monthDate]);

  return (
    <div className="mx-auto min-h-screen max-w-md bg-stone-50 pb-10">
      {onBack && (
        <button
          onClick={onBack}
          className="mx-4 mt-4 text-xs font-semibold text-stone-400 hover:text-rose-600"
        >
          ← Tillbaka till min egen kalender
        </button>
      )}
      <header className="flex items-center justify-between px-4 pt-4 pb-3">
        <div className="min-w-0">
          <p className="text-[10px] font-semibold uppercase tracking-wide text-stone-400">
            {role === "viewer" ? "Utomstående" : "Anhörig"}
          </p>
          <button
            onClick={() => calendars.length > 1 && setPickerOpen((v) => !v)}
            className="truncate text-lg font-bold text-stone-800"
          >
            {childName} {calendars.length > 1 && "▾"}
          </button>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          {!onBack && (
            <>
              <button onClick={() => signOutUser()} className="text-xs text-stone-400 hover:text-rose-600">
                Logga ut
              </button>
              <button
                onClick={() => setDeleteDialogOpen(true)}
                className="text-[11px] text-stone-300 hover:text-rose-600"
              >
                Radera konto
              </button>
            </>
          )}
        </div>
      </header>

      {deleteDialogOpen && (
        <DeleteAccountDialog
          onClose={() => setDeleteDialogOpen(false)}
          onConfirm={async () => {
            await deleteMyAccount();
            await signOutUser();
          }}
        />
      )}

      {pickerOpen && calendars.length > 1 && (
        <div className="mx-4 mb-3 rounded-xl bg-white p-2 shadow ring-1 ring-stone-100">
          {calendars.map((c, i) => (
            <button
              key={`${c.teamId}:${c.childId}`}
              onClick={() => {
                setSelectedIndex(i);
                setPickerOpen(false);
              }}
              className={`block w-full rounded-lg px-3 py-2 text-left text-sm ${
                i === selectedIndex ? "bg-rose-50 font-semibold text-rose-700" : "text-stone-700 hover:bg-stone-50"
              }`}
            >
              {c.childName}
            </button>
          ))}
        </div>
      )}

      <nav className="mx-4 mb-4 flex gap-1 rounded-full bg-stone-200 p-1 text-xs font-semibold">
        <TabButton label="Schema" active={tab === "schema"} onClick={() => setTab("schema")} />
        {canEdit && (
          <>
            <TabButton label="Packlistor" active={tab === "packlistor"} onClick={() => setTab("packlistor")} />
            <TabButton label="Anteckningar" active={tab === "anteckningar"} onClick={() => setTab("anteckningar")} />
            <TabButton label="Att göra" active={tab === "todo"} onClick={() => setTab("todo")} />
          </>
        )}
      </nav>

      <div className="px-4">
        {tab === "schema" && (
          <>
            <div className="mb-3 flex items-center justify-between">
              <button
                onClick={() => setMonthDate(new Date(monthDate.getFullYear(), monthDate.getMonth() - 1, 1))}
                className="rounded-full px-3 py-1 text-sm text-stone-500 hover:bg-stone-100"
              >
                ← Föreg.
              </button>
              <p className="text-sm font-semibold text-stone-700">
                {MONTH_LABELS[monthDate.getMonth()]} {monthDate.getFullYear()}
              </p>
              <button
                onClick={() => setMonthDate(new Date(monthDate.getFullYear(), monthDate.getMonth() + 1, 1))}
                className="rounded-full px-3 py-1 text-sm text-stone-500 hover:bg-stone-100"
              >
                Nästa →
              </button>
            </div>

            {parentIds.length > 0 && (
              <div className="mb-3 flex gap-3 text-xs text-stone-500">
                {parentIds.map((pid) => (
                  <span key={pid} className="flex items-center gap-1">
                    <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ backgroundColor: colorFor(pid) }} />
                    {nameFor(pid)}
                  </span>
                ))}
              </div>
            )}

            {cycleLoading && <p className="text-sm text-stone-400">Laddar schema…</p>}
            {!cycleLoading && !cycle && (
              <p className="text-sm text-stone-400">Inget grundschema är inställt för den här kalendern än.</p>
            )}

            {cycle && (
              <ul className="space-y-1">
                {days.map((day) => {
                  let segment: ReturnType<typeof getScheduledParentForDate> | null = null;
                  try {
                    segment = getScheduledParentForDate(cycle, day);
                  } catch {
                    segment = null;
                  }
                  const dayOccurrences = occurrencesByDay.get(day.toDateString()) ?? [];
                  return (
                    <li
                      key={day.toISOString()}
                      className="flex items-center gap-2 rounded-lg bg-white px-3 py-2 text-sm ring-1 ring-stone-100"
                    >
                      <span className="w-16 shrink-0 text-stone-400">
                        {WEEKDAY_LABELS[(day.getDay() + 6) % 7]} {day.getDate()}
                      </span>
                      {segment && (
                        <span
                          className="inline-block h-2.5 w-2.5 shrink-0 rounded-full"
                          style={{ backgroundColor: colorFor(segment.parentId) }}
                        />
                      )}
                      <span className="min-w-0 flex-1 truncate text-stone-700">
                        {segment ? nameFor(segment.parentId) : "—"}
                        {dayOccurrences.length > 0 && (
                          <span className="ml-2 text-stone-400">
                            · {dayOccurrences.map((o) => o.title).join(", ")}
                          </span>
                        )}
                      </span>
                      {canEdit &&
                        dayOccurrences
                          .filter((o) => events.find((e) => e.id === o.eventId)?.createdBy === user?.uid)
                          .map((o) => (
                            <button
                              key={o.eventId}
                              onClick={async () => {
                                if (!teamId) return;
                                await deleteEvent({ teamId, eventId: o.eventId });
                              }}
                              aria-label={`Ta bort ${o.title}`}
                              className="shrink-0 text-stone-300 hover:text-rose-600"
                            >
                              ✕
                            </button>
                          ))}
                    </li>
                  );
                })}
              </ul>
            )}

            {canEdit && (
              <AddActivityForm
                onAdd={async (title, date) => {
                  if (!teamId || !childId || !user) return;
                  const startAt = new Date(date);
                  startAt.setHours(13, 0, 0, 0);
                  const endAt = new Date(startAt.getTime() + 60 * 60 * 1000);
                  await createEvent({ teamId, childId, title, startAt, endAt, createdBy: user.uid });
                }}
              />
            )}
          </>
        )}

        {tab === "packlistor" && canEdit && teamId && childId && user && (
          <PackListView
            lists={packLists}
            currentUserId={user.uid}
            parentNames={parentNames}
            childName={childName}
            onCreateList={async (title) => {
              await createPackList({ teamId, childId, title, createdBy: user.uid });
            }}
            onAddItem={async (list, name) => addPackListItem(teamId, list, name)}
            onToggleItem={async (list, itemId) => togglePackListItem(teamId, list, itemId, user.uid)}
            onRemoveItem={async (list, itemId) => removePackListItem(teamId, list, itemId)}
            onMarkSeen={async (listId) => markPackListSeen(teamId, listId, user.uid)}
            onDeleteList={async (listId) => deletePackList(teamId, listId)}
          />
        )}

        {tab === "anteckningar" && canEdit && teamId && childId && user && (
          <NotesView
            notes={notes}
            parentNames={parentNames}
            onCreate={async (title, content) => {
              await createNote({ teamId, childId, title, content, createdBy: user.uid });
            }}
            onUpdate={async (noteId, patch) => updateNote(teamId, noteId, patch)}
            onDelete={async (noteId) => deleteNote(teamId, noteId)}
          />
        )}

        {tab === "todo" && canEdit && teamId && childId && user && (
          <TodoView
            todos={todos}
            currentUserId={user.uid}
            parentNames={parentNames}
            onCreate={async (title) => {
              await createTodo({ teamId, childId, title, createdBy: user.uid });
            }}
            onToggle={async (todo) => toggleTodo(teamId, todo, user.uid)}
            onArchive={async (todoId) => archiveTodo(teamId, todoId)}
          />
        )}
      </div>
    </div>
  );
}

function TabButton({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={`flex-1 rounded-full py-1.5 ${active ? "bg-white text-rose-600 shadow-sm" : "text-stone-500"}`}
    >
      {label}
    </button>
  );
}

function AddActivityForm({ onAdd }: { onAdd: (title: string, date: Date) => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [dateStr, setDateStr] = useState(() => new Date().toISOString().slice(0, 10));
  const [busy, setBusy] = useState(false);

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="mt-3 w-full rounded-full border border-rose-200 py-2 text-sm font-semibold text-rose-600 hover:bg-rose-50"
      >
        + Lägg till aktivitet
      </button>
    );
  }

  return (
    <div className="mt-3 rounded-xl bg-white p-3 ring-1 ring-stone-100">
      <input
        autoFocus
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="Vad ska hända?"
        className="mb-2 w-full rounded-lg border border-stone-200 px-3 py-2 text-sm"
      />
      <input
        type="date"
        value={dateStr}
        onChange={(e) => setDateStr(e.target.value)}
        className="mb-2 w-full rounded-lg border border-stone-200 px-3 py-2 text-sm"
      />
      <div className="flex gap-2">
        <button
          onClick={() => {
            setOpen(false);
            setTitle("");
          }}
          className="flex-1 rounded-full border border-stone-200 py-1.5 text-sm font-semibold text-stone-600"
        >
          Avbryt
        </button>
        <button
          disabled={busy || !title.trim()}
          onClick={async () => {
            setBusy(true);
            try {
              await onAdd(title.trim(), new Date(`${dateStr}T00:00:00`));
              setTitle("");
              setOpen(false);
            } finally {
              setBusy(false);
            }
          }}
          className="flex-1 rounded-full bg-rose-500 py-1.5 text-sm font-semibold text-white disabled:opacity-40"
        >
          {busy ? "Sparar…" : "Spara"}
        </button>
      </div>
    </div>
  );
}
