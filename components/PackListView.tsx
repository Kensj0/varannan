"use client";

import { useEffect, useState } from "react";
import { PackListDoc, ShiftRequestDoc } from "../types/schema";

interface PackListViewProps {
  lists: PackListDoc[];
  currentUserId: string;
  parentNames: Record<string, string>;
  childName: string;
  /** Nästa kommande byte, för banderollen överst. */
  nextShift?: ShiftRequestDoc;
  nextOrdinaryHandoff?: Date;
  onCreateList: (title: string) => Promise<void>;
  onAddItem: (list: PackListDoc, name: string) => Promise<void>;
  onToggleItem: (list: PackListDoc, itemId: string) => Promise<void>;
  onRemoveItem: (list: PackListDoc, itemId: string) => Promise<void>;
  onMarkSeen: (listId: string) => Promise<void>;
}

/**
 * Packlistor knutna till nästa byte. Motsvarar PACKLISTA-fliken:
 * lila banderoll med när nästa byte sker, sedan listorna med
 * avbockning och "Sedd av"-markering.
 */
export default function PackListView({
  lists,
  currentUserId,
  parentNames,
  childName,
  nextOrdinaryHandoff,
  onCreateList,
  onAddItem,
  onToggleItem,
  onRemoveItem,
  onMarkSeen,
}: PackListViewProps) {
  const [newListTitle, setNewListTitle] = useState("");
  const [creating, setCreating] = useState(false);

  // Markera listor som sedda när de visas för den andra föräldern.
  useEffect(() => {
    for (const list of lists) {
      if (!list.seenBy.includes(currentUserId)) {
        void onMarkSeen(list.id);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lists.map((l) => l.id).join(",")]);

  return (
    <div>
      <div className="mb-4 rounded-2xl bg-violet-800 px-5 py-4 text-white">
        <p className="text-sm opacity-80">Nästa byte för {childName}:</p>
        <p className="mt-1 text-lg font-bold">
          {nextOrdinaryHandoff ? formatHandoff(nextOrdinaryHandoff) : "Inget byte inplanerat."}
        </p>
      </div>

      <div className="space-y-3">
        {lists.length === 0 && (
          <p className="py-8 text-center text-sm text-stone-400">
            Ingen packlista än. Skapa en för regnkläder, gosedjur eller annat som ska med.
          </p>
        )}

        {lists.map((list) => (
          <PackListCard
            key={list.id}
            list={list}
            currentUserId={currentUserId}
            parentNames={parentNames}
            onAddItem={onAddItem}
            onToggleItem={onToggleItem}
            onRemoveItem={onRemoveItem}
          />
        ))}
      </div>

      <div className="mt-4 flex gap-2">
        <input
          value={newListTitle}
          onChange={(e) => setNewListTitle(e.target.value)}
          placeholder="Ny lista, t.ex. Regnkläder"
          className="flex-1 rounded-lg bg-white px-4 py-2.5 text-sm outline-none focus:ring-2 focus:ring-rose-400"
        />
        <button
          disabled={!newListTitle.trim() || creating}
          onClick={async () => {
            setCreating(true);
            await onCreateList(newListTitle.trim());
            setNewListTitle("");
            setCreating(false);
          }}
          className="rounded-lg bg-rose-500 px-4 text-sm font-semibold text-white disabled:opacity-40"
        >
          Skapa
        </button>
      </div>
    </div>
  );
}

function PackListCard({
  list,
  currentUserId,
  parentNames,
  onAddItem,
  onToggleItem,
  onRemoveItem,
}: {
  list: PackListDoc;
  currentUserId: string;
  parentNames: Record<string, string>;
  onAddItem: (list: PackListDoc, name: string) => Promise<void>;
  onToggleItem: (list: PackListDoc, itemId: string) => Promise<void>;
  onRemoveItem: (list: PackListDoc, itemId: string) => Promise<void>;
}) {
  const [newItem, setNewItem] = useState("");
  const packed = list.items.filter((i) => i.checked).length;
  const seenByOthers = list.seenBy.filter((uid) => uid !== currentUserId);

  return (
    <div className="rounded-2xl bg-white p-4 shadow-sm">
      <div className="mb-2 flex items-baseline justify-between">
        <h3 className="font-bold text-stone-800">{list.title}</h3>
        <span className="text-xs text-stone-400">
          {packed}/{list.items.length} packat
        </span>
      </div>

      <ul className="space-y-1">
        {list.items.map((item) => (
          <li key={item.id} className="group flex items-center gap-2">
            <button
              onClick={() => onToggleItem(list, item.id)}
              className={`grid h-5 w-5 shrink-0 place-items-center rounded-full border text-[11px] ${
                item.checked ? "border-emerald-500 bg-emerald-500 text-white" : "border-stone-300"
              }`}
              aria-label={item.checked ? "Ta bort bock" : "Bocka av"}
            >
              {item.checked ? "✓" : ""}
            </button>
            <span className={`flex-1 text-sm ${item.checked ? "text-stone-400 line-through" : "text-stone-700"}`}>
              {item.name}
            </span>
            <button
              onClick={() => onRemoveItem(list, item.id)}
              className="text-stone-300 opacity-0 transition group-hover:opacity-100 hover:text-rose-500"
              aria-label="Ta bort"
            >
              ✕
            </button>
          </li>
        ))}
      </ul>

      <div className="mt-2 flex gap-2">
        <input
          value={newItem}
          onChange={(e) => setNewItem(e.target.value)}
          onKeyDown={async (e) => {
            if (e.key === "Enter" && newItem.trim()) {
              await onAddItem(list, newItem.trim());
              setNewItem("");
            }
          }}
          placeholder="Lägg till sak"
          className="flex-1 rounded-lg bg-stone-50 px-3 py-1.5 text-sm outline-none focus:ring-2 focus:ring-rose-400"
        />
      </div>

      {seenByOthers.length > 0 && (
        <p className="mt-2 text-xs text-stone-400">
          Sedd av: {seenByOthers.map((uid) => parentNames[uid] ?? "Förälder").join(", ")}
        </p>
      )}
    </div>
  );
}

function formatHandoff(date: Date): string {
  const now = new Date();
  if (date < now) return "Det här bytet har redan varit.";
  return date.toLocaleString("sv-SE", {
    weekday: "long",
    day: "numeric",
    month: "long",
    hour: "2-digit",
    minute: "2-digit",
  });
}
