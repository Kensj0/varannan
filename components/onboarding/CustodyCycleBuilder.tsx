"use client";

import { useMemo, useState } from "react";
import { CustodyCycleBlock } from "../../types/schema";
import { blocksFromPattern, validateCustodyCycleBlocks } from "../../lib/onboarding";

export interface CycleParent {
  id: string;
  name: string;
  /** Förälderns färg i kalendern. Utan den faller vi tillbaka på paletten. */
  color?: string;
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

  function toggleDay(index: number) {
    setDays((prev) => prev.map((p, i) => (i === index ? (p === parentA.id ? parentB.id : parentA.id) : p)));
  }

  const blocks = useMemo(() => compressDays(days), [days]);
  const error = useMemo(() => validateCustodyCycleBlocks(blocks), [blocks]);

  const split = useMemo(() => {
    const perParent: Record<string, number> = { [parentA.id]: 0, [parentB.id]: 0 };
    for (const p of days) perParent[p] = (perParent[p] ?? 0) + 1;
    return perParent;
  }, [days, parentA.id, parentB.id]);

  const nameFor = (id: string) => (id === parentA.id ? parentA.name : parentB.name);

  const isBalanced = split[parentA.id] === split[parentB.id];

  const colorA = parentA.color ?? "#E0705B";
  const colorB = parentB.color ?? "#4A2B52";
  const colorFor = (id: string) => (id === parentA.id ? colorA : colorB);

  const WEEKDAY_LABELS = ["MÅN", "TIS", "ONS", "TORS", "FRE", "LÖR", "SÖN"];

  return (
    <div>
      <h1 className="mb-6 text-3xl font-bold leading-tight text-stone-900">
        Skapa mall för bytesdagar
      </h1>

      <label className="mb-6 block">
        <span className="mb-2 block text-sm font-semibold text-stone-800">
          Efter hur många veckor upprepar sig schemat?
        </span>
        <select
          value={periodWeeks}
          onChange={(e) => applyPeriod(Number(e.target.value) as PeriodWeeks)}
          className="w-full appearance-none rounded-xl border border-stone-300 bg-white px-4 py-3 text-base text-stone-800 outline-none focus:border-stone-500"
        >
          {PERIOD_OPTIONS.map((weeks) => (
            <option key={weeks} value={weeks}>
              {weeks}
            </option>
          ))}
        </select>
      </label>

      <p className="mb-3 text-sm text-stone-500">Välj vem som har ansvaret för vilka dagar</p>

      <div className="mb-1 grid grid-cols-7 gap-2">
        {WEEKDAY_LABELS.map((label) => (
          <span key={label} className="text-center text-[10px] font-medium tracking-wide text-stone-400">
            {label}
          </span>
        ))}
      </div>

      <div className="mb-4 space-y-2">
        {Array.from({ length: periodWeeks }, (_, week) => (
          <div key={week} className="grid grid-cols-7 gap-2">
            {Array.from({ length: 7 }, (_, dow) => {
              const i = week * 7 + dow;
              const parentId = days[i];
              return (
                <button
                  key={i}
                  type="button"
                  onClick={() => toggleDay(i)}
                  aria-label={`${WEEKDAY_LABELS[dow]} vecka ${week + 1}: ${nameFor(parentId)}`}
                  className="aspect-square rounded-xl transition active:scale-95"
                  style={{ backgroundColor: colorFor(parentId) }}
                />
              );
            })}
          </div>
        ))}
      </div>

      <div className="mb-6 flex flex-wrap items-center gap-x-5 gap-y-2 text-sm text-stone-700">
        <span className="flex items-center gap-2">
          <span className="h-3.5 w-3.5 rounded-full" style={{ backgroundColor: colorA }} />
          {parentA.name}
        </span>
        <span className="flex items-center gap-2">
          <span className="h-3.5 w-3.5 rounded-full" style={{ backgroundColor: colorB }} />
          {parentB.name}
        </span>
      </div>

      <div className="mb-6 grid grid-cols-2 gap-3">
        <label className="text-sm text-stone-600">
          Startdatum
          <input
            type="date"
            value={cycleStartDate}
            onChange={(e) => setCycleStartDate(e.target.value)}
            className="mt-1 w-full rounded-xl border border-stone-300 bg-white px-3 py-2.5 outline-none focus:border-stone-500"
          />
        </label>
        <label className="text-sm text-stone-600">
          Bytestid
          <input
            type="time"
            value={switchHour}
            onChange={(e) => setSwitchHour(e.target.value)}
            className="mt-1 w-full rounded-xl border border-stone-300 bg-white px-3 py-2.5 outline-none focus:border-stone-500"
          />
        </label>
      </div>

      {!isBalanced && (
        <p className="mb-4 text-sm text-stone-500">
          {nameFor(split[parentA.id] > split[parentB.id] ? parentA.id : parentB.id)} har{" "}
          {Math.abs(split[parentA.id] - split[parentB.id])} dagar mer per cykel. Det går bra, men ställningen
          utgår från det här som normalläge.
        </p>
      )}

      {error && <p className="mb-4 text-sm text-rose-600">{error}</p>}

      <div className="flex gap-3">
        {onCancel && (
          <button
            onClick={onCancel}
            className="flex-1 rounded-full border border-stone-300 py-4 text-sm font-semibold uppercase tracking-widest text-stone-600"
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
          className="flex-1 rounded-full py-4 text-sm font-semibold uppercase tracking-widest text-white disabled:opacity-40"
          style={{ backgroundColor: colorB }}
        >
          {saving ? "Sparar…" : submitLabel}
        </button>
      </div>
    </div>
  );
}
