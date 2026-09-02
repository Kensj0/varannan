"use client";

import { useRef, useState } from "react";
import { ChildInfoDoc } from "../types/schema";

interface ChildInfoViewProps {
  /**
   * Alla barn i familjen. Listan är medvetet frikopplad från vilken
   * kalender som visas: barninfo, konton och liknande hör till personen,
   * inte till schemat man råkar titta på.
   */
  childList: { id: string; name: string }[];
  activeChildId: string;
  onSelectChild: (childId: string) => void;
  onAddChild: (name: string) => Promise<void>;
  info: ChildInfoDoc | null;
  onSave: (patch: Partial<ChildInfoDoc>) => Promise<void>;
}

type FieldKey = keyof Omit<ChildInfoDoc, "updatedBy" | "updatedAt">;

interface FieldSpec {
  key: FieldKey;
  label: string;
  /** Döljs bakom "Visa" tills föräldern aktivt väljer att se det. */
  sensitive?: boolean;
  hint?: string;
  multiline?: boolean;
}

/**
 * Motsvarar BARNINFO-fliken. Fälten är grupperade som i originalappen:
 * storlekar, hälsa, dokument.
 *
 * Känsliga fält (personnummer, passnummer) visas maskerade tills man
 * trycker "Visa" — inte för att det skyddar mot en angripare som redan
 * har kontot, utan mot axelkikare i ett väntrum eller på en förskola.
 */
const FIELD_GROUPS: { title: string; fields: FieldSpec[] }[] = [
  {
    title: "Storlekar",
    fields: [
      { key: "clothingSize", label: "Klädstorlek" },
      { key: "shoeSize", label: "Skostorlek" },
    ],
  },
  {
    title: "Hälsa",
    fields: [
      { key: "insurance", label: "Försäkring" },
      { key: "medicalAllergy", label: "Med. / allergi", multiline: true },
      { key: "vaccinations", label: "Vaccinationer", multiline: true },
    ],
  },
  {
    title: "Dokument",
    fields: [
      { key: "personalNumber", label: "Personnummer", sensitive: true },
      { key: "passportNumber", label: "Passnummer", sensitive: true },
      { key: "passportLocation", label: "Var är passet?", hint: "T.ex. 'I byrålådan hos mamma'" },
    ],
  },
  {
    title: "Övrigt",
    fields: [{ key: "other", label: "Övrigt", multiline: true }],
  },
];

