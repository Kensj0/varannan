"use client";

import { useState } from "react";
import type { UserDoc } from "../types/schema";
import {
  startGoogleCalendarConnect,
  disconnectGoogleCalendar,
  syncGoogleCalendarNow,
} from "../lib/googleCalendarClient";

interface GoogleCalendarCardProps {
  status: UserDoc["googleCalendar"];
  /** Resultatet efter att Google skickat tillbaka användaren (?google=…). */
  resultMessage?: { ok: boolean; text: string } | null;
}

/**
 * Frivillig koppling till Google Kalender. Skriver till en egen kalender
 * per Varannan-kalender i användarens Google-konto — rör inget annat.
 * ICS-prenumerationen finns kvar som alternativ utan Google-konto.
 */
export default function GoogleCalendarCard({ status, resultMessage }: GoogleCalendarCardProps) {
  const [busy, setBusy] = useState<"connect" | "sync" | "disconnect" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [synced, setSynced] = useState(false);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);

  const connected = !!status?.connected;
  const lastSynced = status?.lastSyncedAt
    ? new Date(status.lastSyncedAt.seconds * 1000).toLocaleString("sv-SE", {
        day: "numeric",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
      })
    : null;

  async function run(kind: "connect" | "sync" | "disconnect", fn: () => Promise<void>) {
    setBusy(kind);
    setError(null);
    setSynced(false);
    try {
      await fn();
      if (kind === "sync") setSynced(true);
      if (kind === "disconnect") setConfirmDisconnect(false);
    } catch (err: any) {
      setError(err?.message ?? "Något gick fel. Försök igen.");
    } finally {
      // "connect" lämnar sidan (till Google) — återställ bara vid fel.
      setBusy(null);
    }
  }

  return (
    <div className="rounded-2xl bg-white p-4 shadow-sm">
      <p className="text-xs font-semibold uppercase tracking-wide text-stone-400">Google Kalender</p>

      {resultMessage && (
        <p
          className={`mt-2 rounded-lg px-3 py-2 text-[13px] leading-snug ${
            resultMessage.ok ? "bg-emerald-50 text-emerald-800" : "bg-rose-50 text-rose-700"
          }`}
        >
          {resultMessage.text}
        </p>
      )}

      {!connected ? (
        <>
          <p className="mt-2 text-[13px] leading-snug text-stone-500">
            Koppla ditt Google-konto så läggs schemat och aktiviteterna in i en egen kalender i
            Google Kalender, i varje förälders färg. Ändringar i Varannan följer med automatiskt. Vi
            rör inte dina andra kalendrar.
          </p>
          {status?.lastError && <p className="mt-2 text-[11px] text-rose-600">{status.lastError}</p>}
          <button
            onClick={() => run("connect", startGoogleCalendarConnect)}
            disabled={busy !== null}
            className="mt-3 w-full rounded-lg bg-stone-50 px-3 py-2 text-sm font-medium text-stone-700 hover:bg-stone-100 disabled:opacity-50"
          >
            {busy === "connect" ? "Öppnar Google…" : "Koppla Google Kalender"}
          </button>
        </>
      ) : (
        <>
          <p className="mt-2 text-[13px] leading-snug text-stone-500">
            Kopplad ✓ Dina kalendrar finns i Google Kalender som &quot;… – Varannan&quot;.
            {lastSynced && <> Senast synkad {lastSynced}.</>}
          </p>
          {status?.lastError && <p className="mt-2 text-[11px] text-rose-600">{status.lastError}</p>}
          <button
            onClick={() => run("sync", syncGoogleCalendarNow)}
            disabled={busy !== null}
            className="mt-3 w-full rounded-lg bg-stone-50 px-3 py-2 text-sm font-medium text-stone-700 hover:bg-stone-100 disabled:opacity-50"
          >
            {busy === "sync" ? "Synkar…" : synced ? "Synkad ✓" : "Synka nu"}
          </button>

          {!confirmDisconnect ? (
            <button
              onClick={() => setConfirmDisconnect(true)}
              disabled={busy !== null}
              className="mt-2 w-full rounded-lg px-3 py-2 text-sm font-medium text-stone-400 hover:bg-stone-50 hover:text-rose-600 disabled:opacity-50"
            >
              Koppla bort Google Kalender
            </button>
          ) : (
            <div className="mt-2 rounded-lg bg-rose-50 p-3">
              <p className="text-[13px] leading-snug text-rose-800">
                Varannan-kalendrarna tas bort ur Google Kalender och Varannans åtkomst till ditt
                Google-konto dras tillbaka. Dina övriga kalendrar påverkas inte.
              </p>
              <div className="mt-2 flex gap-2">
                <button
                  onClick={() => setConfirmDisconnect(false)}
                  disabled={busy !== null}
                  className="flex-1 rounded-lg bg-white px-3 py-2 text-sm font-medium text-stone-600"
                >
                  Avbryt
                </button>
                <button
                  onClick={() => run("disconnect", disconnectGoogleCalendar)}
                  disabled={busy !== null}
                  className="flex-1 rounded-lg bg-rose-600 px-3 py-2 text-sm font-medium text-white disabled:opacity-50"
                >
                  {busy === "disconnect" ? "Kopplar bort…" : "Koppla bort"}
                </button>
              </div>
            </div>
          )}
        </>
      )}

      {error && <p className="mt-2 text-[11px] text-rose-600">{error}</p>}
    </div>
  );
}
