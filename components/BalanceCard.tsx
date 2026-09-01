"use client";

import { useState } from "react";
import { DayBalanceDoc, BalanceRequestDoc } from "../types/schema";
import { formatBalanceLabel } from "../lib/dayBalance";

interface BalanceCardProps {
  balance: DayBalanceDoc;
  parentNames: Record<string, string>;
  otherParentId: string;
  currentUserId: string;
  /** Väntande justeringar. Bara en i taget tillåts i UI:t. */
  pendingRequests?: BalanceRequestDoc[];
  onPropose?: (deltaDays: number) => Promise<void>;
  onRespond?: (requestId: string, decision: "approved" | "declined") => Promise<void>;
}

/**
 * Motsvarar konceptet "Ställning" — antal dagar en förälder ligger plus.
 * Raden är klickbar och öppnar en ruta där man kan föreslå en justering
 * utan att flytta specifika dagar (t.ex. när man kommit överens muntligt).
 * Justeringen kräver motpartens godkännande; ställningen är en
 * överenskommelse mellan två personer, inte ett värde någon sätter själv.
 */
export default function BalanceCard({
  balance,
  parentNames,
  otherParentId,
  currentUserId,
  pendingRequests = [],
  onPropose,
  onRespond,
}: BalanceCardProps) {
  const [open, setOpen] = useState(false);
  // Räknaren visar den NYA ställningen, inte förändringen. Att kvitta
  // till jämnt läge är det vanligaste önskemålet, och med en delta-räknare
  // gick det inte att uttrycka: 0 betydde "ändra ingenting".
  const [target, setTarget] = useState(balance.balanceDays);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const label = formatBalanceLabel(balance, parentNames, otherParentId);
  const isEven = balance.balanceDays === 0;
  const pending = pendingRequests[0] ?? null;
  const interactive = !!onPropose;

  const delta = target - balance.balanceDays;

  async function submit() {
    if (!onPropose || delta === 0) return;
    setBusy(true);
    setError(null);
    try {
      await onPropose(delta);
      setOpen(false);
    } catch (err) {
      const code = (err as { code?: string })?.code ?? "";
      const message = (err as { message?: string })?.message ?? "";
      setError([code, message].filter(Boolean).join(": ") || "Kunde inte skicka förslaget.");
    } finally {
      setBusy(false);
    }
  }

  async function respond(decision: "approved" | "declined") {
    if (!onRespond || !pending) return;
    setBusy(true);
    setError(null);
    try {
      await onRespond(pending.id, decision);
    } catch (err) {
      setError("Kunde inte skicka svaret. Försök igen.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <button
        type="button"
        disabled={!interactive}
        onClick={() => setOpen((v) => !v)}
        className={`flex w-full items-center justify-between gap-3 rounded-xl px-4 py-2 shadow-sm ${
          isEven ? "bg-stone-100" : "bg-emerald-50"
        }`}
      >
        <span className="text-[10px] font-semibold uppercase tracking-wide text-stone-400">Ställning</span>
        <span className={`truncate text-sm font-bold ${isEven ? "text-stone-600" : "text-emerald-700"}`}>
          {label}
        </span>
      </button>

      {pending && (
        <div className="mt-2 rounded-xl bg-amber-50 px-4 py-3">
          <p className="text-sm text-stone-700">
            <span className="font-semibold">
              {parentNames[pending.requestedBy] ?? "Andra föräldern"}
            </span>{" "}
            föreslår att ställningen justeras med {pending.deltaDays > 0 ? "+" : ""}
            {pending.deltaDays} dag{Math.abs(pending.deltaDays) === 1 ? "" : "ar"}.
          </p>
          {pending.requestedBy === currentUserId ? (
            <p className="mt-2 text-sm italic text-stone-400">Väntar på svar…</p>
          ) : (
            <div className="mt-3 flex gap-2">
              <button
                onClick={() => respond("approved")}
                disabled={busy}
                className="flex-1 rounded-full bg-emerald-600 py-2 text-sm font-semibold text-white disabled:opacity-50"
              >
                Godkänn
              </button>
              <button
                onClick={() => respond("declined")}
                disabled={busy}
                className="flex-1 rounded-full border border-stone-300 py-2 text-sm font-medium text-stone-600 disabled:opacity-50"
              >
                Avböj
              </button>
            </div>
          )}
          {error && <p className="mt-2 text-sm text-rose-600">{error}</p>}
        </div>
      )}

      {open && !pending && (
        <div className="mt-2 rounded-xl bg-white px-4 py-3 shadow-sm">
          <p className="text-sm text-stone-600">Föreslå en ny ställning.</p>

          <div className="mt-3 flex items-center justify-center gap-5">
            <button
              onClick={() => setTarget((t) => t - 1)}
              className="h-10 w-10 rounded-full bg-stone-100 text-xl font-bold text-stone-600"
              aria-label="Minska"
            >
              −
            </button>
            <span className="min-w-[4rem] text-center text-2xl font-bold text-stone-800">
              {target > 0 ? "+" : ""}
              {target}
            </span>
            <button
              onClick={() => setTarget((t) => t + 1)}
              className="h-10 w-10 rounded-full bg-stone-100 text-xl font-bold text-stone-600"
              aria-label="Öka"
            >
              +
            </button>
          </div>

          <p className="mt-2 text-center text-xs text-stone-400">
            {target === 0
              ? "Jämnt läge — inga dagar att kvitta."
              : `${target > 0 ? parentNames[balance.referenceParentId] ?? "Referensföräldern" : parentNames[otherParentId] ?? "Andra föräldern"} ligger ${Math.abs(target)} dag${Math.abs(target) === 1 ? "" : "ar"} plus.`}
          </p>
          <p className="mt-1 text-center text-xs text-stone-400">
            {delta === 0 ? "Samma som nu." : `Ändring: ${delta > 0 ? "+" : ""}${delta}`}
          </p>

          {error && <p className="mt-2 text-sm text-rose-600">{error}</p>}

          <div className="mt-3 flex gap-2">
            <button
              onClick={() => {
                setOpen(false);
                setTarget(balance.balanceDays);
              }}
              className="flex-1 rounded-full border border-stone-300 py-2 text-sm font-medium text-stone-600"
            >
              Avbryt
            </button>
            <button
              onClick={submit}
              disabled={busy || delta === 0}
              className="flex-1 rounded-full bg-stone-800 py-2 text-sm font-semibold text-white disabled:opacity-40"
            >
              {busy ? "Skickar…" : "Skicka förslag"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
