"use client";

import { useState } from "react";
import BottomNav, { AppSection } from "./BottomNav";
import CalendarManagerPanel, { ManagedCalendar } from "./CalendarManagerPanel";
import { CalendarRole } from "../types/schema";

const ALL_SECTIONS = new Set<AppSection>(["chat", "info", "calendar", "lists", "settings"]);

interface EmptyCalendarStateProps {
  calendars: ManagedCalendar[];
  onSelectCalendar: (calendar: ManagedCalendar) => void;
  onCreateCalendar: (name: string) => Promise<void>;
  onRenameCalendar: (calendarId: string, name: string) => Promise<void>;
  onDeleteCalendar: (teamId: string, calendarId: string, confirmation: string) => Promise<void>;
  onInviteToCalendar: (calendarId: string) => Promise<{ shareUrl: string }>;
  onInviteRelative: (
    calendarId: string,
    email: string,
    role: Exclude<CalendarRole, "parent">
  ) => Promise<{ status: "sent" | "pending_approval" }>;
  onSignOut: () => void;
}

/**
 * Visas i stället för appen när kontot inte är med på NÅGON kalender —
 * antingen mitt i den allra första onboardingen (team skapat, inget barn
 * än) eller efter att ha lämnat/raderat sin sista kalender (se
 * handleDeleteCalendar, app/page.tsx, och deleteChild i
 * functions/src/index.ts).
 *
 * Kenny (2026-09-27): en anhörig/utomstående som lämnar sin sista
 * kalender ska INTE kastas tillbaka in i en särskild onboardingskärm —
 * det ska se ut som RESTEN av appen (samma flikrad, samma "+"), bara
 * tomt och avstängt tills man skapar (eller går med i) en ny kalender.
 * Byter man kalender via "+" försvinner den här skärmen automatiskt
 * (activeChild blir satt igen, app/page.tsx väljer om).
 */
export default function EmptyCalendarState({
  calendars,
  onSelectCalendar,
  onCreateCalendar,
  onRenameCalendar,
  onDeleteCalendar,
  onInviteToCalendar,
  onInviteRelative,
  onSignOut,
}: EmptyCalendarStateProps) {
  const [managerOpen, setManagerOpen] = useState(false);

  return (
    <div className="mx-auto flex min-h-screen max-w-md flex-col">
      <header className="flex items-center justify-between border-b border-stone-100 px-4 py-3">
        <span className="text-lg font-bold text-rose-500">Varannan</span>
        <div className="relative">
          <button
            onClick={() => setManagerOpen((v) => !v)}
            aria-label="Hantera scheman"
            className="grid h-9 w-9 place-items-center rounded-full text-stone-400 hover:bg-stone-50 hover:text-rose-500"
          >
            <span className="text-xl leading-none">+</span>
          </button>
          {managerOpen && (
            <CalendarManagerPanel
              onClose={() => setManagerOpen(false)}
              calendars={calendars}
              activeCalendarId=""
              onSelectCalendar={onSelectCalendar}
              onCreateCalendar={onCreateCalendar}
              onRenameCalendar={onRenameCalendar}
              onDeleteCalendar={onDeleteCalendar}
              onInviteToCalendar={onInviteToCalendar}
              onInviteRelative={onInviteRelative}
            />
          )}
        </div>
      </header>

      <div className="grid flex-1 place-items-center px-6 text-center">
        <div>
          <p className="mb-1 font-medium text-stone-500">Ingen kalender än</p>
          <p className="text-sm text-stone-400">
            Skapa en med <span className="font-semibold text-rose-500">+</span> uppe till höger, eller
            be någon bjuda in dig till sin.
          </p>
          <button onClick={onSignOut} className="mt-6 text-sm text-stone-400 hover:text-rose-500">
            Logga ut
          </button>
        </div>
      </div>

      <div className="w-full shrink-0">
        <BottomNav active="calendar" onChange={() => {}} disabled={ALL_SECTIONS} />
      </div>
    </div>
  );
}
