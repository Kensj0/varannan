"use client";

import { useMemo, useState } from "react";
import { ShiftRequestDoc } from "../types/schema";

interface PendingShiftRequestsProps {
  requests: ShiftRequestDoc[];
  currentUserId: string;
  parentNames: Record<string, string>;
  childName: string;
  onRespond: (shiftRequestId: string, decision: "approved" | "declined") => Promise<void>;
  onRespondBatch: (batchId: string, decision: "approved" | "declined") => Promise<void>;
  /**
   * Hoppar kalendern till förslagets månad. Utan det syns den gula
   * markeringen bara om man råkar bläddra dit själv — ett förslag i
   * december är osynligt i kalendern när man står i september.
   */
  onShowInCalendar?: (date: Date) => void;
}

/**
 * Visar väntande ansvarsbyten. Den som SKICKADE förslaget får bara se
 * status ("Väntar på svar") — bara motparten kan godkänna eller avböja,
 * vilket också hindras server-side i approveShiftRequest(Batch).
 *
 * Flera dagar som skickades i EN "Skicka förslag"-åtgärd (samma
 * batchId, t.ex. från kalenderns ändringsläge) visas och besvaras som
 * EN grupp istället för separata rader.
 */
export default function PendingShiftRequests({
  requests,
  currentUserId,
  parentNames,
  childName,
  onRespond,
  onRespondBatch,
  onShowInCalendar,
}: PendingShiftRequestsProps) {
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const groups = useMemo(() => {
    const byBatch = new Map<string, ShiftRequestDoc[]>();
    const single: ShiftRequestDoc[] = [];
    for (const req of requests) {
      if (req.batchId) {
        const list = byBatch.get(req.batchId) ?? [];
        list.push(req);
        byBatch.set(req.batchId, list);
      } else {
        single.push(req);
      }
    }
    const batchGroups = Array.from(byBatch.entries()).map(([batchId, items]) => ({
      key: batchId,
      batchId,
      items: items.sort((a, b) => a.startAt.seconds - b.startAt.seconds),
    }));
    const singleGroups = single.map((req) => ({ key: req.id, batchId: null as string | null, items: [req] }));
    return [...batchGroups, ...singleGroups].sort(
      (a, b) => a.items[0].startAt.seconds - b.items[0].startAt.seconds
    );
  }, [requests]);

  async function respond(group: (typeof groups)[number], decision: "approved" | "declined") {
    setBusyKey(group.key);
    setError(null);
    try {
      if (group.batchId) {
        await onRespondBatch(group.batchId, decision);
      } else {
        await onRespond(group.items[0].id, decision);
      }
    } catch (err) {
      console.error("[PendingShiftRequests] svar misslyckades:", err);
      // Visa serverns egen text när den finns — den skiljer på "redan
      // hanterad", "din egen förfrågan" och riktiga fel, som kräver
      // helt olika åtgärder från användaren.
      const code = (err as { code?: string })?.code ?? "";
      const message = (err as { message?: string })?.message ?? "";
      const detail = [code, message].filter(Boolean).join(": ");
      setError(detail ? `Kunde inte skicka svaret. ${detail}` : "Kunde inte skicka svaret. Försök igen.");
    } finally {
      setBusyKey(null);
    }
  }

  return (
    <div className="space-y-2">
      {groups.map((group) => {
        const first = group.items[0];
        const isMine = first.requestedBy === currentUserId;
        const busy = busyKey === group.key;
        const isMultiDay = group.items.length > 1;

        return (
          <div key={group.key} className="rounded-2xl bg-white p-4 shadow-sm">
            <div className="flex items-baseline justify-between gap-2">
              <p className="text-xs font-semibold uppercase tracking-wide text-amber-500">
                {isMultiDay ? `Förslag på ${group.items.length} ändrade dagar` : "Förfrågan om ansvar"}
              </p>
              {onShowInCalendar && (
                <button
                  onClick={() => onShowInCalendar(new Date(first.startAt.seconds * 1000))}
                  className="shrink-0 text-xs font-medium text-stone-500 underline"
                >
                  Visa i kalendern
                </button>
              )}
            </div>

            {isMultiDay ? (
              <div className="mt-1 space-y-1">
                {group.items.map((req) => (
                  <p key={req.id} className="text-sm text-stone-600">
                    <span className="font-semibold text-stone-800">
                      {parentNames[req.takingOverParentId] ?? "Andra föräldern"}
                    </span>{" "}
                    {formatDateTime(req.startAt)}
                    {req.endAt ? ` – ${formatDateTime(req.endAt)}` : " fram till nästa ordinarie byte"}
                  </p>
                ))}
                <p className="text-sm text-stone-500">för {childName}</p>
              </div>
            ) : (
              <>
                <p className="mt-1 font-semibold text-stone-800">
                  {parentNames[first.takingOverParentId] ?? "Andra föräldern"} tar ansvaret för {childName}
                </p>
                <p className="text-sm text-stone-500">
                  Från {formatDateTime(first.startAt)}
                  {first.endAt ? ` till ${formatDateTime(first.endAt)}` : " fram till nästa ordinarie byte"}
                  {first.handoffMethod ? ` (${first.handoffMethod})` : ""}
                </p>
              </>
            )}

            {isMine ? (
              <p className="mt-3 text-sm italic text-stone-400">Väntar på svar…</p>
            ) : (
              <div className="mt-3 flex gap-2">
                <button
                  disabled={busy}
                  onClick={() => respond(group, "declined")}
                  className="flex-1 rounded-full border border-stone-300 py-2 text-sm font-semibold text-stone-600 disabled:opacity-40"
                >
                  Avböj
                </button>
                <button
                  disabled={busy}
                  onClick={() => respond(group, "approved")}
                  className="flex-1 rounded-full bg-emerald-500 py-2 text-sm font-semibold text-white disabled:opacity-40"
                >
                  {busy ? "Skickar…" : "Godkänn"}
                </button>
              </div>
            )}

            {error && busyKey === null && <p className="mt-2 text-sm text-rose-600">{error}</p>}
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
