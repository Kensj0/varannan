# Roller och medlemskap — arbetsplan

Levande dokument. Uppdateras efterhand som etapper blir klara, så att
nästa session (eller nästa person) ser var arbetet står utan att gräva
i commit-historiken.

**Status:** Etapp 1–4 kodade, INTE ännu deployade den här omgången (se
"Läge just nu" längst ner för vad som är kvar). Kennys riktiga
användartest av den minimala etapp 3 (kontot "Lova") visade att en
separat, förenklad vy för anhöriga var fel modell — den är riven och
ersatt av en enhetlig vy: SAMMA UI som en förälder ser i hela appen,
bara med vissa knappar/flikar avstängda beroende på rollen på den
AKTIVA kalendern (inte på kontot som helhet). "+"-väljaren växlar
mellan ALLA kalendrar man är med på, oavsett familj. Etapp 4 (en
anhörigs "Ändra ansvar" kräver BÅDA föräldrarnas godkännande) byggdes
samtidigt, server-auktoritativt. Regeltester (53/53) gröna —
`firestore.rules` självt rördes INTE i den här omgången (etapp 4 sitter
helt i `functions/src/index.ts`).

---

## Varför

I dag går all säkerhet i `firestore.rules` genom `isTeamMember(teamId)`,
som bara betyder att `users/{uid}.teamId` matchar. Det gäller chatten,
anteckningarna, todos, packlistorna — och `childInfo`, som innehåller
personnummer, passnummer och medicinska uppgifter.

Det betyder att vem som helst som släpps in i teamet i dag ser allt.
Att dölja knappar i gränssnittet räcker inte: klienten kan läsa
Firestore direkt med sitt eget token. Rollerna måste därför in i
reglerna, inte bara i UI:t.

## Vad som ska byggas

Tre roller: `parent`, `relative` (anhörig), `viewer` (utomstående).

| | parent | relative | viewer |
|---|---|---|---|
| Se schema och aktiviteter | ja | ja | ja |
| Lägga in aktivitet | ja | ja | nej |
| Ta bort aktivitet | alla | bara egna | nej |
| "Ändra ansvar" | ja | ja (kräver BÅDA föräldrarnas ja) | nej |
| Packlistor, anteckningar, todos | ja | ja | nej |
| Chatt | ja | nej | nej |
| `childInfo`, `accounts` | ja | nej | nej |
| Grundschema, inställningar | ja | nej | nej |
| Bjuda in | ja | nej | nej |

Alla inbjudningar kräver godkännande från båda föräldrarna innan de
skickas till mottagaren.

## Beslut som redan är fattade

Fattade tillsammans med Kenny — ändra inte utan att fråga.

- **Medförälder (tredje förälder) är UTE ur den här etappen.** Skjuts
  till senare. Orsaken: `DayBalanceDoc` är ett enda signerat tal
  relativt `parentIds[0]` och är matematiskt tvåpartsbaserad. Tre
  föräldrar kräver en ny balansmodell, inte en omskrivning.
- **En dag som en anhörig tar påverkar INTE ställningen.** Ingen
  förälder vann något på den. Detta ska stå i avtalstexten
  (`lib/agreementText.ts`), inte bara i koden.
- **Anhörig får inte ta bort aktiviteter som en förälder lagt in** —
  bara sina egna.
- **Anhöriga ser packlistor, anteckningar och todos.** Chatten är
  fortsatt bara för föräldrar.
- **Medlemskapet flyttar till barnet**, inte teamet. Kalendern ÄR
  barnet — `ChildDoc.parentIds` säger redan det i sin kommentar.
  Arkitekturen har redan börjat röra sig dit; det yttre låset på
  `users.teamId` blev bara kvar.
- **En anhörig ska kunna höra till flera kalendrar i olika familjer.**
  Mormor med barnbarn i två familjer. Kalendrarna bläddras i den
  befintliga `+`-väljaren.
- **`users/{uid}.teamId` blir kvar men byter betydelse:** "mitt eget
  hem-team", det man skapade som förälder. Mormor kan sakna det helt.
  Fältet får INTE tas bort — onboarding förutsätter det.

## Datamodell

`ChildDoc` får:

```ts
members: Record<string /* uid */, {
  role: "parent" | "relative" | "viewer";
  addedAt: FirestoreTimestamp;
  invitedBy: string;
}>;
/** Denormaliserad kopia av Object.keys(members). Behövs för att
 *  reglerna ska kunna kolla medlemskap billigt, och för
 *  collectionGroup-frågan som listar kalendrar tvärs över team. */
memberUids: string[];
```

`parentIds` blir kvar orört — det driver grundschemat och ställningen,
och anhöriga/utomstående ska INTE in där.

Inbjudningar (`teamInvites/{code}`) får:

```ts
role: "parent" | "relative" | "viewer";
invitedEmail: string;
invitedBy: string;
approvedBy: string[];      // uid:n som sagt ja
requiredApprovers: string[]; // kalenderns föräldrar vid skapandet
status: "pending_approval" | "sent" | "used" | "expired";
```

`ShiftRequestDoc` får:

```ts
requiredApprovers?: string[]; // fler än en när en anhörig begär
approvedBy?: string[];
```

Verkställs först när alla nödvändiga ja finns. Notify-läget respekteras
som i dag: läget sitter per förälder på
`parentProfiles[uid].scheduleChangeMode` och mottagaren bestämmer, så
en förälder som valt notis räknas inte som nödvändig godkännare.

## Ordning

Deploya mellan varje etapp. Kenny testar som riktig användare efter
varje — det kan jag inte göra åt honom.

- [x] **1. Roller och regler** (tyngst, mest riskabel) — DEPLOYAD.
      Rollerna in i datamodellen, `firestore.rules` skrivs om från
      `isTeamMember` till kalendermedlemskap + roll. Migrering av
      befintlig data: varje `child.parentIds` blir en `members`-map.
      Migreringen ska vara idempotent och bara ADDERA — aldrig radera
      `parentIds`. Regeltester i Firebase-emulatorn INNAN deploy.
