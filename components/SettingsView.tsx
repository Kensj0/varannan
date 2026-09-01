"use client";

import { useState } from "react";
import InvitePartnerBanner from "./onboarding/InvitePartnerBanner";

type PushPermission = "unsupported" | "default" | "granted" | "denied" | null;

interface SettingsViewProps {
  displayName: string;
  email: string | null;
  onResetPassword: (email: string) => Promise<void>;
  onSignOut: () => Promise<void>;
  pushPermission: PushPermission;
  onEnablePush: () => Promise<void> | void;
  hasPartner: boolean;
  teamName?: string;
  onCreateInvite: () => Promise<{ code: string; shareUrl: string }>;
  /**
   * Öppnar cykelbyggaren för att göra om grundschemat. Utelämnas när det
   * inte går att ändra än (inget barn valt, eller andra föräldern har
   * inte anslutit — blocken pekar på uid:n och kan inte byggas mot en
   * platshållare).
   */
  onEditStructure?: () => void;
  /** Sparar nytt visningsnamn. Utelämnas om namnbyte inte är möjligt. */
  onUpdateDisplayName?: (name: string) => Promise<void>;
}

/**
 * Kontoinställningar — samlar allt som rör kontot och familjen på ett
 * ställe i stället för att ligga låst ovanför alla vyer: notiser,
 * inbjudan till andra föräldern, lösenordsåterställning och utloggning.
 */
export default function SettingsView({
  displayName,
  email,
  onResetPassword,
  onSignOut,
  pushPermission,
  onEnablePush,
  hasPartner,
  teamName,
  onCreateInvite,
  onEditStructure,
  onUpdateDisplayName,
}: SettingsViewProps) {
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState(displayName);
  const [savingName, setSavingName] = useState(false);
  const [nameError, setNameError] = useState<string | null>(null);

  async function handleSaveName() {
    if (!onUpdateDisplayName) return;
    setSavingName(true);
    setNameError(null);
    try {
      await onUpdateDisplayName(nameDraft.trim());
      setEditingName(false);
    } catch {
      setNameError("Kunde inte spara namnet. Försök igen.");
    } finally {
      setSavingName(false);
    }
  }

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
        {editingName ? (
          <div className="mt-2">
            <input
              autoFocus
              value={nameDraft}
              onChange={(e) => setNameDraft(e.target.value)}
              placeholder="Ditt namn"
              className="w-full rounded-xl border border-stone-200 px-3 py-2 text-sm text-stone-800 outline-none focus:border-stone-400"
            />
            {nameError && <p className="mt-2 text-sm text-rose-600">{nameError}</p>}
            <div className="mt-3 flex gap-2">
              <button
                onClick={handleSaveName}
                disabled={savingName || !nameDraft.trim()}
                className="flex-1 rounded-full bg-stone-800 py-2 text-sm font-semibold text-white disabled:opacity-50"
              >
                {savingName ? "Sparar…" : "Spara"}
              </button>
              <button
                onClick={() => {
                  setEditingName(false);
                  setNameError(null);
                }}
                className="flex-1 rounded-full border border-stone-200 py-2 text-sm font-medium text-stone-500"
              >
                Avbryt
              </button>
            </div>
          </div>
        ) : (
          <div className="mt-2 flex items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="truncate text-sm font-medium text-stone-800">{displayName}</p>
              {email && <p className="truncate text-sm text-stone-500">{email}</p>}
            </div>
            {onUpdateDisplayName && (
              <button
                onClick={() => {
                  setNameDraft(displayName);
                  setEditingName(true);
                }}
                className="shrink-0 text-sm font-medium text-stone-500 underline"
              >
                Ändra
              </button>
            )}
          </div>
        )}
      </div>

      {/* Andra föräldern — inbjudan ligger här i stället för som en
          permanent banner ovanför alla vyer. */}
      {!hasPartner && (
        <div className="rounded-2xl bg-white p-4 shadow-sm">
          <p className="mb-3 text-xs font-semibold uppercase tracking-wide text-stone-400">
            Andra föräldern
          </p>
          <div className="[&>*]:!mb-0">
            <InvitePartnerBanner teamName={teamName} onCreateInvite={onCreateInvite} />
          </div>
        </div>
      )}

      {/* Struktur — gör om grundschemat i samma byggare som i onboarding. */}
      {onEditStructure && (
        <div className="rounded-2xl bg-white p-4 shadow-sm">
          <p className="text-xs font-semibold uppercase tracking-wide text-stone-400">Struktur</p>
          <p className="mt-2 text-sm text-stone-500">
            Ändra grundschemat — vem som har barnet vilka dagar, och när bytet sker. Inlagda aktiviteter
            och godkända bytesdagar påverkas inte.
          </p>
          <button
            onClick={onEditStructure}
            className="mt-3 w-full rounded-full bg-stone-800 py-2.5 text-sm font-semibold text-white hover:bg-stone-700"
          >
            Ändra grundschema
          </button>
        </div>
      )}

      {/* Notiser */}
      <div className="rounded-2xl bg-white p-4 shadow-sm">
        <p className="text-xs font-semibold uppercase tracking-wide text-stone-400">Notiser</p>

        {pushPermission === "granted" && (
          <p className="mt-2 text-[13px] text-emerald-600">
            Notiser är på för byten och inbjudningar.
          </p>
        )}

        {pushPermission === "default" && (
          <>
            <p className="mt-2 text-[13px] leading-snug text-stone-500">
              Få en notis när andra föräldern föreslår ett byte eller skickar en inbjudan.
            </p>
            <button
              onClick={() => onEnablePush()}
              className="mt-3 w-full rounded-lg bg-sky-50 px-3 py-2 text-sm font-medium text-sky-700 hover:bg-sky-100"
            >
              Aktivera notiser
            </button>
          </>
        )}

        {pushPermission === "denied" && (
          <p className="mt-2 text-[13px] leading-snug text-stone-500">
            Notiser är blockerade i webbläsaren. Slå på dem i webbläsarens
            platsinställningar för den här sidan.
          </p>
        )}

        {(pushPermission === "unsupported" || pushPermission === null) && (
          <p className="mt-2 text-[13px] leading-snug text-stone-500">
            Notiser stöds inte i den här webbläsaren.
          </p>
        )}
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
