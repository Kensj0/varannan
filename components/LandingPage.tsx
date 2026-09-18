"use client";

import LandingCarousel from "./LandingCarousel";

/**
 * Publik hemsida, visas för webbläsarbesökare som inte är inloggade
 * (se AuthGate.tsx). Krävs av Google Clouds branding-granskning för
 * OAuth: hemsidan (/) måste gå att se utan inloggning och förklara
 * vad appen faktiskt gör — annars nekas publiceringen.
 *
 * Den som har appen installerad på hemskärmen ser ALDRIG den här
 * sidan (useIsStandalone skickar dem rakt till LoginForm/appen som
 * innan). Det är alltså bara en dörr för nya besökare i en vanlig
 * webbläsarflik.
 *
 * Layout: en kolumn på mobil (rubrik → carousel → funktionslista),
 * två kolumner sida vid sida från md och uppåt — annars klumpade sig
 * allt i en smal pelare längst upp till vänster på breda skärmar.
 * "Logga in" ligger FAST i botten av skärmen på mobil (fixed, inte
 * sticky) så den syns direkt utan att scrolla ner förbi carousellen
 * och funktionslistan — på desktop, där allt normalt får plats i
 * höjdled ändå, ligger samma knapp inline i textkolumnen i stället.
 */
export default function LandingPage({ onLogin }: { onLogin: () => void }) {
  return (
    <div className="min-h-screen bg-white md:flex md:min-h-screen md:items-center">
      <div className="mx-auto flex max-w-5xl flex-col px-6 pb-32 pt-10 md:grid md:w-full md:grid-cols-2 md:items-center md:gap-16 md:px-10 md:py-16 md:pb-16">
        <div className="flex flex-col">
          <h1 className="mb-3 text-4xl font-bold text-stone-800 md:text-5xl">Varannan</h1>
          <p className="mb-6 text-lg leading-relaxed text-stone-600">
            En delad kalender för föräldrar som samarbetar kring vårdnad och barnpassning. Se
            vems tur det är, föreslå ansvarsbyten, och håll koll på aktiviteter — på ett ställe
            båda hushållen kommer åt.
          </p>

          <ul className="hidden space-y-3 text-stone-600 md:block">
            <Feature text="Ett gemensamt schema, synligt för båda föräldrarna" />
            <Feature text="Föreslå och godkänn ansvarsbyten utan krångel" />
            <Feature text="Synk till Google Kalender, Apple Kalender eller Outlook" />
            <Feature text="Mail- och pushpåminnelser inför varje överlämning" />
          </ul>

          <button
            onClick={onLogin}
            className="mt-8 hidden w-full max-w-xs rounded-full bg-rose-500 py-3 font-semibold text-white hover:bg-rose-600 md:block"
          >
            Logga in
          </button>
          <a
            href="/integritetspolicy"
            className="mt-4 hidden text-sm text-stone-400 underline md:block"
          >
            Integritetspolicy
          </a>
        </div>

        <div className="mt-8 flex justify-center md:mt-0">
          <LandingCarousel />
        </div>

        <ul className="mt-8 space-y-3 text-stone-600 md:hidden">
          <Feature text="Ett gemensamt schema, synligt för båda föräldrarna" />
          <Feature text="Föreslå och godkänn ansvarsbyten utan krångel" />
          <Feature text="Synk till Google Kalender, Apple Kalender eller Outlook" />
          <Feature text="Mail- och pushpåminnelser inför varje överlämning" />
        </ul>
      </div>

      {/*
        Fast i botten, bara på mobil (md:hidden) — desktop har redan
        knappen inline i textkolumnen ovan. safe-area-inset-bottom
        håller den ovanför hemknappsindikatorn på iPhone.
      */}
      <div
        className="fixed inset-x-0 bottom-0 border-t border-stone-100 bg-white/95 px-6 pt-3 backdrop-blur md:hidden"
        style={{ paddingBottom: "max(0.75rem, env(safe-area-inset-bottom))" }}
      >
        <button
          onClick={onLogin}
          className="w-full rounded-full bg-rose-500 py-3 font-semibold text-white hover:bg-rose-600"
        >
          Logga in
        </button>
        <a href="/integritetspolicy" className="mt-2 block text-center text-xs text-stone-400 underline">
          Integritetspolicy
        </a>
      </div>
    </div>
  );
}

function Feature({ text }: { text: string }) {
  return (
    <li className="flex items-start gap-2">
      <span className="mt-0.5 text-rose-500">✓</span>
      <span>{text}</span>
    </li>
  );
}
