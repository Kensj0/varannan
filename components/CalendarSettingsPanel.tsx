"use client";

import { PushPermissionState } from "../lib/pushNotifications";

interface CalendarSettingsPanelProps {
  onClose: () => void;
  showWeekNumbers: boolean;
  onToggleShowWeekNumbers: (value: boolean) => void;
  onEnterEditMode: () => void;
  pushPermission: PushPermissionState | null;
  onEnablePush: () => void;
  reminderPrefs: { dayBefore: boolean; sameDay: boolean };
  onUpdateReminderPrefs: (prefs: { dayBefore: boolean; sameDay: boolean }) => void;
}

/**
 * Inställningspanel som fälls ut under kögelikonen i kalenderns header.
 * Ren UI — allt tillstånd (veckonummer lokalt, påminnelser i Firestore)
 * ägs av CalendarView/HomePage, den här komponenten bara visar och
 * rapporterar ändringar uppåt.
 */
export default function CalendarSettingsPanel({
  onClose,
  showWeekNumbers,
  onToggleShowWeekNumbers,
  onEnterEditMode,
  pushPermission,
  onEnablePush,
  reminderPrefs,
  onUpdateReminderPrefs,
}: CalendarSettingsPanelProps) {
  return (
    <>
      {/* Bakgrund som stänger panelen vid klick utanför. */}
      <div className="fixed inset-0 z-40" onClick={onClose} />

      <div className="absolute right-0 top-12 z-50 w-72 rounded-2xl bg-white p-4 text-left shadow-xl ring-1 ring-stone-100">
        <p className="mb-3 text-xs font-semibold uppercase tracking-wide text-stone-400">
          Kalenderinställningar
        </p>

        <label className="flex items-center justify-between py-2">
          <span className="text-sm text-stone-700">Visa veckonummer</span>
          <Toggle checked={showWeekNumbers} onChange={onToggleShowWeekNumbers} />
        </label>

        <button
          onClick={() => {
            onEnterEditMode();
            onClose();
          }}
          className="mt-1 w-full rounded-lg bg-stone-50 px-3 py-2 text-left text-sm font-medium text-stone-700 hover:bg-stone-100"
        >
          Gå in i ändringsläge
        </button>

        <div className="mt-4 border-t border-stone-100 pt-3">
          <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-stone-400">
            Påminnelser om överlämning
          </p>

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
              onChange={(value) => onUpdateReminderPrefs({ ...reminderPrefs, dayBefore: value })}
            />
          </label>
          <label className="flex items-center justify-between py-1.5">
            <span className="text-sm text-stone-700">Samma dag</span>
            <Toggle
              checked={reminderPrefs.sameDay}
              onChange={(value) => onUpdateReminderPrefs({ ...reminderPrefs, sameDay: value })}
            />
          </label>
        </div>
      </div>
    </>
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
