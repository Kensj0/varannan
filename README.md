# Varannan — mockup-klon av "Varannan Vecka"

Öppen källkod, ingen AI. Next.js + TypeScript + Tailwind + Firebase.

## Struktur i detta första leverans-steg

```
types/schema.ts        Firestore-datamodell (interfaces för alla collections)
lib/custodyCycle.ts     Beräknar vem som "borde" ha barnet given en fast cykel (2/2/3 etc.)
lib/dayBalance.ts        Ställnings-logik: räknar ut +/- dagar vid godkänt byte
lib/shiftRequests.ts     "Tryck på dag → Ändra ansvar"-flödet (skapa + godkänna förslag)
components/CalendarView.tsx    Månadsvy med dagliga ansvars-taggar
components/DayActionModal.tsx  Popup: Aktivitet / Ändra ansvar (matchar skärmdumparna)
components/BalanceCard.tsx     "Ställning"-widget
```

## Hur cykel + ställning hänger ihop

1. **`custodyCycle.ts`** är sanningskällan för det *ordinarie* schemat.
   En cykel lagras som en lista block (`{parentId, days}`) plus ett
   ankardatum (`cycleStartDate`) och en bytestid (`switchHour`, för
   halvdagsbyten). Att räkna ut vem som har barnet en godtycklig dag är
   ren matematik (modulo cykelns längd) — inga rader per dag i Firestore.

2. **`dayBalance.ts`** jämför, halvdag för halvdag, vad cykeln *säger*
   mot vad ett godkänt `shiftRequest` faktiskt *blev*. Skillnaden
   ackumuleras i ett enda `dayBalance`-dokument per barn
   (`balanceDays`, signerat relativt en referensförälder). Det är detta
   som visas som "+2 dagar på Pappa".

3. **`shiftRequests.ts`** är själva arbetsflödet: `createShiftRequest`
   (motsvarar "FÖRESLÅ") skapar ett `pending`-dokument. Först när andra
   föräldern kör `respondToShiftRequest({decision: "approved"})`
   uppdateras `dayBalance` — och det bör göras i en Firestore
   **transaction** (t.ex. i en callable Cloud Function) så att status +
   ställning aldrig kan hamna i otakt.

## Säkerhet / Firestore-regler (att göra i nästa steg)

- Endast medlemmar i `teams/{teamId}.parentIds` får läsa/skriva teamets
  subcollections — kräver `request.auth.uid in resource.data.parentIds`
  (eller en lookup mot `users/{uid}.teamId`).
- Känsliga fält (`personalNumber`, `passportNumber`) bör INTE indexeras
  och bör krypteras at-rest utöver Firestores standardkryptering om ni
  vill vara extra försiktiga — de behöver egna striktare regler.
- `googleCalendar.refreshTokenRef` ska aldrig innehålla den råa token —
  peka mot Secret Manager, och låt en Cloud Function göra själva
  kalender-anropet server-side.

## Tillagt i detta steg

```
firestore.rules              Säkerhetsregler — endast teammedlemmar, känsliga
                              skrivningar (dayBalance, custodyCycle,
                              shiftRequest-status) tillåts bara via Cloud Functions
firestore.indexes.json       Tom platshållare
firebase.json                Hosting + Firestore + Functions + emulatorkonfig
package.json                 Frontend-beroenden (Next.js, Firebase client SDK)
functions/package.json       Functions-beroenden (admin SDK, googleapis)
functions/tsconfig.json      Kompilerar även in delad kod från /lib och /types
functions/src/index.ts       approveShiftRequest (transaktion) +
                              exportEventToGoogleCalendar (envägs export)
lib/onboarding.ts             Skapa team, bjud in förälder 2, lägg till barn,
                              spara boendecykel + nollställ ställningen
components/onboarding/OnboardingFlow.tsx        Hela wizard-flödet
components/onboarding/CustodyCycleBuilder.tsx   UI för att bygga t.ex. 2-2-3
```

## Deploy — kommandon att köra i din klonade repo

```bash
npm install
cd functions && npm install && cd ..
firebase login
firebase use --add          # koppla till ditt Firebase-projekt
npm run emulators           # lokal test av Firestore-regler + functions
npm run deploy               # bygger Next.js (export) + firebase deploy
```

