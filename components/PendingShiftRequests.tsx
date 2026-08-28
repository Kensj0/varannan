"use client";

import { useState } from "react";
import { ShiftRequestDoc } from "../types/schema";

interface PendingShiftRequestsProps {
  requests: ShiftRequestDoc[];
  currentUserId: string;
  parentNames: Record<string, string>;
  childName: string;
  onRespond: (shiftRequestId: string, decision: "approved" | "declined") => Promise<void>;
}

/**
 * Visar väntande ansvarsbyten. Den som SKICKADE förslaget får bara se
 * status ("Väntar på svar") — bara motparten kan godkänna eller avböja,
 * vilket också hindras server-side i approveShiftRequest.
 */
export default function PendingShiftRequests({
  requests,
  currentUserId,
  parentNames,
  childName,
  onRespond,
}: PendingShiftRequestsProps) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function respond(id: string, decision: "approved" | "declined") {
    setBusyId(id);
    setError(null);
    try {
      await onRespond(id, decision);
    } catch {
      setError("Kunde inte skicka svaret. Försök igen.");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="space-y-2">
      {requests.map((request) => {
        const isMine = request.requestedBy === currentUserId;
        const takingOver = parentNames[request.takingOverParentId] ?? "Andra föräldern";
        const busy = busyId === request.id;

        return (
          <div key={request.id} className="rounded-2xl bg-white p-4 shadow-sm">
            <p className="text-xs font-semibold uppercase tracking-wide text-amber-500">Förfrågan om ansvar</p>
            <p className="mt-1 font-semibold text-stone-800">
              {takingOver} tar ansvaret för {childName}
            </p>
            <p className="text-sm text-stone-500">
              Från {formatDateTime(request.startAt)}
              {request.endAt ? ` till ${formatDateTime(request.endAt)}` : " fram till nästa ordinarie byte"}
              {request.handoffMethod ? ` (${request.handoffMethod})` : ""}
            </p>

            {isMine ? (
              <p className="mt-3 text-sm italic text-stone-400">Väntar på svar…</p>
            ) : (
              <div className="mt-3 flex gap-2">
                <button
                  disabled={busy}
                  onClick={() => respond(request.id, "declined")}
                  className="flex-1 rounded-full border border-stone-300 py-2 text-sm font-semibold text-stone-600 disabled:opacity-40"
                >
                  Avböj
                </button>
                <button
                  disabled={busy}
                  onClick={() => respond(request.id, "approved")}
                  className="flex-1 rounded-full bg-emerald-500 py-2 text-sm font-semibold text-white disabled:opacity-40"
                >
                  {busy ? "Skickar…" : "Godkänn"}
                </button>
              </div>
            )}

            {error && busyId === null && <p className="mt-2 text-sm text-rose-600">{error}</p>}
          </div>
        );
      })}
    </div>
  );
}

function formatDateTime(ts: { seconds: number; nanoseconds: number }): string {
  return new Date(ts.seconds * 1000).toLocaleString("sv-SE", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}
