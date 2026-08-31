"use client";

import { useMemo, useState } from "react";
import { CustodyCycleBlock } from "../../types/schema";
import { CYCLE_PRESET_LIST, blocksFromPattern, validateCustodyCycleBlocks } from "../../lib/onboarding";

export interface CycleParent {
  id: string;
  name: string;
}

interface CustodyCycleBuilderProps {
  childName: string;
  /**
   * BÅDA föräldrarnas riktiga uid:n. Cykeln kan inte byggas innan andra
   * föräldern har anslutit — blocken pekar på uid:n, och placeholders
   * skulle aldrig matcha någon riktig användare.
   */
  parents: [CycleParent, CycleParent];
  /** Befintlig cykel att utgå från, om man ändrar ett redan satt schema. */
  initialBlocks?: CustodyCycleBlock[];
  initialStartDate?: string;
  initialSwitchHour?: string;
  submitLabel?: string;
  onSave: (blocks: CustodyCycleBlock[], cycleStartDate: string, switchHour: string) => Promise<void> | void;
  onCancel?: () => void;
}

const PERIOD_OPTIONS = [1, 2, 3, 4] as const;
type PeriodWeeks = (typeof PERIOD_OPTIONS)[number];

/** Expanderar blocks[] till en platt array av parentId, en post per dag. */
function expandBlocks(blocks: CustodyCycleBlock[]): string[] {
  const days: string[] = [];
  for (const b of blocks) for (let i = 0; i < b.days; i++) days.push(b.parentId);
  return days;
}

/** Komprimerar en dag-för-dag-array till blocks[] (kör-längd-kodning). */
function compressDays(days: string[]): CustodyCycleBlock[] {
  if (days.length === 0) return [];
  const blocks: CustodyCycleBlock[] = [];
  let current = days[0];
  let count = 1;
  for (let i = 1; i < days.length; i++) {
    if (days[i] === current) {
      count++;
    } else {
      blocks.push({ parentId: current, days: count });
      current = days[i];
      count = 1;
    }
  }
  blocks.push({ parentId: current, days: count });
  // Om cykeln loopar rakt igenom (sista dagen = samma förälder som
  // första), slå ihop de två blocken så listan blir så kort som möjligt.
  if (blocks.length > 1 && blocks[0].parentId === blocks[blocks.length - 1].parentId) {
    const first = blocks.shift()!;
    blocks[blocks.length - 1] = {
      ...blocks[blocks.length - 1],
      days: blocks[blocks.length - 1].days + first.days,
    };
  }
  return blocks;
}

/** Sträcker/krymper en dag-array till en ny längd genom att upprepa mönstret. */
function resample(days: string[], targetLength: number): string[] {
  if (days.length === 0) return [];
  return Array.from({ length: targetLength }, (_, i) => days[i % days.length]);
}

/**
 * Låter föräldrarna välja hur många veckor de vill se/redigera åt gången
 * (1–4) och sedan trycka direkt på de färgade dagarna för att markera
 * vem som har barnet — som att måla i en kalender. Ett vanligt mönster
 * (varannan vecka, 2-2-3, ...) går fortfarande att välja som utgångspunkt.
 *
 * Cykelns totala längd är alltid ett helt antal veckor (periodWeeks * 7),
 * så veckodagarna aldrig förskjuts mellan varv — till skillnad från den
 * tidigare fria block-editorn där det kunde hända av misstag.
 */