Innan första deploy: sätt miljövariabler för Google OAuth (Calendar-export)
via `firebase functions:secrets:set GOOGLE_OAUTH_CLIENT_ID` och
`GOOGLE_OAUTH_CLIENT_SECRET`, och implementera `resolveSecret()` i
`functions/src/index.ts` mot Secret Manager (platshållare i koden just nu).

## Onboarding-flödet

`OnboardingFlow.tsx` går igenom: **Skapa familj → Bjud in andra föräldern
(valfritt, kan göras senare) → Lägg till barn → Bygg boendecykel
(`CustodyCycleBuilder`, med färdiga mönster: varannan vecka, 2-2-3, 2-2-5-5,
3-4-4-3 — eller helt eget block-för-block) → Klar**. Att spara cykeln
nollställer automatiskt `dayBalance` för barnet (`lib/onboarding.ts` →
`setupCustodyCycle`).

Andra föräldern som ansluter via inbjudningskoden (`acceptParentInvite`)
slussas förbi hela wizarden rakt in i appen, eftersom teamet och cykeln
redan finns.

## Tillagt: Firebase Auth

```
lib/firebase.ts                      Client SDK-init (auth, firestore, functions) + emulator-koppling
lib/auth/AuthProvider.tsx             React context: user, userDoc, signIn/signUp/signOut, Google
lib/auth/ensureUserDocument.ts        Skapar users/{uid} första gången man loggar in
lib/onboardingClient.ts               Anropar Cloud Functions för team/invite/cykel (addChild går direkt)
components/auth/LoginForm.tsx         E-post+lösenord och "Fortsätt med Google"
components/auth/AuthGate.tsx          Login → Onboarding → App, baserat på auth- och team-status
app/layout.tsx, app/page.tsx, app/globals.css   Next.js App Router-uppkoppling
tailwind.config.js, postcss.config.js
.env.local.example                    Mall för Firebase web-config
```

**Varför team/invite/cykel går via Cloud Functions:** `firestore.rules`
blockerar medvetet direkt skrivning av `users.teamId`, `custodyCycle` och
`dayBalance` från klienten (annars skulle vem som helst kunna manipulera
sin egen ställning eller hoppa in i ett team). De nya callable-funktionerna
`createFamilyTeam`, `createInvite`, `acceptInvite` och `saveCustodyCycle`
(i `functions/src/index.ts`, via `functions/src/onboardingAdapter.ts`)
återanvänder EXAKT samma rena logik som redan fanns i `lib/onboarding.ts`
— adaptern kopplar bara in admin SDK bakom samma interface.

### Aktivera i Firebase Console

1. **Authentication → Sign-in method** → slå på **E-post/lösenord** och **Google**.
2. **Authentication → Settings → Authorized domains** → lägg till din
   Firebase Hosting-domän (`localhost` finns med som standard för emulatorn).
3. Kopiera web-config till `.env.local` (se `.env.local.example`).

### Testa lokalt

```bash
cp .env.local.example .env.local   # fyll i Firebase-config, sätt EMULATORS=true
npm run emulators                  # i ett fönster
npm run dev                        # i ett annat
```

## Join-flödet (`/join/[code]`)

`app/join/[code]/page.tsx` hanterar hela inbjudningslänken
(`https://varannan.app/join/AB12CD` från `InviteStep`). Den kringgår
`AuthGate`s vanliga login/onboarding-gating (se villkoret för
`pathname.startsWith("/join/")` i `AuthGate.tsx`) eftersom man kan bli
inbjuden innan man ens har ett konto:

- **Inte inloggad** → visar `LoginForm` inbäddad på samma sida, fortsätter
  automatiskt så fort inloggningen lyckas (`useEffect` som reagerar på `user`).
- **Redan medlem i en annan familj** → ber om bekräftelse innan bytet, så
  man inte råkar lämna sin nuvarande familj av misstag.
- **Ogiltig/utgången kod** → tydligt felmeddelande + "Försök igen"
  (`acceptInvite`-callablen kastar `failed-precondition` för det fallet).
- Vid lyckat accept: `refreshUserDoc()` + redirect till `/`, där
  `AuthGate` nu ser att `teamId` finns och släpper rakt in i appen
  (ingen onboarding-wizard för den som blev inbjuden).

## Realtidslyssnare (`onSnapshot`)

