"use client";

import { useState } from "react";
import { ChildAccountDoc } from "../types/schema";

interface AccountsViewProps {
  accounts: ChildAccountDoc[];
  parentNames: Record<string, string>;
  onCreate: (service: string, username: string, pinOrNote: string) => Promise<void>;
  onUpdate: (
    accountId: string,
    patch: { service?: string; username?: string; pinOrNote?: string }
  ) => Promise<void>;
  onDelete: (accountId: string) => Promise<void>;
}

/**
 * Motsvarar KONTON-fliken: streamingtjänster, PIN-koder och andra
 * inloggningar som båda föräldrarna behöver.
 *
 * Lösenord/PIN visas alltid maskerat tills man aktivt trycker "Visa".
 */
export default function AccountsView({
  accounts,
  parentNames,
  onCreate,
  onUpdate,
  onDelete,
}: AccountsViewProps) {
  const [composing, setComposing] = useState(false);
  const [service, setService] = useState("");
  const [username, setUsername] = useState("");
  const [pinOrNote, setPinOrNote] = useState("");

  async function handleCreate() {
    if (!service.trim()) return;
    await onCreate(service.trim(), username.trim(), pinOrNote.trim());
    setService("");
    setUsername("");
    setPinOrNote("");
    setComposing(false);
  }

  return (
    <div>
      {accounts.length === 0 && !composing && (
        <p className="py-10 text-center text-sm text-stone-400">
          Finns det någon streamingtjänst eller PIN-kod som barnet har? Lägg in kontot och dela på kostnaden.
        </p>
      )}

      <div className="space-y-3">
        {accounts.map((account) => (
          <AccountCard
            key={account.id}
            account={account}
            addedByName={parentNames[account.addedBy] ?? "Förälder"}
            onUpdate={onUpdate}
            onDelete={onDelete}
          />
        ))}
      </div>

      {composing ? (
        <div className="mt-3 rounded-2xl bg-white p-4 shadow-sm">
          <input
            value={service}
            onChange={(e) => setService(e.target.value)}
            placeholder="Tjänst, t.ex. Netflix"
            className="mb-2 w-full rounded-lg bg-stone-50 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-rose-400"
          />
          <input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="Användarnamn (valfritt)"
            className="mb-2 w-full rounded-lg bg-stone-50 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-rose-400"
          />
          <input
            value={pinOrNote}
            onChange={(e) => setPinOrNote(e.target.value)}
            placeholder="PIN eller anteckning"
            className="mb-3 w-full rounded-lg bg-stone-50 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-rose-400"
          />
          <div className="flex gap-2">
            <button
              onClick={() => setComposing(false)}
              className="flex-1 rounded-full border border-stone-300 py-2 text-sm font-semibold text-stone-600"
            >
              Avbryt
            </button>
            <button
              disabled={!service.trim()}
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
          + Lägg till konto
        </button>
      )}
    </div>
  );
}

function AccountCard({
  account,
  addedByName,
  onUpdate,
  onDelete,
}: {
  account: ChildAccountDoc;
  addedByName: string;
  onUpdate: (
    accountId: string,
    patch: { service?: string; username?: string; pinOrNote?: string }
  ) => Promise<void>;
  onDelete: (accountId: string) => Promise<void>;
}) {
  const [revealed, setRevealed] = useState(false);
  const [editing, setEditing] = useState(false);
  const [service, setService] = useState(account.service);
  const [username, setUsername] = useState(account.username ?? "");
  const [pinOrNote, setPinOrNote] = useState(account.pinOrNote ?? "");

  if (editing) {
    return (
      <div className="rounded-2xl bg-white p-4 shadow-sm">
        <input
          value={service}
          onChange={(e) => setService(e.target.value)}
          className="mb-2 w-full rounded-lg bg-stone-50 px-3 py-2 text-sm font-semibold outline-none focus:ring-2 focus:ring-rose-400"
        />
        <input
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          placeholder="Användarnamn"
          className="mb-2 w-full rounded-lg bg-stone-50 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-rose-400"
        />
        <input
          value={pinOrNote}
          onChange={(e) => setPinOrNote(e.target.value)}
          placeholder="PIN eller anteckning"
          className="mb-3 w-full rounded-lg bg-stone-50 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-rose-400"
        />
        <div className="flex gap-2">
          <button
            onClick={() => {
              setService(account.service);
              setUsername(account.username ?? "");
              setPinOrNote(account.pinOrNote ?? "");
              setEditing(false);
            }}
            className="flex-1 rounded-full border border-stone-300 py-2 text-sm font-semibold text-stone-600"
          >
            Avbryt
          </button>
          <button
            onClick={async () => {
              await onUpdate(account.id, {
                service: service.trim(),
                username: username.trim(),
                pinOrNote: pinOrNote.trim(),
              });
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
        <h3 className="font-bold text-stone-800">{account.service}</h3>
        <div className="flex shrink-0 gap-2">
          <button onClick={() => setEditing(true)} className="text-xs text-stone-400 hover:text-rose-500">
            Ändra
          </button>
          <button onClick={() => onDelete(account.id)} className="text-xs text-stone-400 hover:text-rose-500">
            Ta bort
          </button>
        </div>
      </div>

      {account.username && <p className="mt-1 text-sm text-stone-600">{account.username}</p>}

      {account.pinOrNote && (
        <p className="mt-1 flex items-center gap-2 text-sm">
          <span className="font-mono text-stone-800">
            {revealed ? account.pinOrNote : "•".repeat(Math.min(account.pinOrNote.length, 12))}
          </span>
          <button onClick={() => setRevealed(!revealed)} className="text-xs text-stone-400 hover:text-rose-500">
            {revealed ? "Dölj" : "Visa"}
          </button>
        </p>
      )}

      <p className="mt-2 text-xs text-stone-400">Tillagt av {addedByName}</p>
    </div>
  );
}
