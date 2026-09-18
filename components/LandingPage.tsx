"use client";

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
 */
export default function LandingPage({ onLogin }: { onLogin: () => void }) {
  return (
    <div className="mx-auto flex min-h-screen max-w-lg flex-col justify-center px-6 py-16">
      <h1 className="mb-3 text-4xl font-bold text-stone-800">Varannan</h1>
      <p className="mb-8 text-lg leading-relaxed text-stone-600">
        En delad kalender för föräldrar som samarbetar kring vårdnad och barnpassning. Se vems
        tur det är, föreslå ansvarsbyten, och håll koll på aktiviteter — på ett ställe båda
        hushållen kommer åt.
      </p>

      <ul className="mb-10 space-y-3 text-stone-600">
        <Feature text="Ett gemensamt schema, synligt för båda föräldrarna" />
        <Feature text="Föreslå och godkänn ansvarsbyten utan krångel" />
        <Feature text="Synk till Google Kalender, Apple Kalender eller Outlook" />
        <Feature text="Mail- och pushpåminnelser inför varje överlämning" />
      </ul>

      <button
        onClick={onLogin}
        className="w-full rounded-full bg-rose-500 py-3 font-semibold text-white hover:bg-rose-600"
      >
        Logga in
      </button>

      <a href="/integritetspolicy" className="mt-6 text-center text-sm text-stone-400 underline">
        Integritetspolicy
      </a>
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
