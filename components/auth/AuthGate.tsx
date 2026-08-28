"use client";

import { ReactNode } from "react";
import { usePathname } from "next/navigation";
import { useAuth } from "../../lib/auth/AuthProvider";
import LoginForm from "./LoginForm";
import OnboardingFlow from "../onboarding/OnboardingFlow";
import { createFamilyTeam, createInvite, addChild } from "../../lib/onboardingClient";

/**
 * Ligger överst i app/layout.tsx (innanför <AuthProvider>).
 *
 *   1. Inte inloggad        → LoginForm
 *   2. Inloggad, inget team → OnboardingFlow
 *   3. Inloggad, har team   → appen (app/page.tsx tar över och visar
 *                             rätt uppsättningsskärm om något saknas)
 *
 * AuthGate beslutar ALLTSÅ bara utifrån teamId. Resten — saknat barn,
 * saknad andra förälder, saknat schema — hanteras i app/page.tsx, som
 * har lyssnarna. Tidigare låg den logiken bara som en återvändsgränd
 * med en utloggningsknapp.
 *
 * Undantag: /join/[code] hanterar sitt eget flöde, eftersom man kan bli
 * inbjuden innan man har ett konto.
 */
export default function AuthGate({ children }: { children: ReactNode }) {
  const { user, userDoc, loading, refreshUserDoc } = useAuth();
  const pathname = usePathname();

  if (pathname?.startsWith("/join/")) {
    return <>{children}</>;
  }

  if (loading) {
    return <div className="grid min-h-screen place-items-center text-stone-400">Laddar…</div>;
  }

  if (!user) {
    return <LoginForm />;
  }

  if (!userDoc?.teamId) {
    return (
      <OnboardingFlow
        currentUserName={user.displayName ?? "Du"}
        onCreateTeam={createFamilyTeam}
        onAddChild={addChild}
        onCreateInvite={createInvite}
        onFinish={refreshUserDoc}
      />
    );
  }

  return <>{children}</>;
}
