"use client";

import { useState } from "react";
import { PushPermissionState } from "../lib/pushNotifications";
import { PARENT_PALETTE, ParentColorId } from "../types/schema";
import { CalendarFeedLinks } from "../lib/calendarExport";
import { CustodyCycleDoc } from "../types/schema";

interface CalendarSettingsPanelProps {
  onClose: () => void;
  showWeekNumbers: boolean;
  onToggleShowWeekNumbers: (value: boolean) => void;
  onEnterEditMode: () => void;
  pushPermission: PushPermissionState | null;
  onEnablePush: () => void;
  reminderPrefs: { dayBefore: boolean; sameDay: boolean };
  onUpdateReminderPrefs: (prefs: { dayBefore: boolean; sameDay: boolean }) => void;
  myColorId?: ParentColorId;
  onSelectColor: (colorId: ParentColorId) => Promise<void>;
  otherParentColorHex: string;
  feedLinks: CalendarFeedLinks | null;
  onCreateFeed: () => Promise<void>;
  switchHour: string;
  onChangeSwitchHour: (hh: string, mm: string) => Promise<void>;
  childName: string;
  cycle: CustodyCycleDoc | undefined;
}

export default function CalendarSettingsPanel({
  onClose,
  showWeekNumbers,
  onToggleShowWeekNumbers,
  onEnterEditMode,
  pushPermission,
  onEnablePush,
  reminderPrefs,
  onUpdateReminderPrefs,
  myColorId,
  onSelectColor,
  otherParentColorHex,
  feedLinks,
  onCreateFeed,
  switchHour,
  onChangeSwitchHour,
}: CalendarSettingsPanelProps) {
  const [creatingFeed, setCreatingFeed] = useState(false);
  const [feedError, setFeedError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

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

  async function copyIcsUrl() {
    if (!feedLinks) return;
    try {
      await navigator.clipboard.writeText(feedLinks.ics);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setFeedError("Kunde inte kopiera. Markera och kopiera länken manuellt.");
    }
  }

  return (
    <>
      <div className="fixed inset-0 z-40" onClick={onClose} />

      <div className="absolute right-0 top-12 z-50 max-h-[75vh] w-72 overflow-y-auto rounded-2xl bg-white p-4 text-left shadow-xl ring-1 ring-stone-100">
        <Section title="Kalender" first />

        <label className="flex items-center justify-between py-2">
          <span className="text-sm text-stone-700">Visa veckonummer</span>
          <Toggle checked={showWeekNumbers} onChange={onToggleShowWeekNumbers} />
        </label>

        <button
          onClick={() => {
            onEnterEditMode();
            onClose();
          }}
          className="w-full rounded-lg bg-stone-50 px-3 py-2 text-left text-sm font-medium text-stone-700 hover:bg-stone-100"
        >
          Gå in i ändringsläge
        </button>

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

        <Section title="Påminnelser om överlämning" />

        {pushPermission !== "granted" && (
          <button
            onClick={onEnablePush}
            className="mb-2 w-full rounded-lg bg-rose-500 px-3 py-2 text-sm font-semibold text-white"
          >
            Aktivera push-notiser
          </button>
        )}

        <label className="flex items-center justify-between py-1.5">
          <span className="text-sm text-stone-700">Dagen innan</span>
          <Toggle
            checked={reminderPrefs.dayBefore}
            onChange={(v) => onUpdateReminderPrefs({ ...reminderPrefs, dayBefore: v })}
          />
        </label>
        <label className="flex items-center justify-between py-1.5">
          <span className="text-sm text-stone-700">Samma dag</span>
          <Toggle
            checked={reminderPrefs.sameDay}
            onChange={(v) => onUpdateReminderPrefs({ ...reminderPrefs, sameDay: v })}
          />
        </label>

        <Section title="Exportera kalender" />

        {!feedLinks ? (
          <>
            <p className="mb-2 text-[11px] leading-snug text-stone-400">
              Skapar prenumerationslänkar som håller din och den andra förälderns kalender uppdaterade automatiskt — var sin länk, var sin färg i Google Calendar.
            </p>
            <button
              onClick={handleCreateFeed}
              disabled={creatingFeed}
              className="w-full rounded-lg bg-stone-50 px-3 py-2 text-sm font-medium text-stone-700 hover:bg-stone-100 disabled:opacity-50"
            >
              {creatingFeed ? "Skapar…" : "Skapa prenumerationslänkar"}
            </button>
          </>
        ) : (
          <>
            <p className="mb-2 text-[11px] font-medium text-stone-700">Din schemalänk:</p>
            <div className="mb-3 space-y-1.5">
              <FeedLink href={feedLinks.google} label="Google Kalender" />
              <FeedLink href={feedLinks.apple} label="iPhone / Apple Kalender" />
              <FeedLink href={feedLinks.outlook} label="Outlook / Microsoft" />
            </div>

            <button
              onClick={copyIcsUrl}
              className="w-full rounded-lg border border-stone-200 px-3 py-2 text-sm text-stone-600 hover:bg-stone-50"
            >
              {copied ? "Kopierad!" : "Kopiera min ICS-länk"}
            </button>

            <p className="mt-2 text-[11px] leading-snug text-stone-400">
              Vem som helst med länken kan läsa schemat. Skapa nya länker för att återkalla de gamla.
            </p>
            <button
              onClick={handleCreateFeed}
              disabled={creatingFeed}
              className="mt-1 text-[11px] font-medium text-rose-500 hover:underline disabled:opacity-50"
            >
              {creatingFeed ? "Skapar…" : "Skapa nya länker"}
            </button>
          </>
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

function FeedLink({ href, label }: { href: string; label: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="flex items-center justify-between rounded-lg bg-stone-50 px-3 py-2 text-sm font-medium text-stone-700 hover:bg-stone-100"
    >
      {label}
      <span className="text-stone-300">→</span>
    </a>
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
