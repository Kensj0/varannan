"use client";

import { useState } from "react";
import { ScheduleStructureRequestDoc } from "../types/schema";

interface PendingStructureRequestsProps {
  requests: ScheduleStructureRequestDoc[];
  currentUserId: string;
  otherParentName: string;
  onRespond: (requestId: string, decision: "approved" | "declined") => Promise<void>;
}

/**
 * Väntande förslag på ändrat grundschema eller ändrad bytestid.
 *
 * Skilt från PendingShiftRequests, som gäller enstaka dagar. En
 * strukturändring skriver om hela mönstret och påverkar alla framtida
 * dagar, så den visas tydligare och med en varning om vad den gör.
 *
 * Den som skickade förslaget ser det också, men utan knappar — annars
 * ser det ut som att ingenting hände efter att man tryckt spara.
 */
export default function PendingStructureRequests({
  requests,
  currentUserId,
  otherParentName,
  onRespond,
}: PendingStructureRequestsProps) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (requests.length === 0) return null;

  return (
    <div className="mb-3 space-y-2">
      {requests.map((request) => {
        const mine = request.requestedBy === currentUserId;
        return (
          <div key={request.id} className="rounded-2xl bg-amber-50 p-3 ring-1 ring-amber-200">
            <p className="text-sm font-semibold text-amber-900">
              {mine ? "Väntar på svar" : "Förslag på schemaändring"}
            </p>
            <p className="mt-0.5 text-[13px] leading-snug text-amber-800">
              {mine
                ? `${otherParentName} behöver godkänna: ${request.summary}.`
                : `${otherParentName} vill ändra: ${request.summary}.`}
            </p>
            <p className="mt-1 text-[11px] leading-snug text-amber-700/80">
              Gäller alla framtida dagar. Godkända ändringar av enskilda dagar påverkas inte.
            </p>

            {!mine && (
              <div className="mt-2 flex gap-2">
                <button
                  disabled={busyId === request.id}
                  onClick={async () => {
                    setBusyId(request.id);
                    setError(null);
                    try {
                      await onRespond(request.id, "declined");
                    } catch {
                      setError("Kunde inte svara. Försök igen.");
                    } finally {
                      setBusyId(null);
                    }
                  }}
                  className="flex-1 rounded-full border border-amber-300 bg-white py-1.5 text-sm font-semibold text-amber-800 disabled:opacity-50"
                >
                  Avböj
                </button>
                <button
                  disabled={busyId === request.id}
                  onClick={async () => {
                    setBusyId(request.id);
                    setError(null);
                    try {
                      await onRespond(request.id, "approved");
                    } catch {
                      setError("Kunde inte svara. Försök igen.");
                    } finally {
                      setBusyId(null);
                    }
                  }}
                  className="flex-1 rounded-full bg-amber-600 py-1.5 text-sm font-semibold text-white disabled:opacity-50"
                >
                  {busyId === request.id ? "Sparar…" : "Godkänn"}
                </button>
              </div>
            )}

            {error && <p className="mt-1 text-[11px] text-rose-700">{error}</p>}
          </div>
        );
      })}
    </div>
  );
}
