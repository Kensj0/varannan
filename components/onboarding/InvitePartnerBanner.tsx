"use client";

import { useState } from "react";

interface InvitePartnerBannerProps {
  teamName?: string;
  onCreateInvite: () => Promise<{ code: string; shareUrl: string }>;
}

/**
 * Visas överst i appen (inte som en spärrande skärm) så länge andra
 * föräldern inte anslutit än. Schemat och kalendern fungerar redan —
 * blocken som tillhör den ej ännu anslutna föräldern pekar på
 * PENDING_PARTNER_ID och aktiveras automatiskt när hen ansluter.
 *
 * Ersätter den tidigare WaitingForParentScreen, som blockerade hela
 * appen tills partnern fanns.
 */
export default function InvitePartnerBanner({ teamName, onCreateInvite }: InvitePartnerBannerProps) {
  const [invite, setInvite] = useState<{ code: string; shareUrl: string } | null>(null);
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function share(shareUrl: string) {
    if (typeof navigator !== "undefined" && navigator.share) {
      try {
        await navigator.share({
          title: "Varannan",
          text: "Gå med i vår familj i Varannan så delar vi schemat.",
          url: shareUrl,
        });
        return;
      } catch {
        // Avbruten delning — fall igenom till kopiering.
      }
    }
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch {
      setError("Kunde inte kopiera. Markera länken och kopiera manuellt.");
    }
  }

  if (!expanded) {
    return (
      <button
        onClick={() => setExpanded(true)}
        className="mb-4 w-full rounded-xl bg-rose-50 px-4 py-3 text-left text-sm font-medium text-rose-700 hover:bg-rose-100"
      >
        {teamName ? `${teamName} väntar på andra föräldern.` : "Väntar på andra föräldern."} Bjud in →
      </button>
    );
  }

  return (
    <div className="mb-4 rounded-xl bg-rose-50 px-4 py-3">
      <div className="mb-2 flex items-center justify-between">
        <p className="text-sm font-semibold text-rose-700">Bjud in andra föräldern</p>
        <button onClick={() => setExpanded(false)} className="text-xs text-rose-400 hover:text-rose-600">
          Stäng
        </button>
      </div>

      {invite ? (
        <div>
          <div className="mb-2 rounded-lg bg-white p-3 text-center">
            <p className="text-[10px] font-semibold uppercase text-stone-400">Inbjudningskod</p>
            <p className="my-1 font-mono text-2xl font-bold tracking-widest text-rose-600">{invite.code}</p>
            <p className="break-all text-[11px] text-stone-400">{invite.shareUrl}</p>
          </div>
          <button
            onClick={() => share(invite.shareUrl)}
            className="w-full rounded-full bg-rose-500 py-2 text-sm font-semibold text-white"
          >
            {copied ? "Länk kopierad" : "Dela länken"}
          </button>
          <p className="mt-1.5 text-center text-[11px] text-stone-400">Gäller i 72 timmar, kan användas en gång.</p>
        </div>
      ) : (
        <button
          disabled={loading}
          onClick={async () => {
            setLoading(true);
            setError(null);
            try {
              setInvite(await onCreateInvite());
            } catch {
              setError("Kunde inte skapa koden. Försök igen.");
            } finally {
              setLoading(false);
            }
          }}
          className="w-full rounded-full bg-rose-500 py-2 text-sm font-semibold text-white disabled:opacity-40"
        >
          {loading ? "Skapar kod…" : "Skapa inbjudningskod"}
        </button>
      )}

      {error && <p className="mt-2 text-xs text-rose-600">{error}</p>}
    </div>
  );
}
