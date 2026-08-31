"use client";

/**
 * Understilta flikar inom en sektion — t.ex. Packlista/Notes/Todo under
 * "Listor", eller Barninfo/Konton under "Info". Understruken, versal
 * stil, matchar referensdesignen.
 */
export default function SubTabs<T extends string>({
  tabs,
  active,
  onChange,
}: {
  tabs: { id: T; label: string }[];
  active: T;
  onChange: (id: T) => void;
}) {
  return (
    <div className="mb-4 flex gap-5 border-b border-stone-200">
      {tabs.map((t) => {
        const isActive = t.id === active;
        return (
          <button
            key={t.id}
            onClick={() => onChange(t.id)}
            className={`-mb-px border-b-2 pb-2 text-sm font-semibold uppercase tracking-wide transition ${
              isActive ? "border-rose-500 text-stone-800" : "border-transparent text-stone-400"
            }`}
          >
            {t.label}
          </button>
        );
      })}
    </div>
  );
}
