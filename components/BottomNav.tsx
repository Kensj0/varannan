"use client";

export type AppSection = "chat" | "info" | "calendar" | "lists" | "settings";

const SECTIONS: { id: AppSection; label: string; icon: (active: boolean) => React.ReactNode }[] = [
  { id: "chat", label: "Chatt", icon: (a) => <ChatIcon active={a} /> },
  { id: "info", label: "Info", icon: (a) => <InfoIcon active={a} /> },
  { id: "calendar", label: "Schema", icon: (a) => <CalendarIcon active={a} /> },
  { id: "lists", label: "Listor", icon: (a) => <ListIcon active={a} /> },
  { id: "settings", label: "Profil", icon: (a) => <ProfileIcon active={a} /> },
];

/**
 * Fast navigationsfält längst ner, ikonbaserat — ersätter den gamla
 * horisontella pill-raden med sju konkurrerande flikar. Fem huvudsektioner;
 * Packlista/Notes/Todo och Barninfo/Konton grupperas som undra-flikar
 * inne i respektive sektion (se Listor/Info i page.tsx).
 */
export default function BottomNav({
  active,
  onChange,
}: {
  active: AppSection;
  onChange: (section: AppSection) => void;
}) {
  return (
    <nav
      className="flex shrink-0 items-stretch justify-around border-t border-stone-200 bg-white pb-[env(safe-area-inset-bottom)]"
      style={{ paddingBottom: "max(env(safe-area-inset-bottom), 0px)" }}
    >
      {SECTIONS.map((s) => {
        const isActive = active === s.id;
        return (
          <button
            key={s.id}
            onClick={() => onChange(s.id)}
            aria-label={s.label}
            aria-current={isActive}
            className={`flex flex-1 flex-col items-center gap-0.5 py-2 text-[10px] font-medium transition ${
              isActive ? "text-rose-500" : "text-stone-400"
            }`}
          >
            {s.icon(isActive)}
            {s.label}
          </button>
        );
      })}
    </nav>
  );
}

function ChatIcon({ active }: { active: boolean }) {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={active ? 2 : 1.6}>
      <path d="M4 5h16v11H8l-4 4V5Z" strokeLinejoin="round" />
    </svg>
  );
}

function InfoIcon({ active }: { active: boolean }) {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={active ? 2 : 1.6}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5.5" strokeLinecap="round" />
      <circle cx="12" cy="7.7" r="1" fill="currentColor" stroke="none" />
    </svg>
  );
}

function CalendarIcon({ active }: { active: boolean }) {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={active ? 2 : 1.6}>
      <rect x="3" y="4.5" width="18" height="16" rx="2" />
      <path d="M3 9.5h18M8 3v3M16 3v3" strokeLinecap="round" />
    </svg>
  );
}

function ListIcon({ active }: { active: boolean }) {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={active ? 2 : 1.6}>
      <path d="M9 6h11M9 12h11M9 18h11" strokeLinecap="round" />
      <path d="m4 6 .8.8L6.2 5.3M4 12l.8.8 1.4-1.5M4 18l.8.8 1.4-1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function ProfileIcon({ active }: { active: boolean }) {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={active ? 2 : 1.6}>
      <circle cx="12" cy="8" r="3.6" />
      <path d="M4.5 20a7.5 7.5 0 0 1 15 0" strokeLinecap="round" />
    </svg>
  );
}
