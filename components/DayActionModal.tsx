"use client";

import { useState } from "react";
import { CustodyCycleDoc } from "../types/schema";
import { getNextOrdinaryHandoff } from "../lib/custodyCycle";
import { EventOccurrence } from "../lib/recurrence";

interface ParentMeta {
  id: string;
  name: string;
  color: string;
}

/** "bara det här tillfället" eller "hela serien". */
export type DeleteActivityScope = "occurrence" | "series";

interface DayActionModalProps {
  date: Date;
  childName: string;
  scheduledParent: ParentMeta;
  otherParent: ParentMeta;
  cycle: CustodyCycleDoc;
  /** Dagens aktiviteter, så de kan tas bort härifrån. */
  events: EventOccurrence[];
  onClose: () => void;
  onCreateActivity: (date: Date, title: string, recurring: boolean) => void;
  onDeleteActivity: (occurrence: EventOccurrence, scope: DeleteActivityScope) => void;
  onProposeShift: (date: Date, takingOverParentId: string) => void;
}

type ModalStep = "choose" | "activity" | "shift";

/**
 * Motsvarar bild 9 (val: Aktivitet / Ändra ansvar) och bild 4
 * ("X tar ansvaret för barnet ... FÖRESLÅ").
 */
export default function DayActionModal({
  date,
  childName,
  scheduledParent,
  otherParent,
  cycle,
  events,
  onClose,
  onCreateActivity,
  onDeleteActivity,
  onProposeShift,
}: DayActionModalProps) {
  const [step, setStep] = useState<ModalStep>("choose");
  /** Aktiviteten användaren vill ta bort — null när inget är på gång. */
  const [deleting, setDeleting] = useState<EventOccurrence | null>(null);

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 sm:items-center" onClick={onClose}>
      <div
        className="w-full max-w-sm rounded-t-3xl bg-white p-6 shadow-xl sm:rounded-3xl"
        onClick={(e) => e.stopPropagation()}
      >
        {deleting ? (
          <DeleteActivityStep
            occurrence={deleting}
            onCancel={() => setDeleting(null)}
            onConfirm={(scope) => {
              onDeleteActivity(deleting, scope);
              setDeleting(null);
            }}
          />
        ) : (
          <>
            {step === "choose" && (
              <ChooseStep
                date={date}
                events={events}
                onPickActivity={() => setStep("activity")}
                onPickShift={() => setStep("shift")}
                onDeleteActivity={setDeleting}
                onClose={onClose}
              />
            )}

            {step === "activity" && (
              <ActivityStep
                date={date}
                onCancel={() => setStep("choose")}
                onSave={(d, title, recurring) => onCreateActivity(d, title, recurring)}
              />
            )}

            {step === "shift" && (
              <ShiftStep
                date={date}
                childName={childName}
                currentParent={scheduledParent}
                takingOverParent={otherParent}
                cycle={cycle}
                onCancel={() => setStep("choose")}
                onPropose={(d) => onProposeShift(d, otherParent.id)}
              />
            )}
          </>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Steg 1: välj Aktivitet eller Ändra ansvar
// ---------------------------------------------------------------------------

function ChooseStep({
  date,
  events,
  onPickActivity,
  onPickShift,
  onDeleteActivity,
  onClose,
}: {
  date: Date;
  events: EventOccurrence[];
  onPickActivity: () => void;
  onPickShift: () => void;
  onDeleteActivity: (occurrence: EventOccurrence) => void;
  onClose: () => void;
}) {
  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <h3 className="text-lg font-bold text-stone-800">{formatDate(date)}</h3>
        <button onClick={onClose} className="text-stone-400" aria-label="Stäng">
          ✕
        </button>
      </div>

      {events.length > 0 && (
        <div className="mb-3 space-y-1">
          {events.map((ev) => (
            <div
              key={ev.occurrenceId}
              className="flex items-center gap-2 rounded-lg bg-amber-100 px-3 py-2"
            >
              <span className="min-w-0 flex-1 truncate text-sm font-medium text-amber-900">{ev.title}</span>
              <button
                onClick={() => onDeleteActivity(ev)}
                className="shrink-0 text-amber-700 hover:text-rose-600"
                aria-label={`Ta bort ${ev.title}`}
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      )}

      <button
        onClick={onPickActivity}
        className="mb-2 flex w-full items-center gap-3 rounded-xl bg-rose-50 px-4 py-3 text-left font-semibold text-rose-600 hover:bg-rose-100"
      >
        <span className="grid h-8 w-8 place-items-center rounded-full bg-rose-500 text-white">+</span>
        Aktivitet
      </button>
      <button
        onClick={onPickShift}
        className="flex w-full items-center gap-3 rounded-xl bg-amber-50 px-4 py-3 text-left font-semibold text-amber-700 hover:bg-amber-100"
      >
        <span className="grid h-8 w-8 place-items-center rounded-full bg-amber-400 text-white">⇄</span>
        Ändra ansvar
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Ta bort aktivitet
// ---------------------------------------------------------------------------

/**
 * En engångsaktivitet tas bort direkt. En återkommande måste först
 * besvara frågan om det gäller det här tillfället eller hela serien —
 * de två är olika operationer (undantag respektive radering).
 */
function DeleteActivityStep({
  occurrence,
  onCancel,
  onConfirm,
}: {
  occurrence: EventOccurrence;
  onCancel: () => void;
  onConfirm: (scope: DeleteActivityScope) => void;
}) {
  const recurring = occurrence.hasRecurrence;

  return (
    <div>
      <h3 className="mb-1 text-lg font-bold text-stone-800">Ta bort aktivitet</h3>
      <p className="mb-5 text-sm text-stone-500">
        {occurrence.title} · {formatDate(occurrence.startAt)}
      </p>

      {recurring ? (
        <div className="mb-5 space-y-2">
          <button
            onClick={() => onConfirm("occurrence")}
            className="w-full rounded-xl bg-stone-100 px-4 py-3 text-left font-semibold text-stone-700 hover:bg-stone-200"
          >
            Bara den här gången
          </button>
          <button
            onClick={() => onConfirm("series")}
            className="w-full rounded-xl bg-rose-50 px-4 py-3 text-left font-semibold text-rose-600 hover:bg-rose-100"
          >
            Alla tillfällen
          </button>
        </div>
      ) : (
        <button
          onClick={() => onConfirm("series")}
          className="mb-5 w-full rounded-full bg-rose-500 py-3 font-semibold text-white"
        >
          Ta bort
        </button>
      )}

      <button onClick={onCancel} className="w-full py-1 text-sm font-semibold text-stone-500">
        Avbryt
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Steg 2a: skapa aktivitet
// ---------------------------------------------------------------------------

function ActivityStep({
  date,
  onCancel,
  onSave,
}: {
  date: Date;
  onCancel: () => void;
  onSave: (date: Date, title: string, recurring: boolean) => void;
}) {
  const [title, setTitle] = useState("");
  const [recurring, setRecurring] = useState(false);

  return (
    <div>
      <h3 className="mb-4 text-lg font-bold text-stone-800">Ny aktivitet</h3>
      <input
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="Titel"
        className="mb-3 w-full rounded-lg bg-stone-100 px-4 py-3 text-stone-800 outline-none focus:ring-2 focus:ring-rose-400"
      />
      <p className="mb-3 text-sm text-stone-500">{formatDate(date)}</p>
      <label className="mb-5 flex items-center gap-2 text-sm text-stone-600">
        <input type="checkbox" checked={recurring} onChange={(e) => setRecurring(e.target.checked)} />
        Återkommande
      </label>
      <div className="flex gap-3">
        <button onClick={onCancel} className="flex-1 rounded-full border border-stone-300 py-3 font-semibold text-stone-600">
          Avbryt
        </button>
        <button
          disabled={!title.trim()}
          onClick={() => onSave(date, title.trim(), recurring)}
          className="flex-1 rounded-full bg-rose-500 py-3 font-semibold text-white disabled:opacity-40"
        >
          Spara
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Steg 2b: föreslå ansvarsbyte
// ---------------------------------------------------------------------------

function ShiftStep({
  date,
  childName,
  currentParent,
  takingOverParent,
  cycle,
  onCancel,
  onPropose,
}: {
  date: Date;
  childName: string;
  currentParent: ParentMeta;
  takingOverParent: ParentMeta;
  cycle: CustodyCycleDoc;
  onCancel: () => void;
  onPropose: (date: Date) => void;
}) {
  const nextHandoff = getNextOrdinaryHandoff(cycle, date);

  return (
    <div>
      <h3 className="mb-1 text-center text-xl font-bold text-stone-800">
        {takingOverParent.name} tar ansvaret
      </h3>
      <p className="mb-5 text-center text-stone-500">för {childName}</p>

      <div className="mb-4 rounded-xl bg-stone-50 px-4 py-3">
        <p className="text-xs font-semibold uppercase text-stone-400">Start</p>
        <p className="font-medium text-stone-800">{formatDate(date)}, {formatTime(date)}</p>
      </div>

      <p className="mb-4 text-sm italic text-stone-500">
        {takingOverParent.name} fortsätter att ha ansvaret fram till bytet den {formatDate(nextHandoff)}
      </p>

      <p className="mb-5 text-xs text-stone-400">
        Just nu enligt schemat: {currentParent.name}. Förslaget skickas till {currentParent.name} för godkännande.
      </p>

      <div className="flex gap-3">
        <button onClick={onCancel} className="flex-1 rounded-full border border-stone-300 py-3 font-semibold text-stone-600">
          Avbryt
        </button>
        <button
          onClick={() => onPropose(date)}
          className="flex-1 rounded-full bg-violet-700 py-3 font-semibold text-white"
        >
          Föreslå
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

function formatDate(d: Date): string {
  return d.toLocaleDateString("sv-SE", { day: "numeric", month: "short", year: "numeric" });
}
function formatTime(d: Date): string {
  return d.toLocaleTimeString("sv-SE", { hour: "2-digit", minute: "2-digit" });
}