```
lib/hooks/useFirestore.ts    useTeam, useChildren, useCustodyCycle, useDayBalance,
                              useApprovedShiftRequests, usePendingShiftRequests,
                              useEventsForMonth — alla returnerar { data, loading, error }
lib/calendarActions.ts        createEvent, proposeShiftRequest, respondToShiftRequest
components/PendingShiftRequests.tsx   Kort med Godkänn/Avböj för väntande förfrågningar
app/page.tsx                  Kopplar ihop allt: barnväljare, ställning, förfrågningar, kalender
```

Poängen med `onSnapshot` istället för engångsläsning: när den ena
föräldern godkänner ett ansvarsbyte uppdateras den andres kalender **och**
ställning direkt, utan omladdning — Cloud Functionen skriver till
`dayBalance` och lyssnaren plockar upp det på en gång.

Skrivningar går två olika vägar, styrt av `firestore.rules`:
aktiviteter och nya (`pending`) förfrågningar skrivs direkt av klienten,
medan **godkännande** går via callablen `approveShiftRequest` eftersom
det måste uppdatera ställningen i samma transaktion. `PendingShiftRequests`
visar dessutom bara Godkänn/Avböj för motparten — den som skickade
förslaget ser "Väntar på svar" (samma regel upprätthålls server-side).

Frågorna kräver sammansatta index; de ligger redan i
`firestore.indexes.json` och deployas med `firebase deploy --only firestore:indexes`.

## Namn på båda föräldrarna

`users/{uid}` är bara läsbart för ägaren själv (se `firestore.rules`), så
förälder A kan inte läsa förälder B:s namn direkt. Lösningen är en cachad
kopia i team-dokumentet: `TeamDoc.parentProfiles` (`{ uid, displayName,
avatarUrl }` per förälder). Den skrivs enbart server-side —
`createFamilyTeam` och `acceptInvite` bygger profilen från **auth-token**
(inte från klientdata), och triggern `syncDisplayNameToTeam` håller den i
synk om någon byter namn eller profilbild.

## Aktiviteter i kalendern

`useEventsForMonth` matar nu `CalendarView` via `events`-propen.
Aktiviteterna grupperas per dag en gång (`eventsByDay`) istället för att
filtrera hela listan i varje ruta, och varje dagruta visar upp till två
titlar plus "+N till". Titeln och "Återkommande"-flaggan från
`DayActionModal` skickas hela vägen fram till `createEvent` — tidigare
kastades de bort och alla aktiviteter hette "Ny aktivitet".

## Återkommande aktiviteter

`lib/recurrence.ts` expanderar en lagrad `RecurrenceRule` till konkreta
tillfällen inom ett datumintervall — vi lagrar **aldrig** en rad per
tillfälle i Firestore, bara moder-eventet. Samma princip som cykel-
beräkningen: liten databas, och en ändrad regel slår igenom överallt direkt.
Stöder daily/weekly/monthly/yearly med `interval`, `byWeekday` (flera dagar
per vecka) och `until`, med ett tak på 500 tillfällen som skyddsnät.

En bugg som fixades på vägen: `useEventsForMonth` filtrerade på
`startAt >= rangeStart`, vilket gjorde att ett återkommande event som
började i mars aldrig syntes i augusti. Hooken har nu **två** lyssnare —
en intervallfråga för engångsaktiviteter och en obegränsad för
återkommande moder-events — som slås ihop och dedupliceras.

Genererade tillfällen märks med `↻` i kalendern.

## Chatt

```
lib/chatActions.ts        sendChatMessage
components/ChatView.tsx    Bubblor, datumseparatorer (Idag/Igår), komponerare
```

`useChatMessages` hämtar de senaste 100 meddelandena i fallande ordning
och vänder listan, så UI:t slipper läsa hela historiken.

Meddelanden med `linkedShiftRequestId` renderas som ett **kort** med
bytets period och status (Väntar på svar / Godkänt / Avböjt) istället för
som vanlig text — så historiken över förfrågningar och godkännanden syns
i konversationen, som i originalappen. `proposeShiftRequest` postar
automatiskt ett sådant meddelande när ett byte föreslås.

`firestore.rules` blockerar `update` och `delete` på chattmeddelanden:
historiken ska inte gå att skriva om i efterhand, särskilt inte när den
innehåller överenskommelser om ansvar.

## Packlista, Notes och Todo

