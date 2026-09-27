"use client";

import { useState } from "react";
import { CalendarRole } from "../types/schema";

export interface ManagedCalendar {
  id: string;
  name: string;
  /** Antal medlemmar, ALLA roller. Styr om "lämna" är radera eller lämna. */
  memberCount: number;
  /** Vilket team kalendern hör till — skiljer kalendrar åt över familjegränser. */
  teamId: string;
  /**
   * Rollen inloggad användare har på DEN HÄR raden — kan skilja sig från
   * den aktiva kalenderns roll när listan innehåller kalendrar i flera
   * familjer ("+"-väljaren visar ALLA man är med på, se app/page.tsx).
   * Bara "parent"-rader får de administrativa knapparna (byt namn/bjud
   * in/+ anhörig) — men ALLA roller får lämna/radera (✕), se canManage
   * nedan.
   */
  role: CalendarRole;
}

interface CalendarManagerPanelProps {
  onClose: () => void;
  calendars: ManagedCalendar[];
  /** "teamId:childId" — unikt över familjegränser, till skillnad från bara childId. */
  activeCalendarId: string;
  onSelectCalendar: (calendar: ManagedCalendar) => void;
  onCreateCalendar: (name: string) => Promise<void>;
  onRenameCalendar: (calendarId: string, name: string) => Promise<void>;
  /** confirmation måste vara den bokstavliga texten "RADERA". */
  onDeleteCalendar: (teamId: string, calendarId: string, confirmation: string) => Promise<void>;
  onInviteToCalendar: (calendarId: string) => Promise<{ shareUrl: string }>;
  /**
   * Bjuder in en anhörig eller utomstående (etapp 2, se
   * docs/roller-och-medlemskap.md). Till skillnad från
   * onInviteToCalendar (som ger en kod direkt) kräver den här ofta
   * godkännande av kalenderns andra förälder innan koden ens skapas —
   * status i svaret säger vilket.
   */
  onInviteRelative: (
    calendarId: string,
    email: string,
    role: Exclude<CalendarRole, "parent">
  ) => Promise<{ status: "sent" | "pending_approval" }>;
}

/**
 * Hanteringen av scheman, utbruten ur kalenderns inställningspanel till
 * en egen yta bakom plus-ikonen.
 *
 * Skillnaden mot den gamla dropdownen är att varje rad kan hanteras där
 * den står: byta namn och ta bort sker inline på raden, i stället för
 * att bara gälla den kalender som råkar vara vald. Det gör det möjligt
 * att städa bland scheman utan att först behöva växla till vart och ett.
 */
