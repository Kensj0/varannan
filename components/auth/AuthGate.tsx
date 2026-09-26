"use client";

import { ReactNode, useState } from "react";
import { usePathname } from "next/navigation";
import { useAuth } from "../../lib/auth/AuthProvider";
import { useIsStandalone } from "../../lib/useIsStandalone";
import { useMyCalendars } from "../../lib/hooks/useMyCalendars";
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
 *   2. Inloggad, inget team, inga kalendrar via getMyCalendars → OnboardingFlow
 *   2b. Inloggad, inget team, MEN medlem av minst en kalender som
 *       anhörig/utomstående → appen (app/page.tsx), som väljer en
 *       av de kalendrarna som aktiv och visar SAMMA UI som en
 *       förälder, bara med vissa funktioner avstängda beroende på
 *       rollen där. En anhörig får ALDRIG users/{uid}.teamId satt
 *       (kan höra till flera familjer), så "inget team" betyder INTE
 *       längre automatiskt "ny användare" — se
 *       docs/roller-och-medlemskap.md.
 *   3. Inloggad, har team   → appen (app/page.tsx tar över, äger nu
 *                             ALL logik för vilken kalender som visas
 *                             och vilken roll man har där — inklusive
 *                             att växla till en annan familjs kalender
 *                             via "+"-väljaren, om man är med på fler).
 *
 * Landningssidan finns för Google Clouds branding-granskning inför
 * OAuth-publicering: den kräver att hemsidan (/) går att se utan
 * inloggning och förklarar appens syfte. Se LandingPage.tsx och
 * useIsStandalone.ts för varför PWA-installationen är undantagen.
 *
 * AuthGate beslutar ALLTSÅ bara om det ska bli onboarding eller appen
 * (plus standalone-läge för landningssidan). Resten — vilken kalender,
 * vilken roll, saknat barn, saknad andra förälder, saknat schema —
 * hanteras i app/page.tsx, som har lyssnarna.
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

  // /join gör sin egen sak (se app/join/page.tsx) — ingen anledning att
  // göra samma uppslag där. null = inte kollat än, [] = kollat, inga
  // träffar.
  const { calendars: myCalendars } = useMyCalendars(
    user && !pathname?.startsWith("/join") ? user.uid : null
  );

  // startsWith i stället för exakt match: en anhörig/utomstående som
  // klickar en inbjudningslänk ska ALDRIG kunna hamna i "skapa din
  // första kalender"-onboardingen bara för att pathname råkar avvika
  // från "/join" (t.ex. trailing slash) — det slog en riktig
  // testanvändare, se docs/roller-och-medlemskap.md.
  if (pathname?.startsWith("/join") || pathname?.startsWith("/integritetspolicy")) {
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
    // Vänta på kalender-koll INNAN vi bestämmer — annars blinkar
    // OnboardingFlow till för en anhörig som faktiskt har kalendrar.
    if (myCalendars === null) {
      return <div className="grid min-h-screen place-items-center text-stone-400">Laddar…</div>;
    }
    if (myCalendars.length > 0) {
      return <>{children}</>;
    }
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
