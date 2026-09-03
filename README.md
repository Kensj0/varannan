# Varannan

En app för separerade föräldrar som delar på vårdnaden. Den svarar på
frågan som annars kräver ett sms: *vem har barnet på torsdag?*

Varannan håller reda på boendeschemat, låter föräldrarna byta dagar med
varandra, och räknar automatiskt ut hur det står mellan dem när någon
tagit fler dagar än schemat säger. Runt kalendern finns det som föräldrar
annars mejlar om: barnets uppgifter, inloggningar till skolplattformar,
packlistor inför överlämning, och en chatt.

Byggd i Next.js och Firebase. Ingen AI, inga annonser, ingen
tredjepartsspårning.

> **Status:** fungerande och i daglig användning, men inte en färdig
> produkt. Ingen publik registrering än.

---

## Innehåll

- [Vad appen gör](#vad-appen-gör)
- [Grundbegrepp](#grundbegrepp)
- [Arkitektur](#arkitektur)
- [Datamodell](#datamodell)
- [Köra lokalt](#köra-lokalt)
- [Deploy](#deploy)
- [Katalogstruktur](#katalogstruktur)
- [Designbeslut värda att känna till](#designbeslut-värda-att-känna-till)

---

## Vad appen gör

**Schemat räknas ut, det lagras inte.** Ett boendeschema anges som en
cykel — varannan vecka, 2-2-3, 3-4-4-3, eller ett eget mönster — och vem
som har barnet en godtycklig dag är sedan ren matematik. Det finns inga
rader per dag i databasen, så schemat kan sträcka sig hur långt in i
framtiden som helst utan att kosta något.

**Avvikelser är undantag ovanpå cykeln.** Vill den ena föräldern byta en
helg blir det en *ändring* som lagras separat. Grundschemat rörs aldrig,
så det går alltid att se vad som egentligen skulle ha gällt.

**Ställningen räknas automatiskt.** När en förälder tagit fler dagar än
schemat säger visas det som ett saldo — "+2 dagar på pappa". Saldot
uppdateras i samma transaktion som bytet godkänns, så status och
ställning kan aldrig hamna i otakt.

**Var och en bestämmer om hen vill bli tillfrågad.** En förälder kan
välja att ändringar av hens dagar ska kräva godkännande, eller att de får
gälla direkt med en notis. De två kan välja olika och det fungerar ändå,
eftersom inställningen hör till den som annars skulle godkänna.

**Schemat kan prenumereras på** som ett ICS-flöde i Google Kalender,
Apple Kalender eller Outlook.

---

## Grundbegrepp

Tre begrepp återkommer i koden och är värda att ha klara:

**Kalender = barn.** Ett barn och dess kalender är samma sak. Allt som
hör till barnet — schema, ställning, chatt, anteckningar, uppgifter,
barninfo, konton — delas med exakt de föräldrar som står i barnets
`parentIds`. Att byta kalender i appen byter därför alla vyer.

**Team = familjen.** Teamet håller föräldrarnas profiler och binder ihop
kalendrarna. En förälder kan lämna en enskild kalender utan att lämna
teamet; kalendern finns då kvar hos den andra, som kan bjuda in någon ny
till just den.

**Cykel = grundschemat.** En lista block (`{ parentId, days }`) plus ett
ankardatum och en bytestid. Cykeln är sanningskällan för det ordinarie
schemat; allt annat är avvikelser från den.

---

## Arkitektur

```
Next.js (statisk export)  ──►  Firebase Hosting
        │
        ├─ läser ──────────►  Firestore  (realtidslyssnare, onSnapshot)
        │
        └─ anropar ────────►  Cloud Functions (callables)
                                    │
                                    └─ skriver ►  Firestore (admin SDK)
```

**Frontenden är en ren statisk export.** Ingen SSR, ingen Node-runtime i
produktion. Det gör en deploy till en filuppladdning på sekunder i
stället för ett containerbygge på minuter. Priset är att inget i `app/`
får använda server-funktioner — en Route Handler eller en sida med
`force-dynamic` bryter exporten.

**Skrivningar går två vägar, styrt av `firestore.rules`.** Ofarliga
skrivningar (aktiviteter, chattmeddelanden, nya förslag) gör klienten
direkt. Allt som måste valideras eller ske atomiskt går via en callable:

| Går via Cloud Function | Varför |
|---|---|
| Godkänna ett dagbyte | Måste uppdatera ställningen i samma transaktion |
| Ändra grundschema eller bytestid | Kan kräva motpartens godkännande |
| Skapa, byta namn på, ta bort kalender | Uppdaterar teamdokumentet, som är låst för klienten |
| Inbjudningar | Koden måste genereras och konsumeras server-side |
| Läge för schemaändringar | Får bara sättas för en själv, inte för motparten |

Regeln bakom uppdelningen: **klienten får aldrig skriva något den skulle
kunna tjäna på att ljuga om.** En klient som kunde skriva sin egen
ställning kunde nolla sin skuld.

**De user-vända callables ligger i `europe-north1`** (Hamina). Firestore
ligger i `europe-north2` (Stockholm), som inte stödjer Cloud Functions —
`europe-north1` är närmaste region som gör det, ~1 ms längre bort. Nästan
alla användare är i Sverige, och anropen gör flera db-läsningar i följd:
hoppet funktion→databas går från ~110 ms (Iowa→Stockholm) till ~15 ms,
och Atlanten-hoppet till klienten försvinner. `setGlobalOptions` i
`functions/src/index.ts` sätter regionen; `lib/firebase.ts` måste matcha
(`getFunctions(app, "europe-north1")`).

Tre saker ligger kvar i `us-central1`, var och en med motivering i koden:

- **Firestore-triggarna** (`syncDisplayNameToTeam`,
  `notifyOnShiftRequestCreated`, `exportEventToGoogleCalendar`) — Eventarc
  stödde inte europe-north\* när de sattes upp, och de körs i bakgrunden
  så ingen väntar på dem.
- **`calendarFeed`** — dess URL ligger redan i användarnas
  kalenderprenumerationer (`lib/calendarExport.ts`, `FEED_REGION`), och
  den anropas server-till-server av Google/Apple/Outlook. Att byta region
  skulle tyst bryta varje befintlig prenumeration utan att ge något.

`europe-north2` stöds fortfarande inte för Cloud Functions.

---

## Datamodell

```
users/{uid}                          teamId, fcmTokens, notisinställningar
                                     Läsbart bara för ägaren själv.

teams/{teamId}                       parentIds, parentProfiles, childIds
  ├─ children/{childId}              ETT BARN = EN KALENDER. parentIds styr delning.
  │   ├─ custodyCycle/main           Grundschemat (block, ankardatum, bytestid)
  │   ├─ dayBalance/main             Ställningen, signerad mot en referensförälder
  │   ├─ dayBalanceHistory/{id}      Spår av varje ändring av saldot
  │   ├─ childInfo/main              Personnummer, allergier, skola …
  │   └─ accounts/{id}               Inloggningar till barnets tjänster
  ├─ shiftRequests/{id}              Byten av enskilda dagar
  ├─ scheduleStructureRequests/{id}  Förslag på nytt grundschema eller bytestid
  ├─ events/{id}                     Aktiviteter
  ├─ chatMessages/{id}               Chatt         ─┐
  ├─ notes/{id}                      Anteckningar   ├─ har childId, filtreras per kalender
  └─ todos/{id}                      Uppgifter     ─┘

teamInvites/{code}                   Inbjudningskoder, med utgångstid
```

**Varför `parentProfiles` finns.** `users/{uid}` är läsbart bara för
ägaren, så förälder A kan inte läsa förälder B:s namn direkt. Teamet
håller därför en kopia av namn och avatar per förälder. Den skrivs bara
server-side och byggs från auth-token, aldrig från klientdata.

**Känsliga fält.** `childInfo` och `accounts` kräver *kalendermedlemskap*,
inte bara teammedlemskap — annars hade en förälder som lämnat en kalender
fortsatt kunna läsa personnummer och PIN-koder.

---

## Köra lokalt

Kräver Node 20 och ett Firebase-projekt.

```bash
npm install
npm install --prefix functions

cp .env.local.example .env.local   # fyll i Firebase web-config
```

Web-configen hämtas i Firebase Console under *Project settings → Your
apps → Web app*. `NEXT_PUBLIC_FIREBASE_VAPID_KEY` ligger under *Cloud
Messaging → Web Push certificates* och behövs bara för notiser.

Slå på i Firebase Console:

1. **Authentication → Sign-in method** → E-post/lösenord och Google
2. **Authentication → Settings → Authorized domains** → din domän
   (`localhost` finns med som standard)

Kör mot emulatorerna:

```bash
# sätt NEXT_PUBLIC_USE_FIREBASE_EMULATORS=true i .env.local
npm run emulators   # i ett fönster
npm run dev         # i ett annat
```

Typkontrollera båda lagren var för sig. De har separata `tsconfig.json`,
och CI bygger i en ren miljö där fel som inte syns lokalt kan dyka upp:

```bash
npx tsc --noEmit -p tsconfig.json
npx tsc --noEmit -p functions/tsconfig.json
```

---

## Deploy

Deploy sker manuellt via GitHub Actions
(`.github/workflows/deploy.yml` → *Run workflow*), som bygger frontenden
och kör `firebase deploy`. Välj `target` efter vad som ändrats:
`hosting`, `functions`, `firestore:rules`, eller en kombination.

Miljövariabler kommer från repots GitHub Secrets; workflowen skriver
`.env.local` innan bygget.

**Det finns medvetet ingen automatisk deploy vid push.** En tidigare
push-trigger krockade med lokala deploykörningar och gav 409-konflikter.
Workflowen har en concurrency-grupp som skydd.

Övriga workflows i `.github/workflows/` är diagnostikverktyg — hämta
Cloud Functions-loggar, inspektera IAM-behörigheter, dumpa en boendecykel
— och rör inte produktionen.

---

## Katalogstruktur

```
app/                    Next.js App Router. page.tsx kopplar ihop allt.
components/             React-komponenter, en per vy eller panel.
lib/
  custodyCycle.ts       Räknar ut vem som har barnet en given dag
  dayBalance.ts         Ställningslogik
  calendarActions.ts    Skapa aktiviteter, föreslå och besvara byten
  calendarExport.ts     Bygger ICS-prenumerationslänkar
  onboarding.ts         Ren logik för team, inbjudan och cykel …
  onboardingClient.ts   … anropad från klienten via callables
  hooks/useFirestore.ts Realtidslyssnare, alla returnerar {data, loading, error}
  auth/                 AuthProvider och inloggningsgrind
functions/src/
  index.ts              Callables och Firestore-triggers
  calendarFeed.ts       ICS-flödet (publik HTTP-endpoint, token i URL)
  notifications.ts      Push via FCM, med rensning av döda tokens
  onboardingAdapter.ts  Kopplar lib/onboarding.ts mot admin SDK
types/schema.ts         Datamodellen. Delas mellan klient och functions.
scripts/
  generate-sw.js        Bygger service workern med Firebase-config inbakad
  generate-icons.py     Genererar appikonerna (npm run icons)
test/                   Korrekthetstester och benchmarks
```

`types/schema.ts` och delar av `lib/` kompileras in i både frontenden och
Cloud Functions. `onboardingAdapter.ts` kopplar in admin SDK bakom samma
interface som klienten använder, så samma logik kör på båda sidor.

---

## Designbeslut värda att känna till

**Tidszoner löses med `Intl.DateTimeFormat`, aldrig `setHours()`.**
Cykelns ankardatum måste tolkas i familjens egen tidszon. Klienten kör i
Stockholm och Cloud Functions i UTC, och `setHours()` gav dem olika svar
på vilken dag ett byte skedde.

**Firestores webb-SDK vägrar `undefined`.** Admin SDK accepterar det
tyst. Klientkod måste därför lägga till valfria fält villkorligt
(`...(x ? { x } : {})`), annars kastar hela skrivningen. Det har orsakat
minst två buggar där en hel funktion slutade fungera.

**Google Kalender färgar per kalender, inte per händelse.** Det går inte
att få två färger i ett prenumererat ICS-flöde, hur mycket `COLOR` man än
sätter. Därför exporteras varje förälder som en egen kalender. Apple och
Outlook läser däremot färgen ur flödet.

**Ordningen i onboarding spelar roll.** Cykeln måste sättas upp efter att
båda föräldrarna finns, annars lagras platshållarsträngar i stället för
riktiga uid:n.

**Notisstatus är inte samma sak som notisbehörighet.** Att webbläsaren
gett lov betyder inte att notiser fungerar; det krävs också en giltig
FCM-token, och de roterar. Appen skiljer på de två och kan skicka en
testnotis.
