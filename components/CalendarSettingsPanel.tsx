"use client";

import { useState } from "react";
import {
  PARENT_PALETTE,
  ParentColorId,
  ScheduleChangeMode,
  SCHEDULE_CHANGE_MODES,
} from "../types/schema";
import { CalendarFeedLinks } from "../lib/calendarExport";
import { CustodyCycleDoc } from "../types/schema";

interface CalendarSettingsPanelProps {
  onClose: () => void;
  showWeekNumbers: boolean;
  onToggleShowWeekNumbers: (value: boolean) => void;
  myColorId?: ParentColorId;
  onSelectColor: (colorId: ParentColorId) => Promise<void>;
  otherParentColorHex: string;
  feedLinks: CalendarFeedLinks | null;
  /** Andra förälderns dagar som ett SEPARAT flöde, så det kan få egen färg. */
  otherFeedLinks?: CalendarFeedLinks | null;
  otherParentName?: string;
  onCreateFeed: () => Promise<void>;
  onOpenExportGuide: () => void;
  /** Undefined när schemat inte går att ändra än (ingen partner/cykel). */
  onEditStructure?: () => void;
  switchHour: string;
  onChangeSwitchHour: (hh: string, mm: string) => Promise<void>;
  childName: string;
  cycle: CustodyCycleDoc | undefined;


  /** Förfrågan vs notifiering — gäller alla schemaändringar, se schema.ts. */
  scheduleChangeMode: ScheduleChangeMode;
  onChangeScheduleChangeMode: (mode: ScheduleChangeMode) => Promise<void>;
}

