"use client";

import { AGREEMENT_SECTIONS } from "../lib/agreementText";

interface AgreementDialogProps {
  onClose: () => void;
}

/**
 * Skrivskyddad visning av "Avtalet" — beskriver hur schemat redan
 * fungerar, och vad föräldrarna i praktiken förbinder sig till. Rent
 * innehåll, ingen redigering och ingen datakoppling: se
 * lib/agreementText.ts för själva texten.
 */
export default function AgreementDialog({ onClose }: AgreementDialogProps) {
  return (
    <div className="fixed inset-0 z-[60] flex items-end justify-center sm:items-center">
      <div className="absolute inset-0 bg-stone-900/40" onClick={onClose} />

      <div className="relative z-10 max-h-[85vh] w-full max-w-md overflow-y-auto rounded-t-3xl bg-white p-5 shadow-xl sm:rounded-3xl">
        <div className="mb-4 flex items-start justify-between gap-3">
          <h2 className="text-lg font-bold text-stone-800">Avtal</h2>
          <button
            onClick={onClose}
            aria-label="Stäng"
            className="grid h-7 w-7 shrink-0 place-items-center rounded-full text-stone-400 hover:bg-stone-50"
          >
            ✕
          </button>
        </div>

        <div className="space-y-4">
          {AGREEMENT_SECTIONS.map((section) => (
            <div key={section.title}>
              <p className="text-sm font-semibold text-stone-800">{section.title}</p>
              <p className="mt-1 text-sm leading-snug text-stone-600">{section.body}</p>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