```
lib/listActions.ts             Skrivningar för alla tre (direkt mot Firestore)
components/PackListView.tsx     Listor knutna till nästa byte, avbockning, "Sedd av"
components/NotesView.tsx        Gemensamma anteckningar med inline-redigering
components/TodoView.tsx         Uppgifter med avbockning, "Du gjorde detta" och ARKIVERA
```

Startsidan har nu fem flikar: **Kalender · Packlista · Notes · Todo · Chatt**.

Detaljer värda att känna till:

- **Packlistor** markeras automatiskt som sedda när den andra föräldern
  öppnar fliken (`markPackListSeen` → `seenBy`), vilket driver "Sedd
  av:"-raden. Banderollen överst visar nästa ordinarie byte, beräknat med
  `getNextOrdinaryHandoff` från cykeln.
- **Avbockning av en packlista-post** skriver om hela `items`-arrayen —
  Firestore kan inte uppdatera ett enskilt arrayelement. Medveten
  avvägning: listorna är korta.
- **Todos** raderas aldrig av ARKIVERA, bara `archived: true`.
  `useTodos(teamId, true)` hämtar även arkiverade om ni vill bygga en
  historikvy.

## Barninfo & Konton

```
lib/childInfoActions.ts        updateChildInfo, createChildAccount m.fl.
components/ChildInfoView.tsx    Strukturerat formulär: storlekar, hälsa, dokument, övrigt
components/AccountsView.tsx     Delade konton — streamingtjänster, PIN-koder
```

Startsidan har nu sju flikar: **Kalender · Packlista · Notes · Todo ·
Barninfo · Konton · Chatt**. Barnväljaren visas på alla flikar som är
per barn (allt utom Notes, Todo och Chatt, som är gemensamma för familjen).

### Om känsliga uppgifter

Det här är projektets känsligaste data — personnummer, passnummer,
medicinsk information och inloggningar. Tre lager:

1. **`firestore.rules`** — endast teamets två föräldrar kan läsa eller
   skriva. Ingen delning, inga collectionGroup-frågor.
2. **`firestore.indexes.json`** — `personalNumber`, `passportNumber`,
   `medicalAllergy` och `pinOrNote` är explicit **avindexerade**
   (`fieldOverrides` med tom `indexes`-array). Ett indexerat fält är ett
   sökbart fält; de här ska aldrig gå att söka på.
3. **Maskering i UI:t** — personnummer, passnummer och PIN-koder visas
   som prickar tills man trycker "Visa". Det skyddar inte mot någon som
   redan har kontot, men mot att uppgifterna syns när telefonen ligger
   framme på en förskola eller i ett väntrum.

**Vad som INTE är gjort:** klient-side-kryptering. Firestore krypterar
allt at-rest som standard, men för produktion bör `pinOrNote` och
`personalNumber` krypteras med en nyckel som ligger utanför databasen —
då skyddas de även mot en felkonfigurerad regel eller en läckt
admin-nyckel. Överväg också om personnummer verkligen behöver lagras
alls, eller om de sista fyra siffrorna räcker för ert syfte. Att inte
lagra en uppgift är alltid det starkaste skyddet.

## Tester och prestanda

```bash
npm test     # 31 korrekthetstester av kärnlogiken
npm run bench # benchmark av beräkningsvägarna
```

`test/correctness.ts` täcker cykelberäkning (inklusive datum före
ankaret, halvdagsbyten och exakta bytpunkter), ställningsberäkning och
expansion av återkommande aktiviteter. `test/bench.ts` mäter de vägar
som körs vid varje render.

### Mätvärden (Node 22, sandbox-CPU — din maskin är sannolikt snabbare)

| Operation | Tid |
|---|---|
| `getScheduledParentForDate` (2-2-3) | 0,53 µs |
| `getScheduledParentForDate` (40 block) | 0,62 µs |
| **Full månadsvy, 42 dagrutor** | **23 µs** |
| `calculateShiftDeltaDays` (1 dygn) | 1,6 µs |
| `calculateShiftDeltaDays` (61 dygn) | 80 µs |
| `expandEvents`, 50 engångsaktiviteter | 60 µs |
| `expandEvents`, 5 dagliga över 3 mån (460 tillfällen) | 979 µs |
| **Realistisk månadsvy (42 rutor + 27 events)** | **357 µs** |

