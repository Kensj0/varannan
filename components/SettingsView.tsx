"use client";

import { useState } from "react";

interface SettingsViewProps {
  displayName: string;
  email: string | null;
  onResetPassword: (email: string) => Promise<void>;
  onSignOut: () => Promise<void>;
}

/**
 * Kontoinställningar — lösenordsåterställning (via mejl, inget
 * omständligt återautentiseringsflöde i appen) och utloggning.
 * Håller sig medvetet minimal; fler kontoinställningar läggs till här
 * vid behov.
 */
export default function SettingsView({ displayName, email, onResetPassword, onSignOut }: SettingsViewProps) {
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleResetPassword() {
    if (!email) return;
    setSending(true);
    setError(null);
    try {
      await onResetPassword(email);
      setSent(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Kunde inte skicka länken.");
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="rounded-2xl bg-white p-4 shadow-sm">
        <p className="text-xs font-semibold uppercase tracking-wide text-stone-400">Konto</p>
        <p className="mt-2 text-sm font-medium text-stone-800">{displayName}</p>
        {email && <p className="text-sm text-stone-500">{email}</p>}
      </div>

      <div className="rounded-2xl bg-white p-4 shadow-sm">
        <p className="text-xs font-semibold uppercase tracking-wide text-stone-400">Lösenord</p>
        <p className="mt-2 text-[13px] leading-snug text-stone-500">
          Vi skickar en länk för att byta lösenord till din mejl.
        </p>
        <button
          onClick={handleResetPassword}
          disabled={sending || !email}
          className="mt-3 w-full rounded-lg bg-stone-50 px-3 py-2 text-sm font-medium text-stone-700 hover:bg-stone-100 disabled:opacity-50"
        >
          {sending ? "Skickar…" : sent ? "Länk skickad ✓" : "Skicka återställningslänk"}
        </button>
        {error && <p className="mt-2 text-[11px] text-rose-600">{error}</p>}
      </div>

      <button
        onClick={onSignOut}
        className="w-full rounded-2xl bg-white px-4 py-3 text-left text-sm font-medium text-rose-500 shadow-sm hover:bg-rose-50"
      >
        Logga ut
      </button>
    </div>
  );
}
