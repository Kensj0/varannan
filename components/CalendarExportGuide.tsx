"use client";

import { useState } from "react";
import { CalendarFeedLinks } from "../lib/calendarExport";

type Platform = "google" | "apple" | "outlook";

interface Person {
  label: string;
  hex: string;
  links: CalendarFeedLinks;
}

interface CalendarExportGuideProps {
  onClose: () => void;
  /** Inloggad förälder först, den andra sedan (om hen finns). */
  people: Person[];
}

const PLATFORMS: { id: Platform; label: string }[] = [
  { id: "google", label: "Google" },
  { id: "apple", label: "iPhone / Apple" },
  { id: "outlook", label: "Outlook" },
];

/**
 * Steg-för-steg-guide för att prenumerera på schemat.
 *
 * Google fick tidigare en djuplänk (/r/settings/addbyurl?cid=…) som
 * skulle förifylla adressen åt användaren. Den slutade fungera och gav
 * "Det gick inte att lägga till kalender. Kontrollera webbadressen" —
 * trots att flödet självt svarade 200. Att kopiera länken och klistra
 * in den manuellt är omväg nog att beskriva, men det fungerar, och det
 * slutar inte fungera för att Google gör om sina inställningssidor.
 */
export default function CalendarExportGuide({ onClose, people }: CalendarExportGuideProps) {
  const [platform, setPlatform] = useState<Platform>("google");
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null);
  const [copyFailed, setCopyFailed] = useState(false);

  async function copy(url: string, index: number) {
    setCopyFailed(false);
    try {
      await navigator.clipboard.writeText(url);
      setCopiedIndex(index);
      setTimeout(() => setCopiedIndex(null), 2000);
    } catch {
      setCopyFailed(true);
    }
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-end justify-center sm:items-center">
      <div className="absolute inset-0 bg-stone-900/40" onClick={onClose} />

      <div className="relative z-10 max-h-[85vh] w-full max-w-md overflow-y-auto rounded-t-3xl bg-white p-5 shadow-xl sm:rounded-3xl">
        <div className="mb-4 flex items-start justify-between gap-3">
          <h2 className="text-lg font-bold text-stone-800">Exportera kalender</h2>
          <button
            onClick={onClose}
            aria-label="Stäng"
            className="grid h-7 w-7 shrink-0 place-items-center rounded-full text-stone-400 hover:bg-stone-50"
          >
            ✕
          </button>
        </div>

        <div className="mb-4 flex gap-1 rounded-full bg-stone-100 p-1">
          {PLATFORMS.map((option) => (
            <button
              key={option.id}
              onClick={() => setPlatform(option.id)}
              className={`flex-1 rounded-full px-2 py-1.5 text-xs font-semibold transition ${
                platform === option.id ? "bg-white text-stone-800 shadow-sm" : "text-stone-500"
              }`}
            >
              {option.label}
            </button>
          ))}
        </div>

        {platform === "google" && <GoogleSteps people={people} onCopy={copy} copiedIndex={copiedIndex} />}
        {platform === "apple" && <AppleSteps people={people} />}
        {platform === "outlook" && <OutlookSteps people={people} onCopy={copy} copiedIndex={copiedIndex} />}

        {copyFailed && (
          <p className="mt-3 text-xs text-rose-600">
            Kunde inte kopiera automatiskt. Markera länken och kopiera den manuellt.
          </p>
        )}

        <p className="mt-4 border-t border-stone-100 pt-3 text-[11px] leading-snug text-stone-400">
          Vem som helst med länken kan läsa schemat. Kalendern uppdateras av sig själv, men Google
          hämtar bara nytt ungefär var åttonde timme — ändringar syns alltså inte direkt.
        </p>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

function Step({ n, title, children }: { n: number; title: string; children?: React.ReactNode }) {
  return (
    <div className="flex gap-3">
      <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-rose-100 text-xs font-bold text-rose-600">
        {n}
      </span>
      <div className="min-w-0 flex-1 pb-4">
        <p className="text-sm font-medium text-stone-800">{title}</p>
        {children}
      </div>
    </div>
  );
}

function CopyRow({
  person,
  index,
  onCopy,
  copiedIndex,
}: {
  person: Person;
  index: number;
  onCopy: (url: string, index: number) => void;
  copiedIndex: number | null;
}) {
  return (
    <button
      onClick={() => onCopy(person.links.ics, index)}
      className="mt-1.5 flex w-full items-center gap-2 rounded-lg bg-stone-50 px-3 py-2 text-left hover:bg-stone-100"
    >
      <span
        className="h-2.5 w-2.5 shrink-0 rounded-full"
        style={{ backgroundColor: person.hex }}
        aria-hidden
      />
      <span className="min-w-0 flex-1 truncate text-sm text-stone-700">{person.label}</span>
      <span className="shrink-0 text-xs font-semibold text-rose-600">
        {copiedIndex === index ? "Kopierad!" : "Kopiera"}
      </span>
    </button>
  );
}

function GoogleSteps({
  people,
  onCopy,
  copiedIndex,
}: {
  people: Person[];
  onCopy: (url: string, index: number) => void;
  copiedIndex: number | null;
}) {
  return (
    <div>
      <Step n={1} title="Kopiera länken">
        {people.map((person, i) => (
          <CopyRow key={person.label} person={person} index={i} onCopy={onCopy} copiedIndex={copiedIndex} />
        ))}
        {people.length > 1 && (
          <p className="mt-1.5 text-[11px] leading-snug text-stone-400">
            En kalender per person. Google färgar per kalender, så det är uppdelningen som ger er var
            sin färg.
          </p>
        )}
      </Step>

      <Step n={2} title="Öppna Google Kalender på dator">
        <a
          href="https://calendar.google.com/calendar/u/0/r/settings/addbyurl"
          target="_blank"
          rel="noopener noreferrer"
          className="mt-1.5 inline-block text-sm font-medium text-rose-600 hover:underline"
        >
          Öppna “Lägg till via webbadress” →
        </a>
        <p className="mt-1 text-[11px] leading-snug text-stone-400">
          Går inte att göra i mobilappen — Google tillåter bara nya prenumerationer från webben.
        </p>
      </Step>

      <Step n={3} title="Klistra in och tryck “Lägg till kalender”" />

      <Step n={4} title="Välj färg">
        <p className="mt-1 text-[11px] leading-snug text-stone-400">
          Håll muspekaren över kalendern i vänsterlisten, tryck på de tre prickarna och välj samma
          färg som pricken ovan.
        </p>
      </Step>

      {people.length > 1 && <Step n={5} title="Gör om steg 1–4 för den andra länken" />}
    </div>
  );
}

function AppleSteps({ people }: { people: Person[] }) {
  return (
    <div>
      <Step n={1} title="Tryck på länken här nedan">
        {people.map((person) => (
          <a
            key={person.label}
            href={person.links.webcal}
            className="mt-1.5 flex w-full items-center gap-2 rounded-lg bg-stone-50 px-3 py-2 hover:bg-stone-100"
          >
            <span
              className="h-2.5 w-2.5 shrink-0 rounded-full"
              style={{ backgroundColor: person.hex }}
              aria-hidden
            />
            <span className="min-w-0 flex-1 truncate text-sm text-stone-700">{person.label}</span>
            <span className="shrink-0 text-xs font-semibold text-rose-600">Lägg till</span>
          </a>
        ))}
      </Step>

      <Step n={2} title="Bekräfta i Kalender-appen">
        <p className="mt-1 text-[11px] leading-snug text-stone-400">
          Färgen följer med automatiskt — Apple läser den ur schemat.
        </p>
      </Step>
    </div>
  );
}

function OutlookSteps({
  people,
  onCopy,
  copiedIndex,
}: {
  people: Person[];
  onCopy: (url: string, index: number) => void;
  copiedIndex: number | null;
}) {
  return (
    <div>
      <Step n={1} title="Kopiera länken">
        {people.map((person, i) => (
          <CopyRow key={person.label} person={person} index={i} onCopy={onCopy} copiedIndex={copiedIndex} />
        ))}
      </Step>

      <Step n={2} title="Öppna Outlook-kalendern">
        <a
          href="https://outlook.live.com/calendar/0/addcalendar"
          target="_blank"
          rel="noopener noreferrer"
          className="mt-1.5 inline-block text-sm font-medium text-rose-600 hover:underline"
        >
          Öppna “Lägg till kalender” →
        </a>
      </Step>

      <Step n={3} title="Välj “Prenumerera från webben”, klistra in och importera" />
    </div>
  );
}