En hel månadsrendering kostar ~0,36 ms. Det är långt under en
16 ms-frame, så beräkningarna är inte flaskhalsen — nätverkslatensen mot
Firestore dominerar helt.

### Optimering som gjordes

Första mätningen visade att `getScheduledParentForDate` var **3,3×
långsammare** med 40 block än med 6, vilket avslöjade att den byggde om
hela brytpunktslistan (med `Date`-allokeringar) vid varje anrop — och den
körs 42 gånger per månadsvy. Funktionen går nu igenom blocken med ren
aritmetik och allokerar bara de två `Date`-objekt som faktiskt returneras:

- 1,75 µs → **0,53 µs** per anrop (3,3× snabbare)
- Månadsvyn: 73 µs → **23 µs**
- Skalning med cykelstorlek: 3,3× → **1,2×**

Ställningsberäkningen blev 2,5× snabbare på köpet, eftersom den anropar
cykeln en gång per halvdagssteg.

Alla 31 test passerar efter optimeringen — beteendet är oförändrat.

### Det som INTE är mätt

Benchmarken täcker bara ren beräkning. Firestore-latens, `onSnapshot`-
overhead och React-renderingstid är inte med, och de dominerar den
upplevda hastigheten. `expandEvents` med dagliga aktiviteter (~1 ms) är
den enda kod som skulle märkas om den kördes i en scroll-loop — den
ligger redan i en `useMemo` med `[events, monthDate]` som beroenden, så
den körs bara vid månadsbyte.

## Genomgång av onboarding, schemastruktur och inbjudan

En granskning av de tre flödena hittade sex fel, varav tre allvarliga.
Alla är åtgärdade.

### 1. Schemat sparade platshållare i stället för riktiga användare (allvarligt)

`CustodyCycleBuilder` hade `const PARENT_A = "parentA"` med kommentaren
"ersätts med riktiga uid:n vid spara" — men ingen kod gjorde den
ersättningen. Cykeln sparades med strängarna `"parentA"`/`"parentB"`,
som aldrig matchar ett riktigt uid. `CalendarView` slår upp
`parents.find(p => p.id === parentId)`, får `undefined` och faller
tillbaka på förälder 1 — **hela kalendern hade visat samma förälder
varje dag**, och ställningen räknat fel.

**Grundorsaken var ordningen i wizarden.** Cykeln byggdes i steg 4, men
inbjudan låg i steg 2 — andra föräldern hade i praktiken aldrig hunnit
acceptera, så hens uid existerade inte. Platshållarna var en lapp på ett
strukturfel.

Nu: wizarden är **Skapa familj → Lägg till barn → Bjud in**, och
schemat sätts upp av `CycleSetupScreen` först när båda föräldrarna
finns. Det är också rimligare — schemat rör dem lika mycket, så båda
bör kunna vara med och bestämma det. `CustodyCycleBuilder` tar numera
riktiga föräldrar som prop, och `saveCustodyCycle` i Cloud Functions
avvisar block som pekar på någon utanför teamet.

### 2. Bytestiden skiljde sig mellan klient och server (allvarligt)

`switchHour` ("12:00") applicerades med `Date.setHours()`, som använder
den tidszon där koden råkar köra. Webbläsaren kör i Europe/Stockholm,
**Cloud Functions kör i UTC** — så kalendern visade byte kl 12:00 svensk
tid medan ställningen räknades som om bytet skedde 12:00 UTC (14:00
svensk sommartid). Ett byte nära en bytpunkt kunde tillskrivas fel
förälder med en halv dag.

Fältet `timezone` fanns redan i schemat men användes aldrig. Nu ankras
cykeln alltid i sin lagrade tidszon via `Intl`, oavsett var koden körs.
`cycleStartDate` lagras dessutom som `"YYYY-MM-DD"` i stället för
`Timestamp` — ett startdatum för ett återkommande schema är ett datum i
en kalender, inte en punkt på tidslinjen, och som Timestamp var det
tvetydigt.

Testerna körs nu i sex tidszoner och ger identiskt resultat.
Ankaret cachas, så hot path blev snabbare trots Intl: **0,33 µs**
(från 0,53).