export default function CustodyCycleBuilder({
  childName,
  parents,
  initialBlocks,
  initialStartDate,
  initialSwitchHour,
  submitLabel = "Spara schema",
  onSave,
  onCancel,
}: CustodyCycleBuilderProps) {
  const [parentA, parentB] = parents;

  const [periodWeeks, setPeriodWeeks] = useState<PeriodWeeks>(() => {
    const totalDays = (initialBlocks ?? []).reduce((s, b) => s + b.days, 0);
    if (totalDays > 0 && totalDays % 7 === 0) {
      const weeks = totalDays / 7;
      if ((PERIOD_OPTIONS as readonly number[]).includes(weeks)) return weeks as PeriodWeeks;
    }
    return 2;
  });

  const [days, setDays] = useState<string[]>(() =>
    resample(expandBlocks(initialBlocks ?? blocksFromPattern([7, 7], parentA.id, parentB.id)), periodWeeks * 7)
  );
  const [cycleStartDate, setCycleStartDate] = useState(
    initialStartDate ?? new Date().toISOString().slice(0, 10)
  );
  const [switchHour, setSwitchHour] = useState(initialSwitchHour ?? "12:00");
  const [saving, setSaving] = useState(false);

  function applyPeriod(weeks: PeriodWeeks) {
    setPeriodWeeks(weeks);
    setDays((prev) => resample(prev, weeks * 7));
  }

  function applyPreset(pattern: number[]) {
    const expanded = expandBlocks(blocksFromPattern(pattern, parentA.id, parentB.id));
    setDays(resample(expanded, periodWeeks * 7));
  }

  function toggleDay(index: number) {
    setDays((prev) => prev.map((p, i) => (i === index ? (p === parentA.id ? parentB.id : parentA.id) : p)));
  }

  const blocks = useMemo(() => compressDays(days), [days]);
  const totalDays = days.length;
  const error = useMemo(() => validateCustodyCycleBlocks(blocks), [blocks]);

  const split = useMemo(() => {
    const perParent: Record<string, number> = { [parentA.id]: 0, [parentB.id]: 0 };
    for (const p of days) perParent[p] = (perParent[p] ?? 0) + 1;
    return perParent;
  }, [days, parentA.id, parentB.id]);

  const nameFor = (id: string) => (id === parentA.id ? parentA.name : parentB.name);

  // Hur stor andel av dygnet (i procent) som ligger FÖRE bytestiden —
  // avgör hur stor "morgon"-delen av varje dagruta ska rita ut sig som.
  // T.ex. switchHour "12:00" ger 50%, "08:00" ger ~33%.
  const switchHourPct = useMemo(() => {
    const [h, m] = switchHour.split(":").map(Number);
    const minutes = (h ?? 12) * 60 + (m ?? 0);
    return Math.min(100, Math.max(0, (minutes / 1440) * 100));
  }, [switchHour]);
  const isBalanced = split[parentA.id] === split[parentB.id];

  const [y, m, d] = cycleStartDate.split("-").map(Number);
  const startDateObj = new Date(y, (m ?? 1) - 1, d ?? 1);

  return (
    <div>
      <h1 className="mb-2 text-2xl font-bold text-stone-800">Boendeschema för {childName}</h1>
      <p className="mb-5 text-stone-500">
        Välj ett vanligt mönster eller måla dagarna själva — tryck på en dag för att byta förälder. Byten sker
        kl {switchHour}.
      </p>

      <div className="mb-4 flex flex-wrap gap-2">
        {CYCLE_PRESET_LIST.map((preset) => (
          <button
            key={preset.label}
            onClick={() => applyPreset(preset.pattern)}
            className="rounded-full border border-stone-300 px-3 py-1.5 text-sm font-medium text-stone-600 hover:border-rose-400 hover:text-rose-600"
          >
            {preset.label}
          </button>
        ))}
      </div>

      <div className="mb-4">
        <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-stone-400">Visa</p>
        <div className="flex gap-2">
          {PERIOD_OPTIONS.map((weeks) => (
            <button
              key={weeks}
              onClick={() => applyPeriod(weeks)}
              className={`flex-1 rounded-lg py-1.5 text-sm font-semibold transition ${
                periodWeeks === weeks ? "bg-rose-500 text-white" : "bg-stone-100 text-stone-600 hover:bg-stone-200"
              }`}
            >
              {weeks} {weeks === 1 ? "vecka" : "veckor"}
            </button>
          ))}
        </div>
      </div>

      <div className="mb-1 flex items-center gap-4 text-xs text-stone-500">
        <span className="flex items-center gap-1.5">
          <span className="h-3 w-3 rounded-full bg-rose-500" /> {parentA.name}
        </span>
        <span className="flex items-center gap-1.5">
          <span className="h-3 w-3 rounded-full bg-sky-500" /> {parentB.name}
        </span>
      </div>
      <p className="mb-2 text-[11px] text-stone-400">
        Varje ruta visar dygnet delat vid bytestiden {switchHour} — övre delen är morgonen (gårdagens
        förälder), nedre delen är från bytet och resten av dagen.
      </p>

      <div className="mb-4 space-y-1">
        {Array.from({ length: periodWeeks }, (_, week) => (
          <div key={week} className="grid grid-cols-7 gap-1">
            {Array.from({ length: 7 }, (_, dow) => {
              const i = week * 7 + dow;
              const parentId = days[i];
              // Bytet sker vid switchHour, inte midnatt: morgonen på en
              // given kalenderdag tillhör alltså GÅRDAGENS block, och det
              // är först vid switchHour som dagens block (parentId) tar
              // över. Cykeln loopar, så dag 0:s morgon tillhör cykelns
              // sista dag (mod-räkning).
              const morningParentId = days[(i - 1 + days.length) % days.length];
              const date = new Date(startDateObj.getTime() + i * 24 * 60 * 60 * 1000);
              return (
                <button
                  key={i}
                  type="button"
                  onClick={() => toggleDay(i)}
                  title={`${date.toLocaleDateString("sv-SE")} — ${nameFor(morningParentId)} till ${switchHour}, sedan ${nameFor(parentId)}`}
                  className="flex flex-col overflow-hidden rounded-lg text-white transition active:scale-95"
                  style={{ height: "48px" }}
                >
                  <div
                    className={`flex items-center justify-center text-[9px] font-semibold opacity-90 ${
                      morningParentId === parentA.id ? "bg-rose-500" : "bg-sky-500"
                    }`}
                    style={{ height: `${switchHourPct}%` }}
                  />
                  <div
                    className={`flex flex-1 flex-col items-center justify-center ${
                      parentId === parentA.id ? "bg-rose-500" : "bg-sky-500"
                    }`}
                  >
                    <span className="text-[9px] uppercase opacity-80">
                      {date.toLocaleDateString("sv-SE", { weekday: "narrow" })}
                    </span>
                    <span className="text-xs font-semibold">{date.getDate()}</span>
                  </div>
                </button>
              );
            })}
          </div>
        ))}
      </div>

      <div className="mb-4 rounded-xl bg-stone-50 px-4 py-3 text-sm">
        <p className="text-stone-600">
          Cykeln är <span className="font-semibold text-stone-800">{totalDays} dagar</span> och upprepas sedan.
        </p>
        <p className="mt-1 text-stone-600">
          {parentA.name}: <span className="font-semibold">{split[parentA.id]} dagar</span> ·{" "}
          {parentB.name}: <span className="font-semibold">{split[parentB.id]} dagar</span>
        </p>
        {!isBalanced && (
          <p className="mt-2 text-amber-700">
            Ojämn fördelning — {nameFor(split[parentA.id] > split[parentB.id] ? parentA.id : parentB.id)} har{" "}
            {Math.abs(split[parentA.id] - split[parentB.id])} dagar mer per cykel. Det är helt okej om ni vill
            ha det så, men ställningen utgår från det här som "normalläge".
          </p>
        )}
      </div>

      <div className="mb-4 grid grid-cols-2 gap-3">
        <label className="text-sm text-stone-600">
          Startdatum
          <input
            type="date"
            value={cycleStartDate}
            onChange={(e) => setCycleStartDate(e.target.value)}
            className="mt-1 w-full rounded-lg bg-stone-100 px-3 py-2"
          />
        </label>
        <label className="text-sm text-stone-600">
          Bytestid
          <input
            type="time"
            value={switchHour}
            onChange={(e) => setSwitchHour(e.target.value)}
            className="mt-1 w-full rounded-lg bg-stone-100 px-3 py-2"
          />
        </label>
      </div>

      {error && <p className="mb-4 text-sm text-rose-600">{error}</p>}

      <div className="flex gap-2">
        {onCancel && (
          <button
            onClick={onCancel}
            className="flex-1 rounded-full border border-stone-300 py-3 font-semibold text-stone-600"
          >
            Avbryt
          </button>
        )}
        <button
          disabled={!!error || saving}
          onClick={async () => {
            setSaving(true);
            try {
              await onSave(blocks, cycleStartDate, switchHour);
            } finally {
              setSaving(false);
            }
          }}
          className="flex-1 rounded-full bg-rose-500 py-3 font-semibold text-white disabled:opacity-40"
        >
          {saving ? "Sparar…" : submitLabel}
        </button>
      </div>
    </div>
  );
}
