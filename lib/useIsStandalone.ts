"use client";

import { useEffect, useState } from "react";

/**
 * Om appen körs som installerad PWA (öppnad från hemskärmen) eller i
 * en vanlig webbläsarflik.
 *
 * null = ännu inte avgjort (bara under den allra första rendern på
 * klienten, innan window finns) — AuthGate visar samma "Laddar…"-skärm
 * den redan har för auth, så det blir ingen synlig blinkning.
 *
 * Varför det här behövs alls: Google Cloud kräver att hemsidan (/) går
 * att se utan inloggning och förklarar vad appen är (branding-
 * granskningen för OAuth). Men den som redan har appen på hemskärmen
 * ska rakt in i schemat, som innan — de har redan valt att installera
 * den och vill inte se en landningssida varje gång de öppnar den.
 * matchMedia("display-mode: standalone") skiljer de två fallen åt:
 * sant för hemskärms-appen, falskt för en vanlig flik i Chrome/Safari.
 */
export function useIsStandalone(): boolean | null {
  const [standalone, setStandalone] = useState<boolean | null>(null);

  useEffect(() => {
    const mql = window.matchMedia("(display-mode: standalone)");
    // iOS Safari har aldrig implementerat display-mode-medieförfrågan
    // fullt ut historiskt — navigator.standalone är dess egen,
    // äldre motsvarighet. Utan den skulle iOS-hemskärmsanvändare felaktigt
    // klassas som webbläsarbesökare och se landningssidan varje gång.
    const iosStandalone = (navigator as unknown as { standalone?: boolean }).standalone === true;
    setStandalone(mql.matches || iosStandalone);

    const onChange = (e: MediaQueryListEvent) => setStandalone(e.matches || iosStandalone);
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, []);

  return standalone;
}
