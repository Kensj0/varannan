"use client";

import { useEffect, useRef, useState } from "react";
import { ChatMessageDoc, ShiftRequestDoc } from "../types/schema";

interface ChatViewProps {
  messages: ChatMessageDoc[];
  currentUserId: string;
  parentNames: Record<string, string>;
  /** För att kunna visa ett kort istället för bara text när ett meddelande rör ett byte. */
  shiftRequestsById: Record<string, ShiftRequestDoc>;
  childName?: string;
  onSend: (text: string) => Promise<void>;
}

/**
 * Föräldrarnas gemensamma chatt. Meddelanden som är kopplade till ett
 * ansvarsbyte (`linkedShiftRequestId`) renderas som ett kort med status,
 * så historiken över förfrågningar och godkännanden syns direkt i
 * konversationen — precis som i originalappen.
 */
export default function ChatView({
  messages,
  currentUserId,
  parentNames,
  shiftRequestsById,
  childName,
  onSend,
}: ChatViewProps) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  // Scrolla till nyaste meddelandet när listan växer.
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length]);

  async function handleSend() {
    const trimmed = text.trim();
    if (!trimmed || sending) return;
    setSending(true);
    setError(null);
    try {
      await onSend(trimmed);
      setText("");
    } catch {
      setError("Meddelandet kunde inte skickas. Försök igen.");
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex-1 space-y-2 overflow-y-auto px-1 py-2">
        {messages.length === 0 && (
          <p className="py-10 text-center text-sm text-stone-400">
            Inga meddelanden än. Skriv något för att komma igång.
          </p>
        )}

        {messages.map((message, i) => {
          const isMine = message.senderId === currentUserId;
          const showDate = i === 0 || !isSameDay(messages[i - 1].createdAt, message.createdAt);
          const linked = message.linkedShiftRequestId
            ? shiftRequestsById[message.linkedShiftRequestId]
            : undefined;

          return (
            <div key={message.id}>
              {showDate && (
                <p className="py-2 text-center text-xs font-medium text-stone-400">
                  {formatDateSeparator(message.createdAt)}
                </p>
              )}

              <div className={`flex ${isMine ? "justify-end" : "justify-start"}`}>
                <div className="max-w-[80%]">
                  {!isMine && (
                    <p className="mb-0.5 px-1 text-xs text-stone-400">
                      {parentNames[message.senderId] ?? "Förälder"}
                    </p>
                  )}

                  {linked ? (
                    <ShiftRequestBubble request={linked} childName={childName} parentNames={parentNames} isMine={isMine} />
                  ) : (
                    <div
                      className={`rounded-2xl px-3 py-2 text-sm ${
                        isMine ? "rounded-br-sm bg-rose-500 text-white" : "rounded-bl-sm bg-white text-stone-800"
                      }`}
                    >
                      {message.text}
                    </div>
                  )}

                  <p className={`mt-0.5 px-1 text-[10px] text-stone-400 ${isMine ? "text-right" : ""}`}>
                    {formatTime(message.createdAt)}
                  </p>
                </div>
              </div>
            </div>
          );
        })}
        <div ref={bottomRef} />
      </div>

      {error && <p className="px-2 pb-1 text-sm text-rose-600">{error}</p>}

      <div className="flex items-end gap-2 border-t border-stone-200 bg-white px-2 py-2">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void handleSend();
            }
          }}
          rows={1}
          placeholder="Skriv ett meddelande"
          className="max-h-32 flex-1 resize-none rounded-2xl bg-stone-100 px-4 py-2.5 text-sm outline-none focus:ring-2 focus:ring-rose-400"
        />
        <button
          onClick={handleSend}
          disabled={!text.trim() || sending}
          className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-rose-500 text-white disabled:opacity-40"
          aria-label="Skicka"
        >
          ➤
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

function ShiftRequestBubble({
  request,
  childName,
  parentNames,
  isMine,
}: {
  request: ShiftRequestDoc;
  childName?: string;
  parentNames: Record<string, string>;
  isMine: boolean;
}) {
  const takingOver = parentNames[request.takingOverParentId] ?? "Andra föräldern";
  const statusLabel = {
    pending: "Väntar på svar",
    approved: "Godkänt",
    declined: "Avböjt",
    cancelled: "Återkallat",
  }[request.status];
  const statusColor = {
    pending: "text-amber-600",
    approved: "text-emerald-600",
    declined: "text-stone-400",
    cancelled: "text-stone-400",
  }[request.status];

  return (
    <div className={`rounded-2xl border border-stone-200 bg-white px-3 py-2.5 ${isMine ? "rounded-br-sm" : "rounded-bl-sm"}`}>
      <p className="text-xs font-semibold uppercase tracking-wide text-stone-400">Ansvarsbyte</p>
      <p className="mt-0.5 text-sm font-semibold text-stone-800">
        {takingOver} tar ansvaret{childName ? ` för ${childName}` : ""}
      </p>
      <p className="text-xs text-stone-500">
        Från {formatDateTime(request.startAt)}
        {request.endAt ? ` till ${formatDateTime(request.endAt)}` : " fram till nästa ordinarie byte"}
      </p>
      <p className={`mt-1 text-xs font-semibold ${statusColor}`}>{statusLabel}</p>
    </div>
  );
}

// ---------------------------------------------------------------------------

type Ts = { seconds: number; nanoseconds: number };

function toDate(ts: Ts): Date {
  return new Date(ts.seconds * 1000);
}

function isSameDay(a: Ts, b: Ts): boolean {
  const da = toDate(a);
  const dbb = toDate(b);
  return da.getFullYear() === dbb.getFullYear() && da.getMonth() === dbb.getMonth() && da.getDate() === dbb.getDate();
}

function formatDateSeparator(ts: Ts): string {
  const date = toDate(ts);
  const today = new Date();
  const yesterday = new Date(today.getTime() - 24 * 60 * 60 * 1000);

  if (sameCalendarDay(date, today)) return "Idag";
  if (sameCalendarDay(date, yesterday)) return "Igår";
  return date.toLocaleDateString("sv-SE", { day: "numeric", month: "long" });
}

function sameCalendarDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function formatTime(ts: Ts): string {
  return toDate(ts).toLocaleTimeString("sv-SE", { hour: "2-digit", minute: "2-digit" });
}

function formatDateTime(ts: Ts): string {
  return toDate(ts).toLocaleString("sv-SE", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}
