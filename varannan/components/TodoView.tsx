"use client";

import { useState } from "react";
import { TodoDoc } from "../types/schema";

interface TodoViewProps {
  todos: TodoDoc[];
  currentUserId: string;
  parentNames: Record<string, string>;
  onCreate: (title: string) => Promise<void>;
  onToggle: (todo: TodoDoc) => Promise<void>;
  onArchive: (todoId: string) => Promise<void>;
}

/**
 * Gemensamma "att göra"-uppgifter. Motsvarar TODO-fliken: avbockade
 * uppgifter får genomstruken titel, "Du gjorde detta <datum>" och en
 * ARKIVERA-knapp som gömmer dem utan att radera.
 */
export default function TodoView({
  todos,
  currentUserId,
  parentNames,
  onCreate,
  onToggle,
  onArchive,
}: TodoViewProps) {
  const [title, setTitle] = useState("");
  const [creating, setCreating] = useState(false);

  async function handleCreate() {
    if (!title.trim()) return;
    setCreating(true);
    await onCreate(title.trim());
    setTitle("");
    setCreating(false);
  }

  return (
    <div>
      {todos.length === 0 && (
        <p className="py-10 text-center text-sm text-stone-400">
          Inga uppgifter just nu. Lägg till något som behöver göras.
        </p>
      )}

      <div className="space-y-2">
        {todos.map((todo) => {
          const seenByOthers = todo.seenBy.filter((uid) => uid !== currentUserId);
          const doneByLabel =
            todo.doneBy === currentUserId ? "Du gjorde detta" : `${parentNames[todo.doneBy ?? ""] ?? "Förälder"} gjorde detta`;

          return (
            <div key={todo.id} className="rounded-2xl bg-white p-4 shadow-sm">
              <div className="flex items-start gap-3">
                <span className="flex-1">
                  <span className={`font-semibold ${todo.done ? "text-stone-400 line-through" : "text-stone-800"}`}>
                    {todo.title}
                  </span>
                  {todo.done && todo.doneAt && (
                    <span className="mt-0.5 block text-sm text-stone-400">
                      {doneByLabel} {formatDate(todo.doneAt)}
                    </span>
                  )}
                </span>

                <button
                  onClick={() => onToggle(todo)}
                  className={`grid h-9 w-9 shrink-0 place-items-center rounded-full transition ${
                    todo.done ? "bg-rose-500 text-white" : "border-2 border-stone-200 text-transparent hover:border-rose-400"
                  }`}
                  aria-label={todo.done ? "Markera som ej klar" : "Markera som klar"}
                >
                  ✓
                </button>
              </div>

              {todo.done && (
                <div className="mt-3 flex items-center justify-between border-t border-stone-100 pt-2">
                  <button
                    onClick={() => onArchive(todo.id)}
                    className="text-sm font-semibold uppercase tracking-wide text-stone-500 hover:text-rose-500"
                  >
                    Arkivera
                  </button>
                  {seenByOthers.length > 0 && (
                    <span className="text-xs text-stone-400">
                      Sedd av: {seenByOthers.map((uid) => parentNames[uid] ?? "Förälder").join(", ")}
                    </span>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className="mt-4 flex gap-2">
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void handleCreate();
          }}
          placeholder="Ny uppgift"
          className="flex-1 rounded-lg bg-white px-4 py-2.5 text-sm outline-none focus:ring-2 focus:ring-rose-400"
        />
        <button
          disabled={!title.trim() || creating}
          onClick={handleCreate}
          className="rounded-lg bg-rose-500 px-4 text-sm font-semibold text-white disabled:opacity-40"
        >
          Lägg till
        </button>
      </div>
    </div>
  );
}

function formatDate(ts: { seconds: number; nanoseconds: number }): string {
  return new Date(ts.seconds * 1000).toLocaleDateString("sv-SE");
}
