"use client";

import { useState } from "react";

interface DeleteAccountDialogProps {
  onClose: () => void;
  onConfirm: () => Promise<void>;
}

const CONFIRM_WORD = "RADERA";

/**
 * Varnar för vad permanent kontoradering innebär och kräver att man
 * skriver "RADERA" innan knappen ens går att trycka på — samma
 * mönster som andra oåterkalleliga åtgärder i appen (se
 * CalendarManagerPanel), fast med textbekräftelse istället för bara
 * en andra knapptryckning, eftersom det här är permanent på ett sätt
 * som "ta bort en kalender" inte är (går inte att ångra genom att
 * bjuda in sig själv igen).
 */
export default function DeleteAccountDialog({ onClose, onConfirm }: DeleteAccountDialogProps) {
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const matches = input.trim() === CONFIRM_WORD;

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 sm:items-center">
      <div className="w-full max-w-sm rounded-t-2xl bg-white p-5 sm:rounded-2xl">
        <h2 className="text-lg font-bold text-stone-800">Radera kontot permanent?</h2>
        <div className="mt-2 space-y-2 text-sm leading-snug text-stone-600">
          <p>Det går inte att ångra. Det här händer:</p>
          <ul className="list-disc space-y-1 pl-5">
            <li>Delar du en kalender med en annan förälder finns den kvar hos hen — du bara försvinner från den.</li>
            <li>
              Är du ENSAM förälder på en kalender raderas den helt: schema, ställning, barninfo, chatt och listor.
            </li>
            <li>Är du anhörig/utomstående på andras kalendrar tas du bort från dem.</li>
            <li>Ditt konto och all din inloggningsinformation raderas.</li>
          </ul>
        </div>

        <label className="mt-4 block text-xs font-semibold uppercase tracking-wide text-stone-400">
          Skriv RADERA för att bekräfta
        </label>
        <input
          autoFocus
          value={input}
          onChange={(e) => {
            setInput(e.target.value);
            setError(null);
          }}
          placeholder="RADERA"
          disabled={busy}
          className="mt-1 w-full rounded-lg border border-stone-200 px-3 py-2 text-sm outline-none focus:border-rose-400 disabled:opacity-50"
        />

        {error && <p className="mt-2 text-sm text-rose-600">{error}</p>}

        <div className="mt-4 flex gap-2">
          <button
            onClick={onClose}
            disabled={busy}
            className="flex-1 rounded-full border border-stone-200 py-2.5 text-sm font-semibold text-stone-600 disabled:opacity-50"
          >
            Avbryt
          </button>
          <button
            disabled={!matches || busy}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                await onConfirm();
              } catch (err: any) {
                setError(err?.message || "Kunde inte radera kontot. Försök igen.");
                setBusy(false);
              }
            }}
            className="flex-1 rounded-full bg-rose-600 py-2.5 text-sm font-semibold text-white disabled:opacity-40"
          >
            {busy ? "Raderar…" : "Radera konto"}
          </button>
        </div>
      </div>
    </div>
  );
}