export default function ChildInfoView({
  childList,
  activeChildId,
  onSelectChild,
  onAddChild,
  info,
  onSave,
}: ChildInfoViewProps) {
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const touchStartX = useRef<number | null>(null);

  const index = childList.findIndex((c) => c.id === activeChildId);
  const activeChild = childList[index];

  function step(delta: number) {
    if (childList.length < 2) return;
    // Modulo så att man kan bläddra runt i stället för att gå in i en vägg.
    const next = (index + delta + childList.length) % childList.length;
    onSelectChild(childList[next].id);
  }

  async function handleAdd() {
    const trimmed = newName.trim();
    if (!trimmed) {
      setError("Ange ett namn.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onAddChild(trimmed);
      setNewName("");
      setAdding(false);
    } catch {
      setError("Kunde inte lägga till barnet. Försök igen.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <div
        className="rounded-2xl bg-white p-4 shadow-sm"
        onTouchStart={(e) => {
          touchStartX.current = e.touches[0]?.clientX ?? null;
        }}
        onTouchEnd={(e) => {
          const start = touchStartX.current;
          touchStartX.current = null;
          if (start === null) return;
          const dx = (e.changedTouches[0]?.clientX ?? start) - start;
          // 50 px så att en darrig tumme inte råkar byta barn.
          if (Math.abs(dx) < 50) return;
          step(dx < 0 ? 1 : -1);
        }}
      >
        <div className="flex items-center justify-between gap-2">
          <button
            onClick={() => step(-1)}
            disabled={childList.length < 2}
            aria-label="Föregående barn"
            className="grid h-8 w-8 shrink-0 place-items-center rounded-full text-stone-300 hover:bg-stone-50 hover:text-rose-500 disabled:opacity-0"
          >
            ‹
          </button>

          <div className="min-w-0 flex-1 text-center">
            <h2 className="truncate text-lg font-bold text-stone-800">
              {activeChild?.name ?? "Barn"}
            </h2>
            {childList.length > 1 && (
              <p className="text-xs text-stone-400">
                {index + 1} av {childList.length}
              </p>
            )}
          </div>

          <button
            onClick={() => step(1)}
            disabled={childList.length < 2}
            aria-label="Nästa barn"
            className="grid h-8 w-8 shrink-0 place-items-center rounded-full text-stone-300 hover:bg-stone-50 hover:text-rose-500 disabled:opacity-0"
          >
            ›
          </button>
        </div>

        {childList.length > 1 && (
          <div className="mt-2 flex justify-center gap-1.5">
            {childList.map((child) => (
              <button
                key={child.id}
                onClick={() => onSelectChild(child.id)}
                aria-label={child.name}
                className={`h-1.5 rounded-full transition-all ${
                  child.id === activeChildId ? "w-4 bg-rose-500" : "w-1.5 bg-stone-200"
                }`}
              />
            ))}
          </div>
        )}

        <p className="mt-3 text-sm text-stone-500">
          Information som båda föräldrarna behöver komma åt. Bara ni två kan se det här.
        </p>

        {adding ? (
          <div className="mt-3">
            <input
              autoFocus
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void handleAdd();
                if (e.key === "Escape") setAdding(false);
              }}
              placeholder="Barnets namn"
              disabled={busy}
              className="mb-2 w-full rounded-lg border border-stone-200 px-3 py-2 text-sm disabled:opacity-50"
            />
            <div className="flex gap-2">
              <button
                onClick={() => {
                  setAdding(false);
                  setNewName("");
                  setError(null);
                }}
                className="flex-1 rounded-full border border-stone-300 py-1.5 text-sm font-semibold text-stone-600"
              >
                Avbryt
              </button>
              <button
                onClick={handleAdd}
                disabled={busy}
                className="flex-1 rounded-full bg-rose-500 py-1.5 text-sm font-semibold text-white disabled:opacity-40"
              >
                {busy ? "Lägger till…" : "Lägg till"}
              </button>
            </div>
          </div>
        ) : (
          <button
            onClick={() => {
              setAdding(true);
              setError(null);
            }}
            className="mt-3 text-sm font-medium text-rose-600 hover:underline"
          >
            + Lägg till barn
          </button>
        )}

        {error && <p className="mt-2 text-xs text-rose-600">{error}</p>}
      </div>

      {FIELD_GROUPS.map((group) => (
        <div key={group.title} className="rounded-2xl bg-white p-4 shadow-sm">
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-stone-400">{group.title}</h3>
          <div className="divide-y divide-stone-100">
            {group.fields.map((field) => (
              <InfoRow
                key={field.key}
                spec={field}
                value={(info?.[field.key] as string) ?? ""}
                onSave={(value) => onSave({ [field.key]: value } as Partial<ChildInfoDoc>)}
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function InfoRow({
  spec,
  value,
  onSave,
}: {
  spec: FieldSpec;
  value: string;
  onSave: (value: string) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const [revealed, setRevealed] = useState(false);
  const [saving, setSaving] = useState(false);

  async function save() {
    setSaving(true);
    await onSave(draft.trim());
    setSaving(false);
    setEditing(false);
    setRevealed(false);
  }

  if (editing) {
    return (
      <div className="py-3">
        <label className="mb-1 block text-sm text-stone-600">{spec.label}</label>
        {spec.multiline ? (
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={3}
            className="mb-2 w-full resize-none rounded-lg bg-stone-50 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-rose-400"
          />
        ) : (
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={spec.hint}
            className="mb-2 w-full rounded-lg bg-stone-50 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-rose-400"
          />
        )}
        <div className="flex gap-2">
          <button
            onClick={() => {
              setDraft(value);
              setEditing(false);
            }}
            className="flex-1 rounded-full border border-stone-300 py-1.5 text-sm font-semibold text-stone-600"
          >
            Avbryt
          </button>
          <button
            disabled={saving}
            onClick={save}
            className="flex-1 rounded-full bg-rose-500 py-1.5 text-sm font-semibold text-white disabled:opacity-40"
          >
            {saving ? "Sparar…" : "Spara"}
          </button>
        </div>
      </div>
    );
  }

  const hasValue = value.trim().length > 0;
  const displayValue =
    spec.sensitive && !revealed && hasValue ? "•".repeat(Math.min(value.length, 12)) : value;

  return (
    <div className="flex items-start justify-between gap-3 py-3">
      <span className="text-sm text-stone-600">{spec.label}</span>

      <span className="flex items-center gap-2 text-right">
        {hasValue ? (
          <>
            <span className="whitespace-pre-wrap text-sm font-medium text-stone-800">{displayValue}</span>
            {spec.sensitive && (
              <button
                onClick={() => setRevealed(!revealed)}
                className="text-xs text-stone-400 hover:text-rose-500"
              >
                {revealed ? "Dölj" : "Visa"}
              </button>
            )}
            <button
              onClick={() => {
                setDraft(value);
                setEditing(true);
              }}
              className="text-xs text-stone-400 hover:text-rose-500"
            >
              Ändra
            </button>
          </>
        ) : (
          <button
            onClick={() => {
              setDraft("");
              setEditing(true);
            }}
            className="text-sm text-stone-400 hover:text-rose-500"
          >
            Lägg till
          </button>
        )}
      </span>
    </div>
  );
}
