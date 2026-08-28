"use client";

import { DayBalanceDoc } from "../types/schema";
import { formatBalanceLabel } from "../lib/dayBalance";

interface BalanceCardProps {
  balance: DayBalanceDoc;
  parentNames: Record<string, string>;
  otherParentId: string;
}

/** Motsvarar konceptet "Ställning" — antal dagar en förälder ligger plus. */
export default function BalanceCard({ balance, parentNames, otherParentId }: BalanceCardProps) {
  const label = formatBalanceLabel(balance, parentNames, otherParentId);
  const isEven = balance.balanceDays === 0;

  return (
    <div className={`rounded-2xl px-5 py-4 shadow-sm ${isEven ? "bg-stone-100" : "bg-emerald-50"}`}>
      <p className="text-xs font-semibold uppercase tracking-wide text-stone-400">Ställning</p>
      <p className={`mt-1 text-lg font-bold ${isEven ? "text-stone-600" : "text-emerald-700"}`}>{label}</p>
    </div>
  );
}