- [x] **2. Inbjudningsflöde med dubbelt godkännande** — DEPLOYAD
      2026-09-25. Kvar: Kenny testar som riktig användare, se
      checklistan i "Läge just nu" nedan.
      "Bjud in"-knapp, dialog med mail + roll. Inbjudan skapas i
      väntläge, andra föräldern notifieras (push + mail, infrastrukturen
      finns sedan `dbe342a`), koden genereras och mailas först efter ja.
- [x] **3. Medlemskap per kalender över teamgränser** — RIKTIGA VERSIONEN
      byggd. Ersätter den minimala versionen (egen `RelativeHome`-vy,
      nu borttagen helt): "+"-väljaren i `app/page.tsx`/`CalendarView`
      listar ALLA kalendrar (`getMyCalendars()`), egna och främmande, i
      EN gemensam vy. Se "Läge just nu" för detaljer.
- [x] **4. Anhörigs "ändra ansvar"** — byggd. Flera godkännare på
      `ShiftRequestDoc`, verkställs server-auktoritativt i
      `approveShiftRequest`/`approveShiftRequestBatch`
      (`functions/src/index.ts`) — räknar alltid ut de riktiga
      föräldra-id:na själva vid godkännande, litar aldrig på ett
      klient-skrivet `requiredApprovers`. Avtalstexten
      (`lib/agreementText.ts`) är INTE uppdaterad än med regeln att
      anhörigdagar inte påverkar ställningen — kvarstår.

## Fallgropar

- `isTeamMember` finns på 17 ställen i reglerna, `teamId` 139 gånger i
  `functions/src/index.ts` över 20 callables, och 17 hooks tar emot det.
  Mekaniskt men brett.
- Reglerna är allt eller inget. Ett misstag låser antingen ut Kenny och
  den andra föräldern ur deras egen kalender, eller exponerar
  `childInfo`. Emulatortester före deploy, inte efter.
- Kenny kör skarpt med riktig familjedata. Backup före migrering.
- `PENDING_PARTNER_ID` är en platshållare i grundschemat för en förälder
  som ännu inte anslutit. Den får inte förväxlas med en riktig medlem
  när `members` byggs.
- `calendarParentIds()` i `types/schema.ts` faller tillbaka på teamets
  `parentIds` när barnet saknar egna. Den fallbacken måste överleva
  migreringen, annars tappar gamla kalendrar sina medlemmar.

## Läge just nu (efter etapp 2-sessionen)

**Etapp 1 — deployad, oförändrad sedan tidigare.** Se git-historiken på
`etapp1-roller-regler` för detaljer (roller i datamodellen, härdade
regler för childInfo/accounts/dayBalance/children-dokumentet,
migreringsskriptet kört i produktion).

**Etapp 2 — klart, INTE deployat:**

- `types/schema.ts`: `TeamInviteDoc` fick `baseUrl` (så
  `approveCalendarInvite` kan bygga samma delningslänk som skapades med,
  utan att lita på godkännarens klient) och `declinedBy`/`respondedAt`/
  `sentAt`.
- `functions/src/index.ts`:
  - `createCalendarInvite` tar nu emot `role` (`"parent"` som förut —
    OFÖRÄNDRAT beteende — eller `"relative"`/`"viewer"`, som kräver
    `invitedEmail`). Förälder-flödet är verifierat oförändrat: samma
    två-föräldrar-spärr, samma statuslösa dokument (fast med
    `role`/`status: "sent"` tillagt, vilket `acceptCalendarInvite`
    redan tolererar för gamla dokument utan de fälten).
  - Ny `approveCalendarInvite(code, decision)`: lägger till godkännarens
    uid i `approvedBy`, och när alla nödvändiga (`requiredApprovers`
    minus den inbjudande föräldern minus de som valt "notis") sagt ja:
    status blir `"sent"`, koden mailas till `invitedEmail`. `decision:
    "decline"` finns också (inte uttryckligen beställt, men annars
    fastnar en nekad inbjudan för alltid i `"pending_approval"`) —
    sätter status `"expired"` och notifierar den inbjudande föräldern.
  - `acceptCalendarInvite`: förälderdelen är BYTE-FÖR-BYTE samma logik
    som innan (bara omdöpta lokala variabler). Ny gren för
    `relative`/`viewer`: skriver bara `child.members`/`memberUids`,
    rör ALDRIG `parentIds`, `teams.parentIds` eller `users.teamId` —
    se "Beslut som redan är fattade" om att en anhörig kan höra hemma
    i ett helt annat team.
