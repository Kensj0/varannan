# Roller och medlemskap — arbetsplan

Levande dokument. Uppdateras efterhand som etapper blir klara, så att
nästa session (eller nästa person) ser var arbetet står utan att gräva
i commit-historiken.

**Status:** Etapp 1 pågår.

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

- [ ] **1. Roller och regler** (tyngst, mest riskabel)
      Rollerna in i datamodellen, `firestore.rules` skrivs om från
      `isTeamMember` till kalendermedlemskap + roll. Migrering av
      befintlig data: varje `child.parentIds` blir en `members`-map.
      Migreringen ska vara idempotent och bara ADDERA — aldrig radera
      `parentIds`. Regeltester i Firebase-emulatorn INNAN deploy.
- [ ] **2. Inbjudningsflöde med dubbelt godkännande**
      "Bjud in"-knapp, dialog med mail + roll. Inbjudan skapas i
      väntläge, andra föräldern notifieras (push + mail, infrastrukturen
      finns sedan `dbe342a`), koden genereras och mailas först efter ja.
- [ ] **3. Medlemskap per kalender över teamgränser**
      collectionGroup-fråga på `children` där `memberUids` innehåller
      mitt uid. `+`-väljaren fungerar rakt av när listan kommer därifrån.
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