Kvarstående begränsning, medvetet: blockgränser räknas som `ankare +
N×24h`, så bytestiden driver en timme över en sommartidsövergång.
Eftersom svenska DST-byten sker kl 03:00 och byten normalt mitt på
dagen korsar driften aldrig ett dygnsskifte — vem som har ansvaret blir
alltid rätt. Att bygga bort det skulle kräva ett Intl-anrop per
blockgräns, ~100× dyrare i hot path.

### 3. Man kunde bli permanent inlåst (allvarligt)

`AuthGate` visade onboarding enbart när `teamId` saknades. `teamId` sätts
i **steg 1**. Stängde man webbläsaren efter det steget fick man vid nästa
inloggning en skärm med texten "Bjud in den andra föräldern..." och
**bara en utloggningsknapp** — ingen väg vidare, för alltid.

Nu har varje lucka en egen skärm som går att agera från:
`AddFirstChildScreen`, `WaitingForParentScreen` (med knapp för att skapa
inbjudan) och `CycleSetupScreen`. `AuthGate` beslutar bara utifrån
`teamId`; resten hanteras av `app/page.tsx`, som har lyssnarna.

### 4. Inbjudningskoden var gissningsbar

Koden var 6 tecken ur 31 (~10⁹) genererad med `Math.random()`. En kod
ger tillgång till familjens allt, inklusive barnens personnummer, och
`teamInvites` är läsbar för alla inloggade. Nu 10 tecken (~10¹⁵) från
kryptografiskt säker slump, utan modulo-bias, formaterade `ABCDE-FGHIJ`.

### 5. En tredje person kunde ansluta

`acceptInvite` kollade aldrig hur många föräldrar teamet redan hade —
`arrayUnion` la bara till fler. Nu kontrolleras taket, och
`addParentToTeam` kör i en **transaktion** så att två samtidiga
inlösningar inte kan slinka förbi kontrollen. Koden konsumeras dessutom
först när anslutningen är godkänd, så en avvisad inlösen inte bränner
inbjudan.

### 6. Delningslänken pekade på fel domän

`shareUrl` var hårdkodad till `https://varannan.app/join/...`. Nu skickar
klienten `window.location.origin`, som servern validerar mot
`ALLOWED_APP_ORIGINS` — annars kunde en angripare få appen att generera
inbjudningslänkar mot en phishing-domän. Sätt variabeln vid deploy:

```bash
firebase functions:config:set app.origins="https://ert-projekt.web.app"
```

### Förbättringar i cykelbyggaren

- **Förhandsgranskning** av de första två veckorna som färgade rutor, så
  man ser vad "2-2-3" faktiskt innebär innan man sparar.
- **Varning vid ojämn fördelning** ("A har 2 dagar mer per cykel") —
  tillåtet, men bör vara ett aktivt val eftersom ställningen utgår från
  det som normalläge.
- **Varning om cykeln inte är delbar med 7**, då veckodagarna förskjuts
  för varje varv och barnet inte får samma vardagar hos samma förälder.
- Alla fyra presets har test som verifierar 7/7-fördelning och
  delbarhet med 7.
- **Web Share API** vid delning av inbjudan, med kopiering som fallback.

Testsviten är utökad från 31 till **46 test**.

## Kalendervyn (veckorader) + inställningar + överlämnings-påminnelser

Kalendern (`CalendarView.tsx`) ritas nu som obrutna veckorader i stället
för en månadsruta med tomma celler, för att matcha originalappens vy:

- Varje vecka är en rad. Dagar där SAMMA förälder har hela dygnet slås
  ihop till en sammanhängande färgad stapel med namnet centrerat
  (`computeBlockSegments`), i stället för en ruta per dag. Dagar där ett
  byte faktiskt sker (`morningParent !== afternoonParent`) visas som en
  egen, ofärgad ruta med bytestiden (t.ex. "8:00") — precis som i
  bifogad skärmdump.
- Aktiviteter visas som en gul markering i dagrutan (`bg-amber-300`).
- Veckonummer-kolumnen är en ren visningsinställning (sparas i
  `localStorage`, `varannan:showWeekNumbers`), inte i Firestore — den
  påverkar bara den egna enheten.
- Kögelikonen uppe till höger öppnar `CalendarSettingsPanel`: visa
  veckonummer, gå in i ändringsläget, samt två toggles för
  överlämnings-påminnelser ("Dagen innan" / "Samma dag"). De sparas per
  användare på `users/{uid}.handoffReminderPrefs` (se
  `lib/pushNotifications.ts#updateHandoffReminderPrefs`). Pennikonen
  uppe till vänster går rakt in i ändringsläget, som ett alternativ till
  långtryck på en dag.

