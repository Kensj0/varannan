import type { Metadata } from "next";

// Egen metadata-titel för den här sidan, i stället för rootens
// "Varannan" — den ska gå att hitta och kännas igen för sig själv,
// eftersom Google Cloud Console länkar hit vid OAuth-granskningen.
export const metadata: Metadata = {
  title: "Integritetspolicy / Privacy Policy — Varannan",
};

/**
 * Publik sida, undantagen inloggningskravet i AuthGate.tsx. Krävs för
 * att publicera OAuth-appen i Google Cloud Console.
 *
 * Håll innehållet i synk med vad appen FAKTISKT gör. Varje påstående
 * under "Hur vi skyddar din information" måste vara sant:
 *  - Barninfo/konton skyddas av firestore.rules: läsning för
 *    parent+relative (canViewCalendarContent), skrivning bara parent
 *    (isParentOfCalendar). Ändras det — ändra texten nedan också.
 *  - Google-token för kalendersynk får ALDRIG gå att läsa från
 *    klienten — lagra den där regler säger `allow read, write: if false`
 *    (eller i Secret Manager) och läs den bara i Cloud Functions.
 *  - Kopplar användaren bort Google ska token raderas och token
 *    återkallas hos Google.
 * Ändras något av detta måste texten ändras samtidigt.
 *
 * Engelska versionen finns för Googles granskare (Trust & Safety).
 */
