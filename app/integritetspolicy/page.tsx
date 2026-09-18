import type { Metadata } from "next";

// Egen metadata-titel för den här sidan, i stället för rootens
// "Varannan" — den ska gå att hitta och kännas igen för sig själv,
// eftersom Google Cloud Console länkar hit vid OAuth-granskningen.
export const metadata: Metadata = {
  title: "Integritetspolicy — Varannan",
};

/**
 * Publik sida, undantagen inloggningskravet i AuthGate.tsx. Krävs för
 * att publicera OAuth-appen i Google Cloud Console (Homepage/Privacy
 * policy-länkarna på consent screen måste peka på en riktig sida som
 * går att nå utan inloggning).
 *
 * Håll innehållet i synk med vad appen FAKTISKT gör — särskilt
 * OAuth-scopes-avsnittet, som ändras när Google Calendar-synken (se
 * functions/src/index.ts: exportEventToGoogleCalendar) går från
 * skelett till färdig funktion.
 */
export default function PrivacyPolicyPage() {
  return (
    <main className="mx-auto min-h-screen max-w-2xl px-6 py-12 text-stone-700">
      <h1 className="mb-2 text-2xl font-bold text-stone-900">Integritetspolicy</h1>
      <p className="mb-8 text-sm text-stone-400">Senast uppdaterad: 18 september 2026</p>

      <Section title="Vad Varannan är">
        <p>
          Varannan är en delad kalender för föräldrar som samarbetar kring vårdnad och
          barnpassning. Den hjälper till att hålla koll på schema, ansvarsbyten och
          aktiviteter mellan hushållen.
        </p>
      </Section>

      <Section title="Vilken information vi samlar in">
        <p>När du använder Varannan lagrar vi:</p>
        <ul className="list-disc space-y-1 pl-5">
          <li>Namn och e-postadress, för inloggning och för att koppla ihop dig med rätt familj</li>
          <li>Schemadata du själv lägger in: ansvarsblock, aktiviteter, bytesförfrågningar</li>
          <li>Notisinställningar, och den mailadress eller enhet notiser skickas till</li>
        </ul>
      </Section>

      <Section title="Google-inloggning och Google Kalender">
        <p>
          Loggar du in med Google får vi ditt namn och din e-postadress från Google, på samma
          sätt som vid vilken Google-inloggning som helst.
        </p>
        <p>
          Väljer du att koppla ditt Google-konto för kalendersynk ber vi dessutom om åtkomst
          till Google Kalender. Den åtkomsten används enbart för att skapa och uppdatera
          händelser i en egen, separat kalender i ditt Google-konto — dina ansvarsblock och
          aktiviteter från Varannan, inte tvärtom. Vi läser inte och rör inte dina övriga
          kalendrar eller händelser.
        </p>
        <p>
          Åtkomsttoken för detta lagras säkert i Google Cloud Secret Manager, aldrig i vår
          vanliga databas. Du kan när som helst dra tillbaka åtkomsten under ditt Google-konto,
          eller koppla bort den i Varannans inställningar.
        </p>
      </Section>

      <Section title="Mailpåminnelser">
        <p>
          Slår du på mailpåminnelser skickar vi påminnelser om kommande ansvarsbyten till den
          mailadress som är kopplad till ditt konto. Mailadressen används inte till något annat.
        </p>
      </Section>

      <Section title="Vem som ser din information">
        <p>
          Schemadata delas bara med de andra föräldrarna och vårdnadshavarna i samma familj i
          Varannan. Vi säljer inte och delar inte din information med tredje part i
          marknadsföringssyfte.
        </p>
      </Section>

      <Section title="Hur länge vi sparar informationen">
        <p>
          Så länge kontot är aktivt. Vill du ta bort ditt konto och all tillhörande data,
          kontakta oss på adressen nedan.
        </p>
      </Section>

      <Section title="Kontakt">
        <p>
          Frågor om den här policyn eller din data: <a className="underline" href="mailto:kenny.sjostedt@gmail.com">kenny.sjostedt@gmail.com</a>.
        </p>
      </Section>
    </main>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mb-6">
      <h2 className="mb-2 text-lg font-semibold text-stone-800">{title}</h2>
      <div className="space-y-2 text-sm leading-relaxed">{children}</div>
    </section>
  );
}
