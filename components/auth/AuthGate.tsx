"use client";

import { ReactNode, useState } from "react";
import { usePathname } from "next/navigation";
import { useAuth } from "../../lib/auth/AuthProvider";
import { useIsStandalone } from "../../lib/useIsStandalone";
import LoginForm from "./LoginForm";
import LandingPage from "../LandingPage";
import OnboardingFlow from "../onboarding/OnboardingFlow";
import { createFamilyTeam, createInvite, addChild, saveCustodyCycle } from "../../lib/onboardingClient";

/**
 * Ligger överst i app/layout.tsx (innanför <AuthProvider>).
 *
 *   1. Inte inloggad, öppnad i webbläsare  → LandingPage (publik,
 *      förklarar appen), "Logga in" tar till LoginForm
 *   1b. Inte inloggad, öppnad som installerad PWA → LoginForm direkt,
 *      som innan — den som redan installerat appen ska rakt in,
 *      inte se en säljande hemsida varje gång
 *   2. Inloggad, inget team → OnboardingFlow
 *   3. Inloggad, har team   → appen (app/page.tsx tar över och visar
 *                             rätt uppsättningsskärm om något saknas)
 *
 * Landningssidan finns för Google Clouds branding-granskning inför
 * OAuth-publicering: den kräver att hemsidan (/) går att se utan
 * inloggning och förklarar appens syfte. Se LandingPage.tsx och
 * useIsStandalone.ts för varför PWA-installationen är undantagen.
 *
 * AuthGate beslutar ALLTSÅ bara utifrån teamId (plus standalone-läge
 * för landningssidan). Resten — saknat barn, saknad andra förälder,
 * saknat schema — hanteras i app/page.tsx, som har lyssnarna. Tidigare
 * låg den logiken bara som en återvändsgränd med en utloggningsknapp.
 *
 * Undantag: /join och /integritetspolicy hanterar sig själva utanför
 * inloggningskravet — /join eftersom man kan bli inbjuden innan man
 * har ett konto, /integritetspolicy eftersom Google (OAuth-granskning)
 * och besökare måste kunna läsa den utan att logga in.
 */
export default function AuthGate({ children }: { children: ReactNode }) {
  const { user, userDoc, loading, refreshUserDoc } = useAuth();
  const pathname = usePathname();
  const standalone = useIsStandalone();
  // Klick på "Logga in" på landningssidan — därefter beter sig allt
  // som innan (LoginForm). Nollställs inte tillbaka: den som en gång
  // bett om inloggningsformuläret ska inte kastas tillbaka till
  // säljtexten av ett omrender.
  const [wantsLogin, setWantsLogin] = useState(false);

  if (pathname === "/join" || pathname === "/integritetspolicy") {
    return <>{children}</>;
  }

  // standalone === null bara under den allra första klient-rendern,
  // innan matchMedia hunnit köra — samma korta skärm som auth-laddning
  // redan visar, så det blir ingen synlig blinkning mellan lägena.
  if (loading || standalone === null) {
    return <div className="grid min-h-screen place-items-center text-stone-400">Laddar…</div>;
  }

  if (!user) {
    if (!standalone && !wantsLogin) {
      return <LandingPage onLogin={() => setWantsLogin(true)} />;
    }
    return <LoginForm />;
  }

  if (!userDoc?.teamId) {
    return (
      <OnboardingFlow
        currentUserName={user.displayName ?? "Du"}
        currentUserUid={user.uid}
        onCreateTeam={createFamilyTeam}
        onAddChild={addChild}
        onSetupCycle={async (teamId, childId, blocks, cycleStartDate, switchHour) => {
          await saveCustodyCycle({
            teamId,
            childId,
            blocks,
            cycleStartDate,
            switchHour,
            referenceParentId: user.uid,
          });
        }}
        onCreateInvite={createInvite}
        onFinish={refreshUserDoc}
      />
    );
  }

  return <>{children}</>;
}