export default function CalendarSettingsPanel({
  onClose,
  showWeekNumbers,
  onToggleShowWeekNumbers,
  myColorId,
  onSelectColor,
  otherParentColorHex,
  feedLinks,
  otherFeedLinks,
  otherParentName,
  onCreateFeed,
  onOpenExportGuide,
  onEditStructure,
  switchHour,
  onChangeSwitchHour,
  childName,
  scheduleChangeMode,
  onChangeScheduleChangeMode,
}: CalendarSettingsPanelProps) {
  const [creatingFeed, setCreatingFeed] = useState(false);
  const [feedError, setFeedError] = useState<string | null>(null);

  const [modeBusy, setModeBusy] = useState(false);
  const [modeError, setModeError] = useState<string | null>(null);

  const [hh] = (switchHour || "08:00").split(":");
  const [pendingHh, setPendingHh] = useState(hh ?? "08");
  const [changingTime, setChangingTime] = useState(false);
  const [timeError, setTimeError] = useState<string | null>(null);

  async function handleCreateFeed() {
    setCreatingFeed(true);
    setFeedError(null);
    try {
      await onCreateFeed();
    } catch {
      setFeedError("Kunde inte skapa länken. Försök igen.");
    } finally {
      setCreatingFeed(false);
    }
  }

  return (
    <>
      <div className="fixed inset-0 z-40" onClick={onClose} />

      <div className="absolute right-0 top-12 z-50 max-h-[75vh] w-72 overflow-y-auto rounded-2xl bg-white p-4 text-left shadow-xl ring-1 ring-stone-100">
        <Section title="Schemaändringar" first />
        <p className="mb-2 text-[11px] leading-snug text-stone-400">
          Gäller alla ändringar av schemat — enstaka dagar såväl som ändringsläget. Inställningen är
          gemensam för er båda.
        </p>
        <div className="space-y-1">
          {SCHEDULE_CHANGE_MODES.map((option) => {
            const selected = option.id === scheduleChangeMode;
            return (
              <button
                key={option.id}
                disabled={modeBusy}
                onClick={async () => {
                  if (selected) return;
                  setModeBusy(true);
                  setModeError(null);
                  try {
                    await onChangeScheduleChangeMode(option.id);
                  } catch {
                    setModeError("Kunde inte byta läge. Försök igen.");
                  } finally {
                    setModeBusy(false);
                  }
                }}
                className={`w-full rounded-lg border px-3 py-2 text-left disabled:opacity-50 ${
                  selected ? "border-rose-300 bg-rose-50" : "border-stone-200 hover:bg-stone-50"
                }`}
              >
                <span className="flex items-center justify-between">
                  <span
                    className={`text-sm font-semibold ${selected ? "text-rose-700" : "text-stone-700"}`}
                  >
                    {option.label}
                  </span>
                  {selected && <span className="text-xs text-rose-600">✓</span>}
                </span>
                <span className="mt-0.5 block text-[11px] leading-snug text-stone-500">
                  {option.description}
                </span>
              </button>
            );
          })}
        </div>
        {modeError && <p className="mt-1 text-[11px] text-rose-600">{modeError}</p>}

        <Section title="Visning" />

        <label className="flex items-center justify-between py-2">
          <span className="text-sm text-stone-700">Visa veckonummer</span>
          <Toggle checked={showWeekNumbers} onChange={onToggleShowWeekNumbers} />
        </label>

        <Section title="Bytestid" />
        <p className="mb-2 text-[11px] leading-snug text-stone-400">
          Vilken timme dygnet växlar mellan föräldrarna. Visas på bytesdagarna och skickas med i kalenderexporten.
        </p>
        <div className="mb-2">
          <label className="block text-[11px] text-stone-500 mb-1">Timme (00:00)</label>
          <input
            type="number"
            min="0"
            max="23"
            value={pendingHh}
            onChange={(e) => setPendingHh(e.target.value)}
            disabled={changingTime}
            className="w-full rounded-lg border border-stone-200 px-2 py-1.5 text-sm disabled:opacity-50"
          />
        </div>
        {timeError && <p className="mb-2 text-[11px] text-rose-600">{timeError}</p>}
        <button
          onClick={async () => {
            setTimeError(null);
            if (!pendingHh) {
              setTimeError("Ange en timme.");
              return;
            }
            const hhNum = Number(pendingHh);
            if (hhNum < 0 || hhNum > 23) {
              setTimeError("Ogiltig timme.");
              return;
            }
            setChangingTime(true);
            try {
              await onChangeSwitchHour(String(hhNum).padStart(2, "0"), "00");
            } catch {
              setTimeError("Kunde inte uppdatera tiden. Försök igen.");
            } finally {
              setChangingTime(false);
            }
          }}
          disabled={changingTime || `${pendingHh}:00` === (switchHour || "08:00")}
          className="w-full rounded-lg bg-stone-50 px-3 py-2 text-sm font-medium text-stone-700 hover:bg-stone-100 disabled:opacity-50"
        >
          {changingTime ? "Uppdaterar…" : "Uppdatera tid"}
        </button>

        <Section title="Min färg" />
        <p className="mb-2 text-[11px] leading-snug text-stone-400">
          Samma färger som Google Calendar använder, så schemat ser likadant ut där.
        </p>
        <div className="flex flex-wrap gap-2">
          {PARENT_PALETTE.map((color) => {
            const selected = color.id === myColorId;
            const takenByOther = color.hex === otherParentColorHex;
            return (
              <button
                key={color.id}
                disabled={takenByOther}
                onClick={() => onSelectColor(color.id)}
                aria-label={color.label}
                aria-pressed={selected}
                title={takenByOther ? `${color.label} — används av den andra föräldern` : color.label}
                className={`h-8 w-8 rounded-full transition ${
                  selected ? "ring-2 ring-stone-800 ring-offset-2" : ""
                } ${takenByOther ? "cursor-not-allowed opacity-25" : "hover:scale-110"}`}
                style={{ background: color.hex }}
              />
            );
          })}
        </div>

        {onEditStructure && (
          <>
            <Section title="Grundschema" />
            <p className="mb-2 text-[11px] leading-snug text-stone-400">
              Vem som har barnet vilka dagar, och när bytet sker. Gäller den här kalendern.
              Aktiviteter och godkända bytesdagar påverkas inte.
            </p>
            <button
              onClick={() => {
                onEditStructure();
                onClose();
              }}
              className="w-full rounded-lg bg-stone-50 px-3 py-2 text-sm font-medium text-stone-700 hover:bg-stone-100"
            >
              Ändra grundschema
            </button>
          </>
        )}

        <Section title="Exportera kalender" />

        {!feedLinks ? (
          <button
            onClick={handleCreateFeed}
            disabled={creatingFeed}
            className="w-full rounded-lg bg-stone-50 px-3 py-2 text-sm font-medium text-stone-700 hover:bg-stone-100 disabled:opacity-50"
          >
            {creatingFeed ? "Skapar…" : "Skapa prenumerationslänkar"}
          </button>
        ) : (
          <button
            onClick={() => {
              onOpenExportGuide();
              onClose();
            }}
            className="w-full rounded-lg bg-stone-50 px-3 py-2 text-sm font-medium text-stone-700 hover:bg-stone-100"
          >
            Exportera kalender
          </button>
        )}

        {feedError && <p className="mt-2 text-[11px] text-rose-600">{feedError}</p>}
      </div>
    </>
  );
}

function Section({ title, first = false }: { title: string; first?: boolean }) {
  return (
    <p
      className={`mb-2 text-xs font-semibold uppercase tracking-wide text-stone-400 ${
        first ? "" : "mt-4 border-t border-stone-100 pt-3"
      }`}
    >
      {title}
    </p>
  );
}

function Toggle({ checked, onChange }: { checked: boolean; onChange: (value: boolean) => void }) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={`relative h-6 w-10 shrink-0 rounded-full transition ${checked ? "bg-rose-500" : "bg-stone-200"}`}
    >
      <span
        className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition ${
          checked ? "left-[18px]" : "left-0.5"
        }`}
      />
    </button>
  );
}
