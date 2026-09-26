"use client";

import { useCallback, useEffect, useState } from "react";
import { getMyCalendars, MyCalendar } from "../onboardingClient";

/**
 * Alla kalendrar (uid) är med på, i ALLA familjer — inklusive det egna
 * hemmateamet (roll "parent" där). Se getMyCalendars i
 * functions/src/index.ts. Engångshämtning, ingen realtidslyssnare
 * (samma mönster som AuthGate redan använde för samma anrop) — `refresh`
 * finns för att hämta om efter en handling som ändrar listan (t.ex. gå
 * med i en ny kalender via /join).
 *
 * `null` = inte hämtat än (eller ingen inloggad användare), `[]` = hämtat,
 * inga träffar. Skilj på dem: en anhörig utan users.teamId ska INTE
 * flasha till onboarding innan uppslaget hunnit svara.
 */
export function useMyCalendars(userUid: string | null | undefined): {
  calendars: MyCalendar[] | null;
  refresh: () => void;
} {
  const [calendars, setCalendars] = useState<MyCalendar[] | null>(null);
  const [refreshToken, setRefreshToken] = useState(0);

  useEffect(() => {
    if (!userUid) {
      setCalendars(null);
      return;
    }
    let cancelled = false;
    getMyCalendars()
      .then((cals) => {
        if (!cancelled) setCalendars(cals);
      })
      .catch(() => {
        // Ovanligt fel (nätverk, ej inloggad ännu på servern) — hellre
        // tomt än att fastna i "laddar" för alltid.
        if (!cancelled) setCalendars([]);
      });
    return () => {
      cancelled = true;
    };
  }, [userUid, refreshToken]);

  const refresh = useCallback(() => setRefreshToken((t) => t + 1), []);

  return { calendars, refresh };
}
