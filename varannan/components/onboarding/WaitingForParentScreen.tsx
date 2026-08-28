"use client";

import { useState } from "react";

interface WaitingForParentScreenProps {
  teamName?: string;
  onCreateInvite: () => Promise<{ code: string; shareUrl: string }>;
  onSignOut: () => void;
}

/**
 * Visas när familjen finns men andra föräldern inte anslutit än.
 *
 * Tidigare hamnade man här i en återvändsgränd: en text och en
 * utloggningsknapp, utan något sätt att faktiskt skapa en inbjudan.
 * Den som avbröt onboarding efter första steget kom aldrig vidare,
 * eftersom teamId redan var satt och wizarden därför aldrig visades igen.
 */
export default function WaitingForParentScreen({
  teamName,
  onCreateInvite,
  onSignOut,
}: WaitingForParentScreenProps) {
  const [invite, setInvite] = useState<{ code: string; shareUrl: string } | null>(null);
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);
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

  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center px-6 text-center">
      <h1 className="mb-2 text-2xl font-bold text-stone-800">Väntar på andra föräldern</h1>
      <p className="mb-6 text-stone-500">
        {teamName ? `${teamName} är skapad.` : "Familjen är skapad."} Schemat kan sättas upp så fort ni är två —
        det bygger på er båda.
      </p>

      {invite ? (
        <div className="mb-4">
          <div className="mb-3 rounded-xl bg-stone-50 p-4">
            <p className="text-xs font-semibold uppercase text-stone-400">Inbjudningskod</p>
            <p className="my-2 font-mono text-3xl font-bold tracking-widest text-rose-600">{invite.code}</p>
            <p className="break-all text-xs text-stone-400">{invite.shareUrl}</p>
          </div>
          <button
            onClick={() => share(invite.shareUrl)}
            className="w-full rounded-full bg-rose-500 py-3 font-semibold text-white"
          >
            {copied ? "Länk kopierad" : "Dela länken"}
          </button>
          <p className="mt-2 text-xs text-stone-400">Gäller i 72 timmar, kan användas en gång.</p>
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
          className="mb-4 w-full rounded-full bg-rose-500 py-3 font-semibold text-white disabled:opacity-40"
        >
          {loading ? "Skapar kod…" : "Skapa inbjudningskod"}
        </button>
      )}

      {error && <p className="mb-3 text-sm text-rose-600">{error}</p>}

      <p className="mb-4 text-xs text-stone-400">
        Sidan uppdateras av sig själv när hen har anslutit.
      </p>

      <button onClick={onSignOut} className="text-sm text-stone-400 hover:text-rose-500">
        Logga ut
      </button>
    </main>
  );
}
