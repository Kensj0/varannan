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
}: SettingsViewProps) {
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