export default function PrivacyPolicyPage() {
  return (
    <main className="mx-auto min-h-screen max-w-2xl px-6 py-12 text-stone-700">
      <h1 className="mb-2 text-2xl font-bold text-stone-900">Integritetspolicy</h1>
      <p className="mb-2 text-sm text-stone-400">Senast uppdaterad: 1 oktober 2026</p>
      <p className="mb-8 text-sm">
        <a className="underline" href="#english">English version below</a>
      </p>

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
          <li>Namn och e-postadress, för inloggning och för att koppla ihop dig med rätt kalender</li>
          <li>Schemadata du själv lägger in: ansvarsblock, aktiviteter, bytesförfrågningar, packlistor, anteckningar och att göra-listor</li>
          <li>Chattmeddelanden mellan föräldrarna</li>
          <li>
            Barninformation som föräldrarna själva väljer att fylla i, till exempel
            personnummer, passnummer, medicinsk information och inloggningar till barnets
            tjänster
          </li>
          <li>Notisinställningar, och den mailadress eller enhet notiser skickas till</li>
        </ul>
      </Section>

      <Section title="Vem som ser din information">
        <p>
          Varje kalender delas bara med de personer föräldrarna bjudit in till just den
          kalendern. Det finns tre roller:
        </p>
        <ul className="list-disc space-y-1 pl-5">
          <li><strong>Förälder</strong> — ser allt i kalendern.</li>
          <li>
            <strong>Anhörig</strong> — ser schema, aktiviteter, listor och barninformation,
            men kan inte ändra barninformationen och ser inte chatten.
          </li>
          <li><strong>Utomstående</strong> — ser bara schemat och aktiviteterna.</li>
        </ul>
        <p>
          En anhörig eller utomstående kan bara bjudas in om alla föräldrar i kalendern har
          godkänt det. Vi säljer inte din information och delar den inte med tredje part i
          marknadsföringssyfte.
        </p>
      </Section>

      <Section title="Hur vi skyddar din information">
        <ul className="list-disc space-y-1 pl-5">
          <li>
            <strong>Kryptering under överföring:</strong> all trafik mellan appen och våra
            servrar går över HTTPS/TLS.
          </li>
          <li>
            <strong>Kryptering i lagring:</strong> all data lagras i Google Cloud (Firebase),
            där den krypteras automatiskt när den sparas.
          </li>
          <li>
            <strong>Behörighetskontroll på servern:</strong> vem som får läsa och skriva vad
            avgörs av säkerhetsregler som körs på servern, inte bara av vad appen visar. En
            person som inte är medlem i en kalender kan inte läsa något ur den, även om hen
            skulle försöka gå förbi appen.
          </li>
          <li>
            <strong>Extra skydd för känslig barninformation:</strong> personnummer,
            passnummer, medicinsk information och inloggningar kan bara ändras av barnets
            föräldrar, och bara läsas av föräldrar och anhöriga som föräldrarna gemensamt
            bjudit in — aldrig av utomstående eller av någon utanför kalendern. Uppgifterna är
            inte sökbara i databasen.
          </li>
          <li>
            <strong>Åtkomsttoken till Google:</strong> lagras på serversidan på ett ställe som
            appen i webbläsaren aldrig kan läsa, och används bara av våra servrar för att
            skriva till din Varannan-kalender i Google.
          </li>
          <li>
            <strong>Begränsad administratörsåtkomst:</strong> bara utvecklaren av Varannan
            har administrativ åtkomst till systemet, och använder den enbart för drift,
            felsökning och support när du bett om det.
          </li>
          <li>
            <strong>Säkerhetskopior:</strong> databasen säkerhetskopieras till skyddad
            lagring i Google Cloud, med samma behörighetsbegränsning.
          </li>
        </ul>
      </Section>

      <Section title="Google-inloggning och Google Kalender">
        <p>
          Loggar du in med Google får vi ditt namn och din e-postadress från Google, på samma
          sätt som vid vilken Google-inloggning som helst.
        </p>
        <p>
          Väljer du att koppla ditt Google-konto för kalendersynk ber vi dessutom om åtkomst
          till Google Kalender. Den åtkomsten används enbart för att skapa, uppdatera och ta
          bort händelser i egna, separata kalendrar som Varannan skapar i ditt Google-konto
          — en per barn — med dina ansvarsblock och aktiviteter från Varannan. Vi läser inte,
          ändrar inte och tar inte bort dina övriga kalendrar eller händelser.
        </p>
        <p>
          Du kan koppla bort ett enskilt barns kalender för sig, eller hela Google-kopplingen
          på en gång — kopplar du bort det sista barnet räknas det som att hela kopplingen tas
          bort. Oavsett vilket raderar vi din åtkomsttoken för det som kopplas bort och drar
          tillbaka åtkomsten hos Google. Du kan också dra tillbaka åtkomsten när som helst
          under ditt Google-konto.
        </p>
        <p>
          Varannans användning och överföring av information som tas emot från Googles API:er
          följer{" "}
          <a
            className="underline"
            href="https://developers.google.com/terms/api-services-user-data-policy"
          >
            Google API Services User Data Policy
          </a>
          , inklusive kraven på begränsad användning (Limited Use). Data från Google används
          inte för reklam, säljs inte, används inte för att träna AI-modeller och läses inte
          av människor.
        </p>
      </Section>

      <Section title="Mailpåminnelser och notiser">
        <p>
          Slår du på mailpåminnelser skickar vi påminnelser om kommande ansvarsbyten till den
          mailadress som är kopplad till ditt konto. Pushnotiser skickas till de enheter du
          själv aktiverat dem på. Mailadressen och enhetens notisadress används inte till
          något annat.
        </p>
      </Section>

      <Section title="Hur länge vi sparar informationen">
        <p>
          Så länge kontot är aktivt. Vill du ta bort ditt konto och all tillhörande data,
          kontakta oss på adressen nedan så raderar vi den.
        </p>
      </Section>

      <Section title="Kontakt">
        <p>
          Frågor om den här policyn eller din data:{" "}
          <a className="underline" href="mailto:kenny.sjostedt@gmail.com">
            kenny.sjostedt@gmail.com
          </a>
          .
        </p>
      </Section>

      <hr className="my-10 border-stone-200" />

      <div id="english">
        <h1 className="mb-2 text-2xl font-bold text-stone-900">Privacy Policy</h1>
        <p className="mb-8 text-sm text-stone-400">Last updated: October 1, 2026</p>

        <Section title="What Varannan is">
          <p>
            Varannan is a shared calendar for parents who co-parent. It helps separated
            parents keep track of custody schedules, handovers and children&apos;s activities
            across households.
          </p>
        </Section>

        <Section title="Information we collect">
          <ul className="list-disc space-y-1 pl-5">
            <li>Name and email address, for sign-in and to connect you to the right calendar</li>
            <li>Schedule data you enter: custody blocks, activities, swap requests, packing lists, notes and to-dos</li>
            <li>Chat messages between parents</li>
            <li>
              Child information that parents choose to enter, such as national ID number,
              passport number, medical information and logins to the child&apos;s services
            </li>
            <li>Notification settings, and the email address or device notifications are sent to</li>
          </ul>
        </Section>

        <Section title="Who can see your information">
          <p>
            Each calendar is shared only with people the parents have invited to that
            calendar. There are three roles: <strong>Parent</strong> (sees everything),{" "}
            <strong>Relative</strong> (sees schedule, activities, lists and child
            information, but cannot edit child information and cannot see chat), and <strong>Viewer</strong> (sees schedule and activities
            only). A relative or viewer can only be invited after every parent of the
            calendar has approved. We do not sell your information or share it with third
            parties for marketing.
          </p>
        </Section>

        <Section title="How we protect your data">
          <ul className="list-disc space-y-1 pl-5">
            <li>
              <strong>Encryption in transit:</strong> all traffic between the app and our
              servers uses HTTPS/TLS.
            </li>
            <li>
              <strong>Encryption at rest:</strong> all data is stored in Google Cloud
              (Firebase), where it is automatically encrypted when stored.
            </li>
            <li>
              <strong>Server-side access control:</strong> who may read and write what is
              enforced by security rules running on the server, not only by the app&apos;s user
              interface. A person who is not a member of a calendar cannot read anything from
              it, even if they try to bypass the app.
            </li>
            <li>
              <strong>Additional protection for sensitive child data:</strong> national ID
              numbers, passport numbers, medical information and logins can only be edited by
              the child&apos;s parents, and only read by the parents and by relatives that all
              parents jointly invited — never by viewers or anyone outside the calendar. These
              fields are not searchable in the database.
            </li>
            <li>
              <strong>Google access tokens:</strong> stored server-side in a location the
              app running in the browser can never read, and used only by our servers to
              write to your Varannan calendar in Google.
            </li>
            <li>
              <strong>Restricted administrative access:</strong> only the developer of
              Varannan has administrative access to the system, used solely for operations,
              troubleshooting, and support you have requested.
            </li>
            <li>
              <strong>Backups:</strong> the database is backed up to protected storage in
              Google Cloud with the same access restrictions.
            </li>
          </ul>
        </Section>

        <Section title="Google Sign-In and Google Calendar">
          <p>
            If you sign in with Google, we receive your name and email address from Google.
          </p>
          <p>
            If you choose to connect your Google account for calendar sync, we also request
            access to Google Calendar. This access is used only to create, update and delete
            events in separate, dedicated calendars that Varannan creates in your Google
            account — one per child — containing your custody blocks and activities from
            Varannan. We do not read, modify or delete any of your other calendars or events.
          </p>
          <p>
            You can disconnect a single child&apos;s calendar on its own, or the entire Google
            connection at once — disconnecting the last remaining child is treated as
            disconnecting the whole connection. Either way, we delete the access token for
            whatever is disconnected and revoke the access with Google. You can also revoke
            access at any time from your Google Account.
          </p>
          <p>
            Varannan&apos;s use and transfer to any other app of information received from
            Google APIs will adhere to the{" "}
            <a
              className="underline"
              href="https://developers.google.com/terms/api-services-user-data-policy"
            >
              Google API Services User Data Policy
            </a>
            , including the Limited Use requirements. Google user data is not used for
            advertising, is not sold, is not used to train AI models, and is not read by
            humans.
          </p>
        </Section>

        <Section title="Email reminders and notifications">
          <p>
            If you enable email reminders, we send reminders about upcoming handovers to the
            email address on your account. Push notifications are sent only to devices where
            you enabled them. These addresses are not used for anything else.
          </p>
        </Section>

        <Section title="Data retention and deletion">
          <p>
            We keep your data for as long as your account is active. To delete your account
            and all associated data, contact us at the address below and we will delete it.
          </p>
        </Section>

        <Section title="Contact">
          <p>
            Questions about this policy or your data:{" "}
            <a className="underline" href="mailto:kenny.sjostedt@gmail.com">
              kenny.sjostedt@gmail.com
            </a>
            .
          </p>
        </Section>
      </div>
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
