/**
 * agreementText.ts
 * ----------------
 * Fast, oredigerbar text för "Avtal"-dialogen (se AgreementDialog.tsx,
 * öppnas från CalendarSettingsPanel.tsx). Beskriver hur appen redan
 * fungerar, och vad föräldrarna i praktiken förbinder sig till genom
 * att använda den.
 *
 * Nämner medvetet inte barnets namn — texten är generell och knuten
 * till schemat, inte till ett specifikt barn.
 *
 * Ändras innehållet här, syns det direkt i appen nästa gång någon
 * öppnar dialogen — ingen databas, inget separat innehållssystem.
 */

export interface AgreementSection {
  title: string;
  body: string;
}

export const AGREEMENT_SECTIONS: AgreementSection[] = [
  {
    title: "1. Grundschemat",
    body:
      "Det schema ni satt upp tillsammans (t.ex. varannan vecka, eller ett 2-2-3-mönster) är den överenskommelse som gäller. Grundschemat kan bara ändras genom att båda föräldrar godkänner ändringen i appen — aldrig ensidigt. Så länge en ändring inte är godkänd av er båda gäller det befintliga grundschemat fullt ut.",
  },
  {
    title: "2. Lagt kort ligger",
    body:
      "En ändring av vem som har ansvar en viss dag gäller precis lika mycket som grundschemat, oavsett om ni godkände den i förväg eller bara notifierades. Lagt kort ligger. Välj notifiering bara om ni litar på att den andra föräldern skickar ändringar ni faktiskt kan stå bakom.",
  },
  {
    title: "3. Flexibilitet och omtanke",
    body:
      "Ni förbinder er att vara överseende och i möjligaste mån anpassa er till förfrågningar från den andra föräldern om enskilda byten — så länge det är rimligt och inte går ut över barnet. Att ge varandra utrymme att leva sina liv gynnar er båda, och därmed barnet.",
  },
  {
    title: "4. Aktiviteter",
    body:
      "Aktiviteter och kalenderposter (t.ex. fritidsaktiviteter, läkarbesök) är bara information till varandra — de ändrar aldrig vem som har det formella ansvaret enligt schemat.",
  },
  {
    title: "5. Vid oenighet",
    body:
      "Kommer ni inte överens om en föreslagen ändring gäller alltid det senast gemensamt godkända grundschemat. Ingen kan ensidigt driva igenom en ändring genom att agera som om den gällde.",
  },
  {
    title: "6. Detta är en överenskommelse mellan er",
    body:
      "Avtalet är inte ett juridiskt bindande kontrakt, utan ett löfte att respektera det ni kommit överens om. Ändras era omständigheter är ni fria att föreslå ett nytt grundschema — det gäller först när ni båda godkänt det.",
  },
];