export default function CalendarManagerPanel({
  onClose,
  calendars,
  activeCalendarId,
  onSelectCalendar,
  onCreateCalendar,
  onRenameCalendar,
  onDeleteCalendar,
  onInviteToCalendar,
  onInviteRelative,
}: CalendarManagerPanelProps) {
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  /** Id på den rad som redigeras respektive väntar på raderingsbekräftelse. */
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [deleteConfirmText, setDeleteConfirmText] = useState("");
  const [inviteUrl, setInviteUrl] = useState<{ id: string; url: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** Id på den rad som visar "Bjud in anhörig/utomstående"-formuläret. */
  const [invitingRelativeId, setInvitingRelativeId] = useState<string | null>(null);
  const [relativeEmail, setRelativeEmail] = useState("");
  const [relativeRole, setRelativeRole] = useState<Exclude<CalendarRole, "parent">>("relative");
  const [relativeResult, setRelativeResult] = useState<{
    id: string;
    status: "sent" | "pending_approval";
  } | null>(null);

  async function run(action: () => Promise<void>, fallbackMessage: string) {
    setBusy(true);
    setError(null);
    try {
      await action();
      return true;
    } catch (err: any) {
      // Servern har de bästa formuleringarna (t.ex. varför den sista
      // kalendern inte får tas bort) — visa dem hellre än en generisk text.
      setError(err?.message || fallbackMessage);
      return false;
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="fixed inset-0 z-40" onClick={onClose} />

      <div className="absolute right-0 top-12 z-50 max-h-[75vh] w-72 overflow-y-auto rounded-2xl bg-white p-4 text-left shadow-xl ring-1 ring-stone-100">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-stone-400">Scheman</h3>
          <button
            onClick={onClose}
            aria-label="Stäng"
            className="grid h-6 w-6 place-items-center rounded-full text-stone-400 hover:bg-stone-50"
          >
            ✕
          </button>
        </div>

        <div className="space-y-1">
          {calendars.map((calendar) => {
            const isActive = `${calendar.teamId}:${calendar.id}` === activeCalendarId;
            const canManage = calendar.role === "parent";

            if (renamingId === calendar.id) {
              return (
                <div key={calendar.id} className="rounded-lg bg-stone-50 p-2">
                  <input
                    autoFocus
                    value={renameDraft}
                    onChange={(e) => setRenameDraft(e.target.value)}
                    onKeyDown={async (e) => {
                      if (e.key === "Escape") setRenamingId(null);
                      if (e.key !== "Enter") return;
                      const trimmed = renameDraft.trim();
                      if (!trimmed) return setError("Namnet kan inte vara tomt.");
                      const ok = await run(
                        () => onRenameCalendar(calendar.id, trimmed),
                        "Kunde inte byta namn."
                      );
                      if (ok) setRenamingId(null);
                    }}
                    disabled={busy}
                    className="mb-1.5 w-full rounded-lg border border-stone-200 px-2 py-1.5 text-sm disabled:opacity-50"
                  />
                  <div className="flex gap-1">
                    <button
                      onClick={() => setRenamingId(null)}
                      className="flex-1 rounded-lg border border-stone-200 py-1 text-xs font-semibold text-stone-600"
                    >
                      Avbryt
                    </button>
                    <button
                      disabled={busy}
                      onClick={async () => {
                        const trimmed = renameDraft.trim();
                        if (!trimmed) return setError("Namnet kan inte vara tomt.");
                        const ok = await run(
                          () => onRenameCalendar(calendar.id, trimmed),
                          "Kunde inte byta namn."
                        );
                        if (ok) setRenamingId(null);
                      }}
                      className="flex-1 rounded-lg bg-rose-500 py-1 text-xs font-semibold text-white disabled:opacity-40"
                    >
                      {busy ? "Sparar…" : "Spara"}
                    </button>
                  </div>
                </div>
              );
            }

            if (confirmDeleteId === calendar.id) {
              const isLeaving = calendar.memberCount > 1;
              const matches = deleteConfirmText.trim() === "RADERA";
              return (
                <div key={calendar.id} className="rounded-lg bg-rose-50 p-2">
                  <p className="mb-2 text-[11px] leading-snug text-rose-700">
                    {isLeaving ? (
                      <>
                        Lämna <span className="font-semibold">{calendar.name}</span>? Den försvinner
                        bara för dig — finns kvar hos de andra, som kan bjuda in någon ny i ditt
                        ställe.
                      </>
                    ) : (
                      <>
                        Ta bort <span className="font-semibold">{calendar.name}</span> helt? Schemat,
                        ställningen, barninfo, chatt och listor försvinner. Det går inte att ångra.
                      </>
                    )}
                  </p>
                  <label className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-rose-700">
                    Skriv RADERA för att bekräfta
                  </label>
                  <input
                    autoFocus
                    value={deleteConfirmText}
                    onChange={(e) => setDeleteConfirmText(e.target.value)}
                    placeholder="RADERA"
                    disabled={busy}
                    className="mb-2 w-full rounded-lg border border-rose-200 bg-white px-2 py-1.5 text-sm outline-none focus:border-rose-400 disabled:opacity-50"
                  />
                  <div className="flex gap-1">
                    <button
                      onClick={() => {
                        setConfirmDeleteId(null);
                        setDeleteConfirmText("");
                        setError(null);
                      }}
                      className="flex-1 rounded-lg border border-stone-300 bg-white py-1 text-xs font-semibold text-stone-600"
                    >
                      Avbryt
                    </button>
                    <button
                      disabled={busy || !matches}
                      onClick={async () => {
                        const ok = await run(
                          () => onDeleteCalendar(calendar.teamId, calendar.id, deleteConfirmText.trim()),
                          isLeaving ? "Kunde inte lämna kalendern." : "Kunde inte ta bort kalendern."
                        );
                        if (ok) {
                          setConfirmDeleteId(null);
                          setDeleteConfirmText("");
                        }
                      }}
                      className="flex-1 rounded-lg bg-rose-600 py-1 text-xs font-semibold text-white disabled:opacity-40"
                    >
                      {busy ? "Arbetar…" : isLeaving ? "Lämna" : "Ta bort"}
                    </button>
                  </div>
                </div>
              );
            }

            if (invitingRelativeId === calendar.id) {
              return (
                <div key={calendar.id} className="rounded-lg bg-stone-50 p-2">
                  {relativeResult ? (
                    <div>
                      <p className="mb-2 text-[11px] leading-snug text-stone-600">
                        {relativeResult.status === "sent"
                          ? "Inbjudan skickad — koden är mailad."
                          : "Skapad. Väntar på att den andra föräldern godkänner innan koden mailas."}
                      </p>
                      <button
                        onClick={() => {
                          setInvitingRelativeId(null);
                          setRelativeResult(null);
                          setRelativeEmail("");
                        }}
                        className="w-full rounded-lg border border-stone-200 py-1 text-xs font-semibold text-stone-600"
                      >
                        Stäng
                      </button>
                    </div>
                  ) : (
                    <>
                      <input
                        autoFocus
                        type="email"
                        value={relativeEmail}
                        onChange={(e) => setRelativeEmail(e.target.value)}
                        placeholder="mailadress"
                        disabled={busy}
                        className="mb-1.5 w-full rounded-lg border border-stone-200 px-2 py-1.5 text-sm disabled:opacity-50"
                      />
                      <div className="mb-1.5 flex gap-1 text-xs">
                        <button
                          type="button"
                          onClick={() => setRelativeRole("relative")}
                          className={`flex-1 rounded-lg border py-1 font-semibold ${
                            relativeRole === "relative"
                              ? "border-rose-400 bg-rose-50 text-rose-700"
                              : "border-stone-200 text-stone-500"
                          }`}
                        >
                          Anhörig
                        </button>
                        <button
                          type="button"
                          onClick={() => setRelativeRole("viewer")}
                          className={`flex-1 rounded-lg border py-1 font-semibold ${
                            relativeRole === "viewer"
                              ? "border-rose-400 bg-rose-50 text-rose-700"
                              : "border-stone-200 text-stone-500"
                          }`}
                        >
                          Utomstående
                        </button>
                      </div>
                      <p className="mb-1.5 text-[11px] leading-snug text-stone-500">
                        {relativeRole === "relative"
                          ? "Ser och lägger in i schema och listor, tar bara bort sina egna aktiviteter. Ingen tillgång till chatten."
                          : "Ser bara schema och aktiviteter — kan inte lägga in eller ändra något."}
                      </p>
                      <div className="flex gap-1">
                        <button
                          onClick={() => {
                            setInvitingRelativeId(null);
                            setRelativeEmail("");
                            setError(null);
                          }}
                          className="flex-1 rounded-lg border border-stone-200 py-1 text-xs font-semibold text-stone-600"
                        >
                          Avbryt
                        </button>
                        <button
                          disabled={busy}
                          onClick={async () => {
                            const trimmed = relativeEmail.trim();
                            if (!trimmed) return setError("Ange en mailadress.");
                            const ok = await run(async () => {
                              const { status } = await onInviteRelative(
                                calendar.id,
                                trimmed,
                                relativeRole
                              );
                              setRelativeResult({ id: calendar.id, status });
                            }, "Kunde inte skapa inbjudan.");
                            void ok;
                          }}
                          className="flex-1 rounded-lg bg-rose-500 py-1 text-xs font-semibold text-white disabled:opacity-40"
                        >
                          {busy ? "Skickar…" : "Bjud in"}
                        </button>
                      </div>
                    </>
                  )}
                  {error && <p className="mt-2 text-[11px] leading-snug text-rose-600">{error}</p>}
                </div>
              );
            }

            return (
              <div
                key={`${calendar.teamId}:${calendar.id}`}
                className={`rounded-lg px-2 py-1.5 ${isActive ? "bg-rose-50" : "hover:bg-stone-50"}`}
              >
                {/* Namnet på egen rad, full bredd — låg tidigare i samma
                    rad som hanteringsknapparna (Byt namn/Bjud in/
                    + Anhörig/✕), vilket klämde långa namn ner till bara
                    ett par tecken. */}
                <button
                  onClick={() => {
                    onSelectCalendar(calendar);
                    onClose();
                  }}
                  className="block w-full text-left"
                >
                  <span
                    className={`block truncate text-sm ${
                      isActive ? "font-semibold text-rose-700" : "text-stone-700"
                    }`}
                  >
                    {calendar.name}
                  </span>
                  {/* En kalender man bara är anhörig/utomstående på —
                      inga administrativa knappar (byt namn/bjud in), så
                      rollen visas här i stället så det syns VARFÖR. */}
                  {!canManage && (
                    <span className="block text-[11px] text-stone-400">
                      {calendar.role === "viewer" ? "Utomstående" : "Anhörig"}
                    </span>
                  )}
                </button>

                {/* Byt namn/Bjud in/+ Anhörig är administrativt och bara
                    för förälder-rader. ✕ (lämna/radera) gäller ALLA
                    roller — att lämna en kalender man är med på (och tar
                    bort bara sig själv från den) är inte en admin-
                    handling, se docs/roller-och-medlemskap.md. */}
                <div className="mt-1 flex flex-wrap items-center gap-1">
                  {canManage && (
                    <>
                      <button
                        onClick={() => {
                          setRenamingId(calendar.id);
                          setRenameDraft(calendar.name);
                          setError(null);
                        }}
                        aria-label={`Byt namn på ${calendar.name}`}
                        className="shrink-0 rounded px-1.5 py-1 text-xs text-stone-400 hover:text-rose-600"
                      >
                        Byt namn
                      </button>

                      {calendar.memberCount < 2 && (
                        <button
                          onClick={async () => {
                            const res = await run(
                              async () => {
                                const { shareUrl } = await onInviteToCalendar(calendar.id);
                                setInviteUrl({ id: calendar.id, url: shareUrl });
                              },
                              "Kunde inte skapa inbjudan."
                            );
                            void res;
                          }}
                          aria-label={`Bjud in till ${calendar.name}`}
                          className="shrink-0 rounded px-1.5 py-1 text-xs text-stone-400 hover:text-rose-600"
                        >
                          Bjud in
                        </button>
                      )}

                      <button
                        onClick={() => {
                          setInvitingRelativeId(calendar.id);
                          setRelativeEmail("");
                          setRelativeRole("relative");
                          setRelativeResult(null);
                          setError(null);
                        }}
                        aria-label={`Bjud in anhörig till ${calendar.name}`}
                        className="shrink-0 rounded px-1.5 py-1 text-xs text-stone-400 hover:text-rose-600"
                      >
                        + Anhörig
                      </button>
                    </>
                  )}

                  <button
                    onClick={() => {
                      setConfirmDeleteId(calendar.id);
                      setDeleteConfirmText("");
                      setError(null);
                    }}
                    title={calendar.memberCount > 1 ? `Lämna ${calendar.name}` : `Ta bort ${calendar.name}`}
                    aria-label={calendar.memberCount > 1 ? `Lämna ${calendar.name}` : `Ta bort ${calendar.name}`}
                    className="ml-auto shrink-0 rounded px-1.5 py-1 text-sm font-semibold text-stone-400 hover:text-rose-600"
                  >
                    ✕
                  </button>
                </div>
              </div>
            );
          })}
        </div>

        <div className="mt-2 border-t border-stone-100 pt-2">
          {creating ? (
            <div>
              <input
                autoFocus
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={async (e) => {
                  if (e.key === "Escape") setCreating(false);
                  if (e.key !== "Enter") return;
                  const trimmed = newName.trim();
                  if (!trimmed) return setError("Ge kalendern ett namn.");
                  const ok = await run(() => onCreateCalendar(trimmed), "Kunde inte skapa kalendern.");
                  if (ok) {
                    setNewName("");
                    setCreating(false);
                    onClose();
                  }
                }}
                placeholder="Namn, t.ex. barnets namn"
                disabled={busy}
                className="mb-1.5 w-full rounded-lg border border-stone-200 px-2 py-1.5 text-sm disabled:opacity-50"
              />
              <div className="flex gap-1">
                <button
                  onClick={() => {
                    setCreating(false);
                    setNewName("");
                    setError(null);
                  }}
                  className="flex-1 rounded-lg border border-stone-200 py-1.5 text-xs font-semibold text-stone-600"
                >
                  Avbryt
                </button>
                <button
                  disabled={busy}
                  onClick={async () => {
                    const trimmed = newName.trim();
                    if (!trimmed) return setError("Ge kalendern ett namn.");
                    const ok = await run(
                      () => onCreateCalendar(trimmed),
                      "Kunde inte skapa kalendern."
                    );
                    if (ok) {
                      setNewName("");
                      setCreating(false);
                      onClose();
                    }
                  }}
                  className="flex-1 rounded-lg bg-rose-500 py-1.5 text-xs font-semibold text-white disabled:opacity-40"
                >
                  {busy ? "Skapar…" : "Skapa"}
                </button>
              </div>
            </div>
          ) : (
            <button
              onClick={() => {
                setCreating(true);
                setError(null);
              }}
              className="w-full rounded-lg px-2 py-2 text-left text-sm font-medium text-rose-600 hover:bg-rose-50"
            >
              + Ny kalender
            </button>
          )}
        </div>

        {inviteUrl && (
          <div className="mt-2 rounded-lg bg-stone-50 p-2">
            <p className="mb-1 text-[11px] font-medium text-stone-700">Dela den här länken:</p>
            <p className="break-all text-[11px] text-stone-500">{inviteUrl.url}</p>
            <button
              onClick={() => {
                void navigator.clipboard.writeText(inviteUrl.url);
              }}
              className="mt-1 text-[11px] font-semibold text-rose-600 hover:underline"
            >
              Kopiera länk
            </button>
          </div>
        )}

        {error && <p className="mt-2 text-[11px] leading-snug text-rose-600">{error}</p>}
      </div>
    </>
  );
}