**Push-påminnelsen** skickas av en ny schemalagd Cloud Function,
`functions/src/handoffReminders.ts` (`sendHandoffReminders`), som körs
en gång om dagen (08:00 Europe/Stockholm). Den loopar över alla team och
barn, räknar ut om ett byte sker idag/imorgon (fast cykel + godkända ad
hoc-byten, se `lib/handoffPreview.ts`), och skickar till den förälder
som tar över ("Du tar över ansvaret") respektive lämnar över ("Du lämnar
över ansvaret") — med antal opackade saker i barnets packlistor i
brödtexten, t.ex. "Byte kl 12:00 idag (2 saker kvar att packa)". Varje
förälders `handoffReminderPrefs` avgör om just den påminnelsen skickas
till just den personen.

OBS: schemalagda (`onSchedule`) Cloud Functions kräver Blaze-planen och
att Cloud Scheduler-API:t är aktiverat i GCP-projektet — annars
misslyckas deploy av just den funktionen (resten av `firebase deploy
--only functions` påverkas inte).

## Exportera kalender (ICS-prenumeration)

Google Calendar, Apple Kalender och Outlook prenumererar alla på samma
sorts ICS-URL, så i stället för tre integrationer serverar
`functions/src/calendarFeed.ts` ETT flöde som alla tre kan läsa:

- `calendarFeed` (HTTP) bygger en `VCALENDAR` med ett event per
  sammanhängande ansvarsperiod ("Lova hos Kenny") plus alla aktiviteter,
  3 månader bakåt och 12 framåt.
- Åtkomst styrs av ett hemligt token på
  `teams/{teamId}.calendarFeedTokens[childId]`, skapat av callablen
  `createCalendarFeedToken`. Jämförelsen är konstanttid. Vem som helst med
  URL:en kan läsa schemat — skapar man ett nytt token slutar den gamla
  länken att fungera, vilket är hur man återkallar en delad prenumeration.
- Inställningspanelen bygger de tre plattformslänkarna
  (`lib/calendarExport.ts`): Google `addbyurl`, `webcal://` för iOS/macOS,
  och Outlooks `addfromweb`.

Detta är läsbar prenumeration, till skillnad från den befintliga
`exportEventToGoogleCalendar` som via OAuth skriver in event-kopior i
Googles kalender. Båda finns kvar och gör olika saker.

**Kräver en ny GitHub-secret:** `NEXT_PUBLIC_CALENDAR_FEED_URL`, satt till
funktionens URL (t.ex.
`https://us-central1-varannan-familj.cloudfunctions.net/calendarFeed`).
Utan den blir länkarna tomma.

## Schemafärger

`PARENT_PALETTE` i `types/schema.ts` är sex av Google Calendars egna
kalenderfärger, så ett prenumererat schema ser likadant ut i appen som i
Google Calendar. Valet sparas som `parentProfiles[uid].colorId` via
callablen `setParentColor` — inte direkt från klienten, eftersom
`teams/{teamId}` är låst i `firestore.rules` och för att man bara ska
kunna ändra sin egen färg. Den andra förälderns färg är utgråad i
väljaren så båda inte kan ha samma.

## Nästa steg (föreslaget)

1. Klient-side-kryptering av `pinOrNote` och `personalNumber`
   (se avsnittet om känsliga uppgifter ovan).
2. Implementera `resolveSecret()` mot Secret Manager på riktigt
   (Google Calendar-export).
3. Dagvy/detaljvy när man trycker på en dag med aktiviteter, så man kan
   öppna och redigera dem (nu öppnas alltid Aktivitet/Ändra ansvar-valet).
4. Undantag i återkommande serier ("ställ in bara den 14:e") — kräver ett
   `exceptions`-fält på `EventDoc` som `expandEvent` filtrerar bort.
5. Koppla packlistor till ett specifikt byte via `linkedShiftRequestId`
   (fältet finns, men UI:t skapar bara fristående listor än).
6. Skicka `shareUrl` från `InviteStep` via t.ex. Web Share API eller SMS,
   inte bara visa koden på skärmen.