- `firestore.rules`:
  - **Bugfix i redan deployad etapp 1**: `custodyCycle`-läsningen
    använde `canViewCalendarContent()`, som uttryckligen UTESLUTER
    viewer — trots att både tabellen och rutans egen kommentar sa att
    viewer också ska se schemat. Bytt till `isCalendarParticipant()`
    (alla tre roller). Ofarligt att fixa nu: ingen viewer har kunnat
    existera i produktion före den här sessionen.
  - `events`/`notes`/`todos` (childId valfritt — familje-gemensamt
    utan childId är kvar på `isTeamMember`, dvs bara föräldrar):
    kalenderscopat innehåll öppnat för `relative`/`viewer` att läsa,
    `relative` att skapa, och `relative` att bara ändra/ta bort SINA
    EGNA (events) — `createdBy`-kollen finns bara på den nya grenen,
    inte på `isTeamMember`-grenen, så en förälder kan fortfarande
    hantera allas aktiviteter precis som innan.
  - `packLists` (childId alltid satt): samma mönster, ingen
    `createdBy`-spärr (tabellen ger `relative` full åtkomst här, ingen
    "bara egna"-regel).
  - `shiftRequests`: läsning breddad till alla tre roller (del av
    "Se schema"), skapande öppnat för `relative` också. OBS: den
    riktiga flera-godkännare-verkställningen ("kräver BÅDA
    föräldrarnas ja" när en anhörig föreslår ett byte) är INTE byggd
    — det är etapp 4. Reglerna släpper bara in förslaget; en anhörigs
    byte kan idag godkännas av EN förälder precis som en förälders
    eget, vilket INTE matchar tabellen fullt ut än.
  - `scheduleStructureRequests`: läsning breddad till `relative`
    (annars osynligt att ett förslag väntar), skrivning fortsatt
    `if false` — ingen ändring i vem som FAKTISKT kan initiera/svara.
  - `chatMessages`: MEDVETET orörd — se kommentaren i filen för varför
    det håller (ingen anhörig/utomstående får `users.teamId` satt till
    kalenderns team).
  - `teamInvites`: delat i `get` (öppet, oförändrat — behövs för
    join-sidan) och `list` (nytt, begränsat till kalenderns föräldrar
    via `isTeamMember(resource.data.teamId)`) — annars hade
    godkännande-vyns fråga exponerat alla väntande koder/mailadresser
    i hela appen för vem som helst inloggad.
- `test/firestore.rules.test.ts`: utökat med 31 nya tester (47 totalt)
  för allt ovan — KÖRDA mot lokal emulator, alla gröna
  (`firebase emulators:exec --only firestore "npm run test:rules"`).
- UI: `CalendarManagerPanel` fick en "+ Anhörig"-knapp per kalenderrad
  (mail + roll-val, visar om resultatet blev en kod direkt eller
  "väntar på godkännande"). Ny `PendingCalendarInvites`-komponent
  (samma mönster som `PendingStructureRequests`) visar väntande
  inbjudningar för den inloggade föräldern att godkänna/neka, ny hook
  `useCalendarInvitesPendingApproval`. `lib/onboardingClient.ts` fick
  `respondToCalendarInvite()` och `createCalendarInvite()` en valfri
  `{ role, invitedEmail }`.
- `npx tsc --noEmit` (frontend) och `npm run build` (functions) gröna.

**Medvetet OGJORT — etapp 4, inte den här sessionen:** den riktiga
"flera godkännare"-transaktionen för `shiftRequests` när en anhörig
föreslår ett byte (`requiredApprovers`/`approvedBy` på
`ShiftRequestDoc` finns i typen sedan etapp 1, men ingen callable
verkställer den logiken än). Tills dess kan en anhörigs bytesförslag
godkännas av en enda förälder, precis som en förälders eget.

**Deploy — GJORD 2026-09-25 (första omgången):** regler → functions →
hosting, alla lyckades; `approveCalendarInvite` skapades som ny
funktion i `europe-north1`.

**Kennys första riktiga test hittade tre buggar**, alla fixade i koden
men ANNU INTE deployade:

1. `app/join/page.tsx` fångade ALLA fel från `acceptCalendarInvite`
   och föll tyst tillbaka på det orelaterade familjeflödet
   (`acceptInvite`) — så "koden har gått ut" kom från fel ställe, inte
   från den äkta kalenderinbjudan (som bara var ~2h gammal). Nu faller
   den bara tillbaka på `functions/not-found` (dvs "det här är ingen
   kalenderinbjudan alls"); alla andra fel visas som de är.
2. `AuthGate.tsx` använde `pathname === "/join"` (exakt match) för att
   släppa igenom inbjudningssidan utan inloggnings-/onboardingtvång —
   bytt till `startsWith("/join")` som en härdning (den exakta
   grundorsaken till att en testanvändare hamnade i den vanliga
   "skapa din första kalender"-onboardingen kunde inte bekräftas utan
   en levande session).
3. `approveCalendarInvite` gav aldrig en väntande inbjudan en FÄRSK
   48-timmarsfrist när den väl skickades — fristen räknades från när
   den skapades, inte från när den godkändes. Ofarligt just den här
   gången (bara 2h hade gått) men en riktig bugg vid en långsammare
   medförälder. Fixad. Mailtexten nämner nu också att mottagaren kan
   behöva skapa ett konto först.

**Kennys test avslöjade också en arkitektur-lucka**: efter att en
anhörig utan eget "hem-team" registrerat sig och gått med, hade hen
INGEN väg in i appen — `AuthGate`/`app/page.tsx` styrs helt av
`userDoc.teamId`, som `acceptCalendarInvite` med flit ALDRIG sätter
för role `relative`/`viewer`. Löst med en minimal version av **etapp
3**, byggd samma session:

- Ny callable `getMyCalendars()` (Admin SDK, kringgår rules) —
  collectionGroup-fråga på `children` där `memberUids` innehåller mitt
  uid, returnerar `{teamId, childId, childName, role, parentNames}`
  per kalender. Löser samtidigt att en anhörig annars inte får läsa
  `teams/{teamId}` alls (bara `isTeamMember` gör det) — namnen plockas
  ut server-sidan i stället.
- `AuthGate.tsx`: när `userDoc.teamId` saknas, fråga `getMyCalendars()`
  INNAN `OnboardingFlow` visas. Finns kalendrar → ny `RelativeHome.tsx`
  (egen enkel vy: schema, aktiviteter, och för `relative` även
  packlistor/anteckningar/todo — INTE chatt/ställning/barninfo/
  inställningar). Inga träffar → `OnboardingFlow` som förut.
- **Ny bugg hittad och fixad under bygget**: `useNotes`/`useTodos`/
  `useEventsForMonth` gör normalt en OFILTRERAD listfråga över hela
  kollektionen (filtrerar `childId` i klienten) — fungerar för en
  förälder (`isTeamMember` ger bred åtkomst) men NEKAS I SIN HELHET av
  Firestore för en anhörig, eftersom regeln kräver childId per
  dokument och frågan inte kan bevisas säker utan ett matchande
  `where()`. Redan LIVE i produktion sedan förra deployen, men ofarligt
  hittills (ingen anhörig hade nått den koden än). Alla tre hookarna
  fick ett nytt `strict`/`strictChildId`-läge (riktigt
  `where("childId","==",...)`) som `RelativeHome` använder. Bekräftat
  med regeltester: ofiltrerad → nekas, filtrerad → fungerar.
- Nya sammansatta index i `firestore.indexes.json`: `children`
  (collectionGroup, `memberUids` array-contains), `notes`
  (`childId`+`updatedAt`), `todos` (`childId`+`archived`+`createdAt`),
  `events` × 2 (`childId`+`startAt`, `childId`+`recurrence`+`startAt`).
  **INTE deployade än** — `getMyCalendars` och `RelativeHome` fungerar
  inte i produktion förrän `firebase deploy --only firestore:indexes`
  körts (indexbygge kan ta några minuter efter deploy).

**INTE med i den här minimala versionen** (skiljer den från hela
etapp 3-visionen): ingen riktig `+`-kalenderväljare mellan HELA appen
(bara inom `RelativeHome`), ingen enhetlig vy — en anhörig med EGET
team hoppar mellan två helt separata gränssnitt (sitt eget team och en
liten "växlare" in i `RelativeHome`, se nedan) i stället för att allt
ligger i samma `+`-väljare.

**Hittat och fixat SAMMA DAG, innan Kenny hann testa klart**: en
anhörig som REDAN har ett eget hem-team (t.ex. hans testkonto, som av
misstag fick ett eget team via bugg #2 ovan INNAN inbjudan hann gå
igenom) såg bara sitt eget team efter inloggning —
`getMyCalendars`-uppslaget i `AuthGate` kördes bara när
`userDoc.teamId` SAKNADES helt. `AuthGate` frågar nu ALLTID
`getMyCalendars()` när man är inloggad. Har man ett eget team OCH är
anhörig/utomstående någon annanstans, visas en liten rad ovanför appen
("Du är också anhörig hos X") som växlar in i `RelativeHome` för den
kalendern, med en "Tillbaka"-länk. `RelativeHome` fick en valfri
`onBack`-prop för detta (döljer Logga ut/Radera konto i det läget —
de hör hemma i den egna appens inställningar).

**Kvarstående innan riktig etapp 3/4:**
- Flera godkännare för `shiftRequests` (etapp 4).

**Deploy — GJORD 2026-09-25 (andra omgången):** indexes → functions →
hosting, alla lyckades. `getMyCalendars` skapad som ny funktion i
`europe-north1`. Indexbygget kan ta någon minut efter deploy på
befintlig data innan `getMyCalendars`/`RelativeHome` fungerar fullt ut
— om det första testet ger ett indexrelaterat fel, vänta en stund och
försök igen.

**Deploy — GJORD 2026-09-25 (tredje omgången):** functions → hosting.
`deleteMyAccount` skapad (ny, orelaterad funktion — permanent
kontoradering, kräver textbekräftelse "RADERA", finns i
`SettingsView` och `RelativeHome`; se `deleteMyAccount` i
functions/src/index.ts, inte specifikt dokumenterad här eftersom den
inte rör roller/medlemskap). Samma omgång: `AuthGate`-fixen för konton
med eget team som ÄVEN är anhörig/utomstående (se ovan).

**Testa som riktig användare, i tur och ordning:**
   - [ ] Bjud in en anhörig från en **ensamförälder**-kalender → ska
         bli `"sent"` direkt, koden mailad genast.
   - [ ] Bjud in en anhörig från en **tvåförälder**-kalender → ska bli
         `"pending_approval"` — godkänn som andra föräldern, verifiera
         mailet.
   - [ ] Klicka länken UTLOGGAD, i ett inkognitofönster: ska visa bara
         namn/mail/lösenord, INGEN "skapa din första kalender".
   - [ ] Efter registrering: ska hamna direkt i `RelativeHome`, inte
         "byta familj?" och inte "koden har gått ut".
   - [ ] Om testkontot redan har ett eget team (som Kennys
         hotmail-testkonto fick av misstag): logga in, leta efter
         raden "Du är också anhörig hos …" ovanför appen, klicka den.
   - [ ] `viewer`: ser schemat, ser inget annat.
   - [ ] `relative`: ser/lägger in i schema och listor, tar bara bort
         sina egna aktiviteter, ingen chatt.
   - [ ] Röktesta att förälder-flödet (befintlig "Bjud in" till andra
         föräldern) är oförändrat.
   - [ ] Testa "Radera konto" i inställningarna på ett TESTKONTO (inte
         ett riktigt) — bekräfta att RADERA-textrutan krävs och att
         kalendrar man delar med någon annan finns kvar hos dem efteråt.

## Läge just nu (efter enhetlig-UI/etapp 4-sessionen)

**Allt nedan ERSÄTTER checklistan direkt ovanför** (RelativeHome och
"Du är också anhörig hos …"-bannern finns inte längre — se varför i
"Status" högst upp).

**`RelativeHome.tsx` raderad helt.** `AuthGate.tsx` beslutar bara
onboarding-vs-app (inget team och inga kalendrar via `getMyCalendars`
→ `OnboardingFlow`, annars appen). `app/page.tsx` äger nu ALL logik för
vilken kalender som visas och vilken roll man har där:

- Ny hook `lib/hooks/useMyCalendars.ts` — tunn wrapper runt
  `getMyCalendars()`. Källan till "+"-väljaren.
- `app/page.tsx`: `activeCalendar` = en uttrycklig växling (satt direkt
  till HELA `MyCalendar`-objektet när man klickar en rad i
  `CalendarManagerPanel` — ingen väntan på ett nytt uppslag) > hemmateamet
  > första kalendern (en ren anhörig utan eget team). `teamId`/`myRole`
  derived därifrån, med en snabbväg som ALLTID antar "parent" direkt på
  hemmateamet utan att vänta på `getMyCalendars` — annars hade varje
  vanlig förälder sett en extra laddningsblinkning.
- `isOwnTeam` styr de tre läsningar som kräver `isTeamMember` (bara
  hemmateamet): `teams/{teamId}` (`useTeam`), `chatMessages`,
  `teamInvites`-listning. En SEPARAT `useTeam(homeTeamId)`-lyssnare
  (alltid aktiv, oavsett vilken kalender som visas) håller
  Inställningar (bjud in andra föräldern, team-namn) korrekt även när
  man tittar på en främmande kalender.
- På en främmande kalender byggs `parents` (namn + platshållarfärg) från
  `activeCalendar.parentNames` (redan levererat av `getMyCalendars`,
  Admin SDK) i stället för `teams/{teamId}`, som en anhörig/utomstående
  aldrig får läsa direkt.
- `dayBalance`/`balanceRequests`/`childInfo`/`accounts` frågas bara när
  `myRole === "parent"`. `useNotes`/`useTodos`/`useEventsForMonth` körs i
  `strict`-läge (redan byggt förra sessionen) när `!isOwnTeam`.
- `CalendarView.tsx`: ny `myRole`-prop. Ändringsläge-pennan och
  kugghjulet (`CalendarSettingsPanel`) nedtonade och en no-op för
  icke-förälder. Dagtryck är en no-op för `viewer`. `BottomNav.tsx` fick
  en `disabled`-prop (nedtonade, inaktiva flikar) — Chatt+Info avstängt
  för `relative`, Chatt+Listor+Info avstängt för `viewer`.
- `CalendarManagerPanel.tsx`: `calendars`-listan byggs nu från HELA
  `myCalendars` (inte bara `children` i eget team) — visar alla
  kalendrar man är med på, i alla familjer. Byt namn/Ta bort/Bjud
  in/"+ Anhörig" visas bara på rader där man själv är `parent`.
- `DayActionModal.tsx`: "Ta bort aktivitet" (✕) visas bara för
  `parent`, eller för den som skapade aktiviteten själv (`relative`
  bara sina egna). `EventOccurrence` (`lib/recurrence.ts`) fick ett
  `createdBy`-fält för detta.

**Etapp 4 — dubbelgodkännande, server-auktoritativt:**
- `ShiftRequestDoc.requiredApprovers`/`approvedBy` (fanns redan i
  typen) sätts av klienten (`lib/calendarActions.ts`,
  `buildShiftRequestDoc`) när `requestedBy` är en anhörig — men det är
  BARA en progressindikator. `approveShiftRequest`/
  `approveShiftRequestBatch` (`functions/src/index.ts`) räknar ALLTID
  ut de riktiga föräldra-id:na själva (`calendarParentIds` på
  child+team, hämtat i transaktionen) och ignorerar vad klienten skrev
  vid skapandet — en manipulerad `requiredApprovers` kan alltså inte
  kringgå dubbelgodkännandet.
- Ett godkännande som inte räcker (väntar på ytterligare en förälder)
  verkställer INGET — ingen ställnings-transaktion, status kvar
  `"pending"`, `approvedBy` fylls på. Först när alla nödvändiga
  (samma `blockingApprovers`-mönster som kalenderinbjudningar redan
  använder — en förälder i "notis"-läge räknas inte som nödvändig)
  har sagt ja verkställs bytet som idag.
  `lib/calendarActions.ts`: en anhörigs förslag tar ALLTID
  förfrågningsvägen (aldrig `applyScheduleChangeDirect`), oavsett
  mottagarens `scheduleChangeMode` — en anhörig kringgår aldrig
  godkännande. Chattposten som annars läggs till vid ett förslag
  hoppas över för en anhörigs förslag (chatten är stängd för den
  rollen, skrivningen skulle nekas).
- `PendingShiftRequests.tsx`/`DayActionModal.tsx`: liten textpolish som
  visar "kräver BÅDA föräldrarnas godkännande" respektive "väntar på
  ytterligare en förälder" när det gäller.

**INTE gjort den här omgången:**
- Avtalstexten (`lib/agreementText.ts`) nämner ännu inte uttryckligen
  att en anhörigs dag inte påverkar ställningen (beslutet är kodifierat
  i logiken, bara inte i den lästa texten).
- Inga `firestore.rules`/`firestore.indexes.json`-ändringar — allt ovan
  gick att bygga inom befintliga regler (bekräftat rad för rad mot
  filen innan kodning).

**Verifierat innan detta skrevs:** `npx tsc --noEmit` (rot),
`cd functions && npx tsc --noEmit` samt `npm run build` (functions),
`npm run build` (rot, Next-export, lint grönt),
`firebase emulators:exec --only firestore "npm run test:rules"` — 53/53
gröna (ingen regeländring gjord, så samma tester som innan).

**Testa som riktig användare, i tur och ordning (ersätter checklistan
ovanför):**
   - [ ] Logga in som en anhörig (`relative`): SAMMA UI som en förälder,
         Chatt-fliken och kugghjulet nedtonade och gör ingenting,
         "Ändringsläge"-pennan nedtonad. Tryck på en dag: Aktivitet
         fungerar, "Ändra ansvar" skapar en förfrågan.
   - [ ] Låt EN förälder godkänna den förfrågan — bytet ska INTE gälla
         än (fortfarande väntande, texten säger "väntar på ytterligare
         en förälder"). Låt den ANDRA föräldern godkänna — nu ska bytet
         verkställas och ställningen justeras.
   - [ ] Samma konto, tryck "+": ska visa BÅDA kalendrarna (om kontot
         också är anhörig/parent någon annanstans) i EN lista, växling
         fungerar direkt utan laddningsblinkning.
   - [ ] Ett konto som är `parent` i sitt eget team OCH `relative`
         någon annanstans: växla mellan dem via "+" — full åtkomst i sitt
         eget, begränsad i det andra, ingen separat vy längre.
   - [ ] `viewer`-konto: Chatt/Listor/Info nedtonade, dagtryck i
         kalendern gör ingenting.
   - [ ] Röktesta att det vanliga förälder-till-förälder-flödet
         (byte/godkännande, chatt, inställningar) är oförändrat.
   - [ ] Ny anhörig utan eget team, direkt efter registrering via
         `/join`: hamnar i SAMMA app-UI (inte en särskild vy), rätt
         kalender vald automatiskt.

## Rättelser efter Kennys riktiga användartest (2026-09-26, samma dag)

Tre buggar till hittades direkt när Kenny testade ovanstående skarpt.
Alla tre är fixade och deployade (functions + hosting + firestore:rules
i separata omgångar samma dag, se git-historiken på grenen för exakta
commits).

**1. `useChildren` listar ofiltrerat — nekas helt för en anhörig.**
En anhörig fastnade i "lägg till barn" trots att kalendern fanns.
`useChildren(teamId)` gör en OFILTRERAD listfråga över hela
children-kollektionen; firestore.rules kan inte bevisa att ALLA barn i
ett FRÄMMANDE team uppfyller `isCalendarParticipant` utan en matchande
`where()`, så Firestore nekar hela frågan (bekräftat med två nya
regeltester — den filtrerar INTE bort enskilda dokument, till skillnad
från vad kommentaren i firestore.rules påstod). Ny
`useChildrenByIds` (`where(documentId(), "in", ids)`) används i stället
för en främmande kalender.

**2. "Ändra ansvar" band sig till nästa ORDINARIE byte i cykeln**
(`getNextOrdinaryHandoff`) i stället för alltid exakt ett dygn från den
valda dagen. Gav en förhandsvisning som påstod att mottagaren skulle ha
ansvaret i flera dagar när den ordinarie blocket var längre än ett
dygn. `endAt` räknas nu alltid som bytestiden NÄSTA dag, samma mönster
som ändringsläget redan använder.

**3. Om-tolkning: en anhörigs "Ändra ansvar" innebär att ANHÖRIGEN
SJÄLV tar dagen — inte att en av de två föräldrarna byter med
varandra.** Ursprungsbygget (etapp 4, ovan) föreslog fel: "Livia tar
ansvaret" när en anhörig klickade Kennys dag, som om anhörigen bad
Livia ta över. Kenny (2026-09-26): rubriken/texten ska säga "Du tar
över ansvaret" / "Du som anhörig har ansvaret", och
`takingOverParentId` på `ShiftRequestDoc` sätts nu till ANHÖRIGENS EGET
uid när `myRole !== "parent"` (inte längre `otherParent.id`).
Konsekvenser, redan hanterade:
  - `lib/dayBalance.ts`: `calculateShiftDeltaDays` returnerar 0 om
    `takingOverParentId` inte matchar någon av cykelns riktiga
    föräldra-id:n (`cycle.blocks`) — en anhörigs dag påverkar
    fortsatt INTE ställningen, nu även när fältet pekar på en
    tredje person i stället för "fel" förälder.
  - `app/page.tsx`: `approvedShiftRequests`/`pendingShiftRequests` som
    skickas till `CalendarView` (bar-färgen på dagen) filtreras till
    bara riktiga föräldra-id:n — Kennys uttryckliga val ("dagens färg
    orörd") betyder att en anhörigs dag INTE ska måla om
    kalenderstapeln. `PendingShiftRequests`-bannern (godkänn/avböj)
    använder fortfarande OFILTRERADE listan, oförändrat.
  - `PendingShiftRequests.tsx`: visar "En anhörig tar ansvaret" i
    stället för felaktigt "Andra föräldern" när takingOverParentId inte
    är en känd förälder.

## Kalendertagg för en anhörigs godkända dag (byggd samma dag)

Kenny valde (fråga: "vad ska hända på kalendern") "aktivitetstagg
ovanpå, dagens färg orörd". Byggt:

- **Namnproblemet löst:** `child.members[uid]` (bara relative/viewer)
  fick ett nytt valfritt `displayName`-fält (`types/schema.ts`) — den
  enda platsen föräldrarna redan har läsrätt till för en anhörigs namn,
  eftersom en anhörig saknar `users.teamId` (kan inte cachas i
  `teams/{teamId}.parentProfiles` som en förälders). Sätts av
  `acceptCalendarInvite` vid anslutning; `syncDisplayNameToTeam`
  (`functions/src/index.ts`, lyssnar redan på `users/{uid}`-skrivningar
  för föräldrarnas `parentProfiles`) uppdaterar nu ÄVEN
  `members[uid].displayName` på alla kalendrar personen är
  relative/viewer på (collectionGroup-fråga på `memberUids`, samma
  index som `getMyCalendars` redan använder) om hen byter namn senare.
- `app/page.tsx`: `custodyTags` — de godkända shiftRequests där
  `takingOverParentId` INTE är en av de två riktiga föräldrarna, mappade
  till `{date, label}` via `activeChild.members[uid].displayName`
  (fallback "Anhörig" om det saknas, t.ex. gamla dokument från innan
  fältet fanns).
- `CalendarView.tsx`: ny `custodyTags`-prop, renderas som en lila tagg
  ("Hos {namn}") i samma rad som aktivitetstaggarna — bara på
  STARTDAGEN (ett "Ändra ansvar"-byte är alltid exakt ett dygn, ingen
  anledning till en halvdags-uppdelning för en ren informationstagg).
  Målar INTE om bar-färgen — det är fortfarande filtrerat bort separat
  (se ovan).

**Kvarstår:** ett konto som redan hann bli medlem INNAN den här
sessionen (om något sådant finns i produktion) saknar `displayName` i
sitt `members`-dokument tills personen byter namn en gång (triggern
körs bara på namnÄNDRING, inte retroaktivt) — visas då som "Anhörig" i
taggen/bannern i stället för det riktiga namnet. Ofarligt, bara kosmetiskt.

## Buggfix: ren anhörig som skapar sin FÖRSTA egna kalender (via "+")

Kenny (anhörig-kontot): "+" → "+ Ny kalender" → skrev ett namn → Spara
→ "Kunde inte spara. Försök igen.", `addChild` 403 i nätverksloggen.

Roten: `handleCreateCalendar` (app/page.tsx) skapar ett nytt team
(`createFamilyTeam`) och barnet (`addChild`) korrekt, men satte sen
`activeCalendarOverride` till `null` i tron att `homeTeamId`/
`homeCalendar` skulle lösa resten. `myCalendars` (från `getMyCalendars`)
hämtas bara EN gång, inte i realtid — den visste ingenting om den
NYSKAPADE kalendern. Resultat: `teamId` (härlett från `activeCalendar`)
pekade kvar på den FÖRRA aktiva kalendern (en anhörig-kalender i en
annan familj) medan `selectedChildId` redan pekade på det NYA barnet —
ingen matchning, `activeChild` blev `null`, `AddFirstChildScreen`
visades i onödan, och DEN skärmens egen "Spara" skickade
`addChild(fel-teamId, …)` — 403, eftersom man inte är förälder i den
andra familjens team.

Fix: `handleCreateCalendar` sätter nu `activeCalendarOverride` DIREKT
till ett komplett `MyCalendar`-objekt för den nyss skapade kalendern
(`{teamId, childId, childName, role: "parent", parentNames}`) i
stället för att lita på en föråldrad `myCalendars`-lista, och anropar
`refreshMyCalendars()` (ny — `useMyCalendars` exponerar nu sin
`refresh`) i bakgrunden så "+"-listan stämmer nästa gång den öppnas.
Påverkar bara EN ren anhörigs FÖRSTA egna kalender — en befintlig
förälders "lägg till syskon" träffades aldrig av buggen (teamId var
redan korrekt där, oavsett `myCalendars`-cachens ålder).

Verifierat: tsc, Next-build. Ingen ny regeltest behövdes (ingen
regeländring).

## UI-fix: kalendernamnet klämdes ihop i "+"-panelen

Kenny (riktig användartest, direkt efter att ha lagt till en ny
kalender): namnet och hanteringsknapparna (Byt namn/Bjud in/
+ Anhörig/✕) låg i samma flex-rad i `CalendarManagerPanel.tsx`, vilket
klämde långa kalendernamn ner till bara ett par tecken ("te…"). Namnet
ligger nu på egen rad med full bredd, knapparna på en rad under
(radbryter vid behov). Rent CSS/layout, ingen logikändring.

Verifierat: tsc grönt. Lokal `npm run build` OOM:ade (node, oberoende
av ändringen — samma maskin som byggt grönt tidigare), så CI:s
build-steg i deploy-jobbet var grinden.

**Deploy — GJORD 2026-09-27** (`d766a35`, workflow-run 93, manuell
`workflow_dispatch`): bygg + deploy, `conclusion: success` i alla steg.

## Anhörig/utomstående kunde inte lämna en kalender

Kenny (riktig användartest, samma dag): ✕ i "+"-panelen syntes knappt
(för svag kontrast), och en anhörig-rad ("Lova", roll Anhörig) hade
INGA knappar alls — `canManage` (bara `role === "parent"`) gate:ade
hela knapprad-diven, ✕ inkluderad. En anhörig/utomstående kunde alltså
aldrig lämna en kalender de inte längre ville ha kvar.

Kennys spec: tryck ✕ → skriv "RADERA" för att bekräfta (samma mönster
som `DeleteAccountDialog`). Lämnar tar ALDRIG bort kalendern för andra
— den raderas helt bara när ALLA medlemmar (föräldrar OCH
anhöriga/utomstående) har lämnat. Ett konto utan någon kalender kvar
ska se appens vanliga skal (flikrad, "+"), bara tomt/avstängt — inte
kastas tillbaka till en särskild onboardingskärm.

Byggt:

- **`functions/src/index.ts` `deleteChild`**: kräver nu `confirmation:
  "RADERA"`. Permission-kollen bytt från `calendarParentIds(...).includes(uid)`
  (bara föräldrar) till `calendarRoleFor(uid, child, team)` (alla tre
  roller). "Sista medlemmen"-gränsen räknas nu på ALLA i
  `child.memberUids` (fallback `calendarParentIds` för kalendrar från
  innan fältet fanns), inte bara kvarvarande föräldrar — en kalender med
  en förälder och två anhöriga raderas INTE när föräldern lämnar, bara
  när alla tre har gjort det. En anhörig/utomstående som lämnar rör
  varken `parentIds`, grundschemat eller prenumerationstoken (fanns
  aldrig där); en förälder som lämnar städar nu ÄVEN
  `members`/`memberUids` (en lucka `deleteChild` hade sedan tidigare —
  bara `deleteMyAccount` gjorde det rätt, se kommentaren i koden om
  varför).
  KÄND KVARSTÅENDE LUCKA: lämnar BÅDA en kalenders riktiga föräldrar
  (var för sig) medan en anhörig är kvar, faller `calendarParentIds()`
  tillbaka på `teams.parentIds` för en tom `child.parentIds` — de
  avgångna dyker upp igen som "kalenderns föräldrar" för den
  kvarvarande anhörigen. Kosmetiskt, ingen krasch, inte fixat (se
  kommentaren i `deleteChild`).
- **`getMyCalendars`**: `MyCalendar` fick `memberCount` (alla roller,
  inte bara `Object.keys(parentNames).length` som klienten räknade
  förut) — annars visade "Lämna"/"Ta bort"-texten fel för en kalender
  med både föräldrar och anhöriga.
- **`CalendarManagerPanel.tsx`**: ✕ flyttad UT ur `canManage`-blocket —
  Byt namn/Bjud in/+ Anhörig är fortsatt bara för förälder-rader, ✕
  gäller alla. Kontrasten höjd (`text-stone-300` → `text-stone-400`,
  samma som övriga knappar). Bekräftelsen är nu ett textfält ("Skriv
  RADERA"), knappen inaktiv tills det matchar exakt — samma mönster som
  `DeleteAccountDialog`. Den gamla `isLastCalendar`-spärren (kunde inte
  ta bort sin sista egna kalender) är borttagen: att hamna helt utan
  kalender är nu ett avsett, hanterat sluttillstånd (se nedan).
- **Ny `components/EmptyCalendarState.tsx`**, ersätter
  `AddFirstChildScreen` (borttagen helt) i `app/page.tsx`s
  `!activeChild`-gren. Samma app-skal som resten av appen: header med
  fungerande "+" (öppnar `CalendarManagerPanel`, kan skapa ELLER gå med
  i en kalender), `BottomNav` med ALLA flikar avstängda
  (`disabled`-propet), en central "Ingen kalender än"-text, "Logga ut".
  Täcker både äkta mellanlandning (team skapat, inget barn än — gamla
  `AddFirstChildScreen`s scenario) och det NYA fallet (lämnat/raderat
  sin sista kalender) — går inte att skilja dem åt (`myCalendars.length
  === 0` i båda), och samma skärm är rätt för båda.
  **Sidoeffekt, upptäckt under bygget:** `AddFirstChildScreen`s
  `onAddChild` anropade `addChild(teamId!, ...)` med ett
  icke-null-assert `teamId` — skulle ha kraschat (skickat `undefined`)
  för en RENDÖD anhörig utan eget hemteam som når noll kalendrar, ett
  läge som inte gick att nå innan den här sessionen. Fixat på köpet:
  `EmptyCalendarState` går via `handleCreateCalendar`, som redan
  hanterar "skapa eget team om det saknas" korrekt.
- **`BottomNav`s `disabled`-prop var aldrig kopplad** — `disabledSections`
  (viewer/relative) räknades ut i `app/page.tsx` men skickades bara till
  en `useEffect` som bytte tillbaka till Schema EFTER ett render (en
  synlig studs, inte en nedtonad/inaktiv flik som dokumentationen redan
  påstod). Kopplad nu: `<BottomNav ... disabled={disabledSections} />`.
- `handleDeleteCalendar` (app/page.tsx) tar nu emot kalenderns EGNA
  `teamId` (från `ManagedCalendar`, inte `homeTeamId` som bara finns
  för det egna hemmateamet) — annars omöjligt att lämna en FRÄMMANDE
  kalender. Nollställer `activeCalendarOverride` om den pekade på den
  borttagna kalendern, och anropar `refreshMyCalendars()` — annars låg
  den kvar i "+"-listan tills sidan laddades om.

Verifierat: `npx tsc --noEmit` (rot), `cd functions && npx tsc --noEmit`
samt `npm run build` (functions), `npm run build` (rot, Next-export) —
alla gröna. Ingen regeländring (allt sitter i callablen, Admin SDK
kringgår `firestore.rules`), så inga nya regeltester.

**Deploy — GJORD 2026-09-27** (`a0d57b0`, workflow-run 36312184101,
manuell `workflow_dispatch`, `target: hosting,functions`):
`conclusion: success` i alla steg.

## Två småbuggar till, samma dags användartest

Kenny: "En anhörig tar ansvaret för Lova" sa inte VEM. Och ett
namnbyte på en kalender syntes inte i "+"-panelen förrän sidan
laddades om.

- **`PendingShiftRequests.tsx`**: `takingOverLabel` kände bara till
  `parentNames` (de två riktiga föräldrarna) — en anhörigs egen
  förfrågan (`takingOverParentId === requestedBy`, ingen av de två)
  föll tillbaka på det namnlösa "En anhörig". Ny `relativeNames`-prop
  (uid -> `child.members[uid].displayName`, samma fält CalendarView
  redan använder för kalendertaggen "Hos {namn}", byggd i
  `app/page.tsx`) gör texten "En anhörig {namn} tar ansvaret för
  {kalender}". Saknas `displayName` (gammalt medlemskap från innan
  fältet fanns) blir det fortsatt bara "En anhörig", som innan.
- **`handleRenameCalendar`** (app/page.tsx) anropade aldrig
  `refreshMyCalendars()` efter ett lyckat namnbyte. Kalenderns egen
  header uppdaterades direkt (lyssnar på `children/{childId}` i
  realtid), men "+"-panelens lista bygger på `myCalendars`
  (`getMyCalendars`), en engångshämtning — samma mönster som redan
  fanns för skapa/ta bort-kalender, bara aldrig kopplat på rename.

Verifierat: `npx tsc --noEmit` (rot), `npm run build` (rot) gröna.
Inga functions-ändringar, ingen regeländring.

**Deploy — GJORD 2026-09-27** (`5f006ca`, workflow-run 36332437393,
manuell `workflow_dispatch`, `target: hosting,functions`):
`conclusion: success` i alla steg.

**Testa som riktig användare:**
   - [ ] Anhörig-konto: ✕ på en kalender där du bara är anhörig →
         skriv RADERA → försvinner ur din "+"-lista, finns kvar hos
         föräldrarna.
   - [ ] Ta bort ALLA dina kalendrar (anhörig utan eget team): hamnar i
         det tomma app-skalet, inte en gammal-stil onboardingskärm.
         "+" fungerar därifrån för att skapa en ny.
   - [ ] Förälder: lämna en kalender med en anhörig kvar på — kalendern
         ska INTE raderas, ska finnas kvar för den anhörige.
   - [ ] Sista medlemmen av alla roller lämnar → kalendern raderas helt
         (som innan).
   - [ ] Viewer/relative: kolla att avstängda flikar nu ser nedtonade ut
         direkt (inte en studs tillbaka till Schema).
