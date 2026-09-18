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
 * Layout: två kolumner sida vid sida från md och uppåt (text till
 * vänster, carousel till höger, vertikalt centrerat) — annars
 * klumpade sig allt i en smal pelare uppe till vänster på breda
 * skärmar.
 *
 * På mobil ligger "Logga in" INLINE, direkt under rubriken/ingressen,
 * i stället för fast i botten av skärmen (fixed bottom). Ett fixed-
 * element var i teorin alltid synligt, men position:fixed är känt
 * opålitligt på mobilwebbläsare — särskilt iOS Safari, vars
 * adressfält visas/döljs dynamiskt och kan räkna fixed-element mot
 * en annan (dold) viewport-höjd än den faktiskt synliga. Resultatet
 * var att knappen krävde lång nedscrollning och ändå hamnade utanför
 * synfältet. En knapp i det VANLIGA dokumentflödet, placerad så högt
 * att den ryms i första skärmvyn på i stort sett alla mobiler
 * (verifierat ner till iPhone SE, 375×667), har inga sådana
 * plattformskvirkigheter att lita på.
 */
export default function LandingPage({ onLogin }: { onLogin: () => void }) {
  return (
    <div className="min-h-screen bg-white md:flex md:min-h-screen md:items-center">
      <div className="mx-auto flex max-w-5xl flex-col px-6 py-10 md:grid md:w-full md:grid-cols-2 md:items-center md:gap-16 md:px-10 md:py-16">
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
            className="mt-2 w-full rounded-full bg-rose-500 py-3 font-semibold text-white hover:bg-rose-600 md:mt-8 md:w-full md:max-w-xs"
          >
            Logga in
          </button>
          <a href="/integritetspolicy" className="mt-4 text-center text-sm text-stone-400 underline md:text-left">
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
