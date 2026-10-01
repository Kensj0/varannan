# Google Kalender-synk

Frivillig koppling: användaren kopplar sitt Google-konto i Inställningar,
och Varannan skriver ansvarsblock och aktiviteter till en egen kalender
per Varannan-kalender ("Lova – Varannan") i användarens Google-konto.
ICS-prenumerationen finns kvar som alternativ utan Google-konto.

Kod: `functions/src/googleCalendarSync.ts` (server), `lib/googleCalendarClient.ts`
och `components/GoogleCalendarCard.tsx` (klient). Token ligger i
`googleCalendarTokens/{uid}`, som `firestore.rules` stänger helt för klienten.

## Engångsinställning (innan första deploy)

1. **Slå på Google Calendar API** i projektet `varannan-familj`:
   Google Cloud Console → APIs & Services → Library → "Google Calendar API" → Enable.

2. **Lägg till redirect-URI på den befintliga OAuth-klienten.** Använd
   samma klient som Google-inloggningen redan använder ("Web client (auto
   created by Google Service)") — då finns bara en klient i projektet,
   vilket gör granskningen och videon enklare.
   APIs & Services → Credentials → klicka på klienten → under
   "Authorized redirect URIs" lägg till exakt:
   `https://varannan.se/oauth/google/callback`
   → Save. Kopiera samtidigt **Client ID** och **Client secret**.

3. **Spara dem som secrets** (frågar efter värdet, klistra in):
   ```
   cd C:\Firebase\Varannan
   firebase functions:secrets:set GOOGLE_OAUTH_CLIENT_ID
   firebase functions:secrets:set GOOGLE_OAUTH_CLIENT_SECRET
   ```

## Deploy

Regeltesterna först (ska vara gröna), sedan i den här ordningen —
functions före hosting, eftersom hosting-rewriten pekar på callbacken:
```
cd C:\Firebase\Varannan
git pull
npm install
firebase emulators:exec --only firestore "npm run test:rules"
firebase deploy --only firestore:rules
firebase deploy --only functions
npm run build
firebase deploy --only hosting
```
`firebase deploy --only functions` frågar om den gamla funktionen
`exportEventToGoogleCalendar` ska tas bort — svara **y** (den var ett
skelett som aldrig fungerade, ersatt av den här modulen).

## Demovideon till Googles granskning

Spela in på datorn (inte i den installerade mobilappen — där öppnas
Google-fönstret i en separat webbläsarflik). Visa adressfältet hela
tiden. Ca 2–3 minuter, engelska textrutor eller berättarröst hjälper.

1. Öppna `https://varannan.se`, visa startsidan och länken till integritetspolicyn.
2. Logga in med Google (visar inloggningens samtyckesfönster).
3. Gå till Inställningar → Google Kalender → "Koppla Google Kalender".
4. **Googles samtyckesfönster:** varningen "Google hasn't verified this
   app" ska synas — klicka "Advanced" → "Go to varannan.se". Visa
   tydligt att appen ber om Google Kalender och att rutan är ikryssad.
   Klicka "Continue".
5. Tillbaka i Varannan: "Google Kalender är kopplad".
6. Öppna Google Kalender i en ny flik: visa kalendern "<barn> – Varannan"
   med ansvarsblocken i föräldrarnas färger och aktiviteterna. Visa att
   dina andra kalendrar är orörda.
7. I Varannan: lägg till en aktivitet → tryck "Synka nu" (eller vänta
   några sekunder) → visa den i Google Kalender.
8. Ändra aktivitetens namn i Varannan → visa ändringen i Google.
9. Ta bort aktiviteten i Varannan → visa att den försvann i Google.
10. Inställningar → "Koppla bort Google Kalender" → bekräfta → visa att
    Varannan-kalendern försvann ur Google, och (valfritt) att Varannan
    inte längre finns under myaccount.google.com → Security → Third-party apps.

Ladda upp som **Unlisted** på YouTube, klistra in länken i
OAuth-granskningen och svara på mailtråden med Trust & Safety att
policyn och videon är uppdaterade.
