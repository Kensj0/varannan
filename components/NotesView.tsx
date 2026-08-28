"use client";

import { useState } from "react";
import { NoteDoc } from "../types/schema";

interface NotesViewProps {
  notes: NoteDoc[];
  parentNames: Record<string, string>;
  onCreate: (title: string, content: string) => Promise<void>;
  onUpdate: (noteId: string, patch: { title?: string; content?: string }) => Promise<void>;
  onDelete: (noteId: string) => Promise<void>;
}

/**
 * Gemensamma anteckningar — önskelistor, inköp, packlistor inför läger.
 * Motsvarar NOTES-fliken. Redigering sker inline i kortet.
 */
export default function NotesView({ notes, parentNames, onCreate, onUpdate, onDelete }: NotesViewProps) {
  const [composing, setComposing] = useState(false);
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");

  async function handleCreate() {
    if (!title.trim()) return;
    await onCreate(title.trim(), content.trim());
    setTitle("");
    setContent("");
    setComposing(false);
  }

  return (
    <div>
      {notes.length === 0 && !composing && (
        <p className="py-10 text-center text-sm text-stone-400">
          Här kan ni dela önskelistor, inköp eller vad som behöver köpas inför lägret.
        </p>
      )}

      <div className="space-y-3">
        {notes.map((note) => (
          <NoteCard
            key={note.id}
            note={note}
            authorName={parentNames[note.createdBy] ?? "Förälder"}
            onUpdate={onUpdate}
            onDelete={onDelete}
          />
        ))}
      </div>

      {composing ? (
        <div className="mt-3 rounded-2xl bg-white p-4 shadow-sm">
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Rubrik"
            className="mb-2 w-full rounded-lg bg-stone-50 px-3 py-2 text-sm font-semibold outline-none focus:ring-2 focus:ring-rose-400"
          />
          <textarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            placeholder="Skriv något…"
            rows={4}
            className="mb-3 w-full resize-none rounded-lg bg-stone-50 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-rose-400"
          />
          <div className="flex gap-2">
            <button
              onClick={() => setComposing(false)}
              className="flex-1 rounded-full border border-stone-300 py-2 text-sm font-semibold text-stone-600"
            >
              Avbryt
            </button>
            <button
              disabled={!title.trim()}
              onClick={handleCreate}
              className="flex-1 rounded-full bg-rose-500 py-2 text-sm font-semibold text-white disabled:opacity-40"
            >
              Spara
            </button>
          </div>
        </div>
      ) : (
        <button
          onClick={() => setComposing(true)}
          className="mt-3 w-full rounded-full bg-rose-500 py-3 text-sm font-semibold text-white"
        >
          + Ny anteckning
        </button>
      )}
    </div>
  );
}

function NoteCard({
  note,
  authorName,
  onUpdate,
  onDelete,
}: {
  note: NoteDoc;
  authorName: string;
  onUpdate: (noteId: string, patch: { title?: string; content?: string }) => Promise<void>;
  onDelete: (noteId: string) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(note.title);
  const [content, setContent] = useState(note.content);

  if (editing) {
    return (
      <div className="rounded-2xl bg-white p-4 shadow-sm">
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          className="mb-2 w-full rounded-lg bg-stone-50 px-3 py-2 text-sm font-semibold outline-none focus:ring-2 focus:ring-rose-400"
        />
        <textarea
          value={content}
          onChange={(e) => setContent(e.target.value)}
          rows={4}
          className="mb-3 w-full resize-none rounded-lg bg-stone-50 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-rose-400"
        />
        <div className="flex gap-2">
          <button
            onClick={() => {
              setTitle(note.title);
              setContent(note.content);
              setEditing(false);
            }}
            className="flex-1 rounded-full border border-stone-300 py-2 text-sm font-semibold text-stone-600"
          >
            Avbryt
          </button>
          <button
            onClick={async () => {
              await onUpdate(note.id, { title: title.trim(), content: content.trim() });
              setEditing(false);
            }}
            className="flex-1 rounded-full bg-rose-500 py-2 text-sm font-semibold text-white"
          >
            Spara
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-2xl bg-white p-4 shadow-sm">
      <div className="flex items-start justify-between gap-2">
        <h3 className="font-bold text-stone-800">{note.title}</h3>
        <div className="flex shrink-0 gap-2">
          <button onClick={() => setEditing(true)} className="text-xs text-stone-400 hover:text-rose-500">
            Ändra
          </button>
          <button onClick={() => onDelete(note.id)} className="text-xs text-stone-400 hover:text-rose-500">
            Ta bort
          </button>
        </div>
      </div>
      {note.content && <p className="mt-1 whitespace-pre-wrap text-sm text-stone-600">{note.content}</p>}
      <p className="mt-2 text-xs text-stone-400">
        {authorName} · {formatDate(note.updatedAt)}
      </p>
    </div>
  );
}

function formatDate(ts: { seconds: number; nanoseconds: number }): string {
  return new Date(ts.seconds * 1000).toLocaleDateString("sv-SE", { day: "numeric", month: "short" });
}
