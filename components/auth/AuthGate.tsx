"use client";

import { ReactNode, useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { useAuth } from "../../lib/auth/AuthProvider";
import { useIsStandalone } from "../../lib/useIsStandalone";
import LoginForm from "./LoginForm";
import LandingPage from "../LandingPage";
import OnboardingFlow from "../onboarding/OnboardingFlow";
import RelativeHome from "../RelativeHome";
import {
  createFamilyTeam,
  createInvite,
  addChild,
  saveCustodyCycle,
  getMyCalendars,
  MyCalendar,
} from "../../lib/onboardingClient";

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
 *       anhörig/utomstående (etapp 2/3, docs/roller-och-medlemskap.md)
 *       → RelativeHome, en egen enklare vy. En anhörig får ALDRIG
 *       users/{uid}.teamId satt (kan höra till flera familjer), så
 *       "inget team" betyder INTE längre automatiskt "ny användare".
 *   3. Inloggad, har team   → appen (app/page.tsx tar över och visar
 *                             rätt uppsättningsskärm om något saknas).
 *   3b. Inloggad, har team, OCH är anhörig/utomstående på minst en
 *       ANNAN familjs kalender (t.ex. en förälder i sin egen familj
 *       som blivit inbjuden nån annanstans) — en liten växlare ovanpå
 *       appen låter en hoppa in i RelativeHome för den kalendern och
 *       tillbaka igen. Utan den var de kalendrarna helt osynliga —
 *       en riktig testanvändare vars konto redan hade ett team
 *       (av misstag, se docs/roller-och-medlemskap.md) kunde annars
 *       ALDRIG se en kalender hen blivit inbjuden till.
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

  // getMyCalendars() svarar på "vilka kalendrar är jag med på, i ALLA
  // familjer" — behövs både för konton UTAN eget team (2b ovan) och
  // för konton MED ett eget team som ÄVEN är anhörig/utomstående
  // någon annanstans (3b ovan). null = inte kollat än, [] = kollat,
  // inga träffar.
  const [myCalendars, setMyCalendars] = useState<MyCalendar[] | null>(null);
  // Vilken FRÄMMANDE kalender (inte hem-teamet) som just nu visas via
  // växlaren, om någon. Nollställs inte automatiskt av att man byter
  // sida — bara av den uttryckliga "Tillbaka"-knappen i RelativeHome.
  const [viewingForeign, setViewingForeign] = useState<MyCalendar | null>(null);

  useEffect(() => {
    // /join gör sin egen sak (se app/join/page.tsx) — ingen anledning
    // att göra samma uppslag två gånger.
    if (!user || pathname?.startsWith("/join")) {
      setMyCalendars(null);
      return;
    }
    let cancelled = false;
    getMyCalendars()
      .then((cals) => {
        if (!cancelled) setMyCalendars(cals);
      })
      .catch(() => {
        // Ovanligt fel (nätverk, ej inloggad ännu på servern) — anta
        // inga kalendrar hellre än att fastna i "laddar" för alltid.
        // En riktig ny användare (utan eget team) hamnar då i
        // onboardingen, vilket är rätt fallback för den vanliga vägen.
        if (!cancelled) setMyCalendars([]);
      });
    return () => {
      cancelled = true;
    };
  }, [user, pathname]);

  const foreignCalendars = (myCalendars ?? []).filter((c) => c.teamId !== userDoc?.teamId);

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
    if (foreignCalendars.length > 0) {
      return <RelativeHome calendars={foreignCalendars} />;
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

  // Har ett eget team OCH är anhörig/utomstående på minst en annan
  // familjs kalender — låt växlaren styra vilket som visas.
  if (viewingForeign) {
    return <RelativeHome calendars={[viewingForeign]} onBack={() => setViewingForeign(null)} />;
  }
  if (foreignCalendars.length > 0) {
    return (
      <>
        <div className="mx-auto max-w-md px-4 pt-3">
          <div className="rounded-xl bg-rose-50 px-3 py-2 text-xs text-rose-700">
            Du är också{" "}
            {foreignCalendars.map((c, i) => (
              <span key={`${c.teamId}:${c.childId}`}>
                {i > 0 && ", "}
                {c.role === "viewer" ? "utomstående" : "anhörig"} hos{" "}
                <button onClick={() => setViewingForeign(c)} className="font-semibold underline underline-offset-2">
                  {c.childName}
                </button>
              </span>
            ))}
            .
          </div>
        </div>
        {children}
      </>
    );
  }

  return <>{children}</>;
}
