# Roller och medlemskap — arbetsplan

Levande dokument. Uppdateras efterhand som etapper blir klara, så att
nästa session (eller nästa person) ser var arbetet står utan att gräva
i commit-historiken.

**Status:** Etapp 1 OCH Etapp 2 — DEPLOYADE till produktion
(2026-09-25: regler, functions inklusive nya `approveCalendarInvite`,
och hosting). Regeltester (47/47) körda gröna innan reglerna
deployades. ÅTERSTÅR: Kenny testar som riktig användare (se
checklistan i "Läge just nu" längst ner) och etapp 3–4 är inte
påbörjade.

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
- [~] **3. Medlemskap per kalender över teamgränser** — MINIMAL VERSION
      byggd 2026-09-25, INTE DEPLOYAD. En riktig testanvändare fastnade
      annars i en återvändsgränd efter att ha gått med som anhörig (se
      "Läge just nu"). Inte hela visionen — se kvarstående där.
- [ ] **4. Anhörigs "ändra ansvar"**
      Flera godkännare på `ShiftRequestDoc`. Avtalstexten uppdateras med
      regeln att anhörigdagar inte påverkar ställningen.

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
