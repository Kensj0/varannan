"use client";

import { useState } from "react";

interface AddFirstChildScreenProps {
  onAddChild: (name: string, birthYear?: number) => Promise<void>;
  onSignOut: () => void;
}

/** Visas om familjen finns men inget barn hunnit läggas till. */
export default function AddFirstChildScreen({ onAddChild, onSignOut }: AddFirstChildScreenProps) {
  const [name, setName] = useState("");
  const [birthYear, setBirthYear] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center px-6">
      <h1 className="mb-2 text-2xl font-bold text-stone-800">Lägg till ert barn</h1>
      <p className="mb-6 text-stone-500">Varje barn får sitt eget schema och sin egen information.</p>
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Barnets namn"
        className="mb-3 w-full rounded-lg bg-stone-100 px-4 py-3 outline-none focus:ring-2 focus:ring-rose-400"
      />
      <input
        value={birthYear}
        onChange={(e) => setBirthYear(e.target.value.replace(/[^0-9]/g, "").slice(0, 4))}
        placeholder="Födelseår (valfritt)"
        inputMode="numeric"
        className="mb-6 w-full rounded-lg bg-stone-100 px-4 py-3 outline-none focus:ring-2 focus:ring-rose-400"
      />
      {error && <p className="mb-3 text-sm text-rose-600">{error}</p>}
      <button
        disabled={!name.trim() || busy}
        onClick={async () => {
          setBusy(true);
          setError(null);
          try {
            await onAddChild(name.trim(), birthYear ? Number(birthYear) : undefined);
          } catch {
            setError("Kunde inte spara. Försök igen.");
            setBusy(false);
          }
        }}
        className="mb-4 w-full rounded-full bg-rose-500 py-3 font-semibold text-white disabled:opacity-40"
      >
        {busy ? "Sparar…" : "Spara"}
      </button>
      <button onClick={onSignOut} className="text-sm text-stone-400 hover:text-rose-500">
        Logga ut
      </button>
    </main>
  );
}
