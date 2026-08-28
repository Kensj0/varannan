"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { useAuth } from "../../../lib/auth/AuthProvider";
import LoginForm from "../../../components/auth/LoginForm";
import { acceptInvite } from "../../../lib/onboardingClient";

type Status = "checking" | "confirm-switch" | "accepting" | "success" | "error";

/**
 * app/join/[code]/page.tsx
 * ------------------------
 * Länken från InviteStep (t.ex. https://varannan.app/join/AB12CD).
 * AuthGate släpper igenom /join/* utan att köra sin vanliga
 * login/onboarding-gating (se components/auth/AuthGate.tsx), så den
 * här sidan äger hela flödet själv:
 *
 *   1. Inte inloggad → visa LoginForm, fortsätt automatiskt efteråt.
 *   2. Inloggad men redan har ett team → bekräfta bytet innan vi kör.
 *   3. Inloggad, inget team → acceptera direkt.
 */
export default function JoinPage() {
  const params = useParams<{ code: string }>();
  const router = useRouter();
  const { user, userDoc, loading, refreshUserDoc } = useAuth();

  const [status, setStatus] = useState<Status>("checking");
  const [error, setError] = useState<string | null>(null);

  const code = (params.code ?? "").toUpperCase();

  useEffect(() => {
    if (loading || !user) return;

    if (status === "checking") {
      if (userDoc?.teamId) {
        setStatus("confirm-switch");
      } else {
        void accept();
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, user, userDoc]);

  async function accept() {
    setStatus("accepting");
    setError(null);
    try {
      await acceptInvite(code);
      await refreshUserDoc();
      setStatus("success");
      router.replace("/");
    } catch (err) {
      setStatus("error");
      setError(mapAcceptError(err));
    }
  }

  if (loading) {
    return <Centered>Laddar…</Centered>;
  }

  if (!user) {
    return (
      <div>
        <div className="mx-auto max-w-sm px-6 pt-10 text-center">
          <p className="mb-1 text-sm font-semibold uppercase tracking-wide text-rose-500">Inbjudan</p>
          <p className="text-stone-500">Logga in eller skapa ett konto för att gå med i familjen.</p>
        </div>
        <LoginForm />
      </div>
    );
  }

  if (status === "confirm-switch") {
    return (
      <Centered>
        <h1 className="mb-2 text-xl font-bold text-stone-800">Byta familj?</h1>
        <p className="mb-6 text-stone-500">
          Du tillhör redan en familj i Varannan. Om du fortsätter lämnar du den och går med i den nya familjen istället.
        </p>
        <button onClick={accept} className="mb-3 w-full rounded-full bg-rose-500 py-3 font-semibold text-white">
          Gå med i den nya familjen
        </button>
        <button onClick={() => router.replace("/")} className="w-full py-2 text-sm text-stone-400">
          Avbryt
        </button>
      </Centered>
    );
  }

  if (status === "accepting" || status === "checking") {
    return <Centered>Ansluter dig till familjen…</Centered>;
  }

  if (status === "error") {
    return (
      <Centered>
        <h1 className="mb-2 text-xl font-bold text-stone-800">Kunde inte ansluta</h1>
        <p className="mb-6 text-stone-500">{error}</p>
        <button onClick={accept} className="mb-3 w-full rounded-full bg-rose-500 py-3 font-semibold text-white">
          Försök igen
        </button>
        <button onClick={() => router.replace("/")} className="w-full py-2 text-sm text-stone-400">
          Till startsidan
        </button>
      </Centered>
    );
  }

  return <Centered>Klart! Skickar dig vidare…</Centered>;
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto flex min-h-screen max-w-sm flex-col justify-center px-6 text-center">{children}</div>
  );
}

function mapAcceptError(err: unknown): string {
  const code = (err as { code?: string })?.code ?? "";
  if (code === "functions/failed-precondition") {
    return "Koden är ogiltig eller har gått ut. Be den andra föräldern skapa en ny inbjudan.";
  }
  return "Något gick fel. Försök igen om en stund.";
}
