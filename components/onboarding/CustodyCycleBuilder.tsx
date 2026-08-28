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

/**
 * Låter föräldrarna välja ett färdigt mönster (varannan vecka, 2-2-3,
 * 2-2-5-5, 3-4-4-3) eller bygga ett eget block för block.
 *
 * Visar en levande förhandsgranskning av de första två veckorna, så man
 * ser vad mönstret faktiskt innebär innan det sparas.
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

  const [blocks, setBlocks] = useState<CustodyCycleBlock[]>(
    initialBlocks ?? blocksFromPattern([7, 7], parentA.id, parentB.id)
  );
  const [cycleStartDate, setCycleStartDate] = useState(
    initialStartDate ?? new Date().toISOString().slice(0, 10)
  );
  const [switchHour, setSwitchHour] = useState(initialSwitchHour ?? "12:00");
  const [saving, setSaving] = useState(false);

  const totalDays = useMemo(() => blocks.reduce((s, b) => s + b.days, 0), [blocks]);
  const error = useMemo(() => validateCustodyCycleBlocks(blocks), [blocks]);

  const split = useMemo(() => {
    const perParent: Record<string, number> = { [parentA.id]: 0, [parentB.id]: 0 };
    for (const b of blocks) perParent[b.parentId] = (perParent[b.parentId] ?? 0) + b.days;
    return perParent;
  }, [blocks, parentA.id, parentB.id]);

  const nameFor = (id: string) => (id === parentA.id ? parentA.name : parentB.name);

  function updateBlockDays(index: number, days: number) {
    setBlocks((prev) => prev.map((b, i) => (i === index ? { ...b, days: Math.max(1, days) } : b)));
  }

  function addBlock() {
    const lastParent = blocks[blocks.length - 1]?.parentId ?? parentB.id;
    const nextParent = lastParent === parentA.id ? parentB.id : parentA.id;
    setBlocks((prev) => [...prev, { parentId: nextParent, days: 2 }]);
  }

  const isBalanced = split[parentA.id] === split[parentB.id];
  const followsWeeks = totalDays % 7 === 0;

  return (
    <div>
      <h1 className="mb-2 text-2xl font-bold text-stone-800">Boendeschema för {childName}</h1>
      <p className="mb-5 text-stone-500">
        Välj ett vanligt mönster eller bygg ert eget. Byten sker kl {switchHour}.
      </p>

      <div className="mb-5 flex flex-wrap gap-2">
        {CYCLE_PRESET_LIST.map((preset) => (
          <button
            key={preset.label}
            onClick={() => setBlocks(blocksFromPattern(preset.pattern, parentA.id, parentB.id))}
            className="rounded-full border border-stone-300 px-3 py-1.5 text-sm font-medium text-stone-600 hover:border-rose-400 hover:text-rose-600"
          >
            {preset.label}
          </button>
        ))}
      </div>

      <div className="mb-4 space-y-2">
        {blocks.map((block, i) => (
          <div key={i} className="flex items-center gap-2 rounded-lg bg-stone-50 px-3 py-2">
            <select
              value={block.parentId}
              onChange={(e) =>
                setBlocks((prev) => prev.map((b, idx) => (idx === i ? { ...b, parentId: e.target.value } : b)))
              }
              className="rounded-md bg-white px-2 py-1 text-sm font-medium"
            >
              <option value={parentA.id}>{parentA.name}</option>
              <option value={parentB.id}>{parentB.name}</option>
            </select>
            <input
              type="number"
              min={1}
              value={block.days}
              onChange={(e) => updateBlockDays(i, Number(e.target.value))}
              className="w-16 rounded-md bg-white px-2 py-1 text-sm"
            />
            <span className="text-sm text-stone-400">dagar</span>
            {blocks.length > 1 && (
              <button
                onClick={() => setBlocks((prev) => prev.filter((_, idx) => idx !== i))}
                className="ml-auto text-stone-300 hover:text-rose-500"
                aria-label="Ta bort block"
              >
                ✕
              </button>
            )}
          </div>
        ))}
        <button
          onClick={addBlock}
          className="w-full rounded-lg border border-dashed border-stone-300 py-2 text-sm text-stone-500 hover:border-rose-400 hover:text-rose-600"
        >
          + Lägg till block
        </button>
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
        {!followsWeeks && (
          <p className="mt-2 text-amber-700">
            Cykeln är inte jämnt delbar med 7, så veckodagarna förskjuts för varje varv. Barnet får alltså inte
            samma vardagar hos samma förälder från vecka till vecka.
          </p>
        )}
      </div>

      <CyclePreview blocks={blocks} startDate={cycleStartDate} nameFor={nameFor} parentAId={parentA.id} />

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

/**
 * Visar de första 14 dagarna som färgade rutor. Rent visuellt — hjälper
 * en att se att "2-2-3" faktiskt blir det man tänkt sig innan man sparar.
 */
function CyclePreview({
  blocks,
  startDate,
  nameFor,
  parentAId,
}: {
  blocks: CustodyCycleBlock[];
  startDate: string;
  nameFor: (id: string) => string;
  parentAId: string;
}) {
  const days = useMemo(() => {
    const expanded: string[] = [];
    for (const block of blocks) {
      for (let i = 0; i < block.days; i++) expanded.push(block.parentId);
    }
    if (expanded.length === 0) return [];
    return Array.from({ length: 14 }, (_, i) => expanded[i % expanded.length]);
  }, [blocks]);

  if (days.length === 0) return null;

  const [y, m, d] = startDate.split("-").map(Number);
  const start = new Date(y, (m ?? 1) - 1, d ?? 1);

  return (
    <div className="mb-4">
      <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-stone-400">
        Så här blir de första två veckorna
      </p>
      <div className="flex gap-0.5 overflow-hidden rounded-lg">
        {days.map((parentId, i) => {
          const date = new Date(start.getTime() + i * 24 * 60 * 60 * 1000);
          return (
            <div
              key={i}
              title={`${date.toLocaleDateString("sv-SE")} — ${nameFor(parentId)}`}
              className={`flex-1 py-2 text-center text-[10px] font-semibold text-white ${
                parentId === parentAId ? "bg-rose-500" : "bg-sky-500"
              }`}
            >
              {date.toLocaleDateString("sv-SE", { weekday: "narrow" })}
            </div>
          );
        })}
      </div>
    </div>
  );
}
