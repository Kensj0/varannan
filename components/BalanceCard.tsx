"use client";

import { DayBalanceDoc } from "../types/schema";
import { formatBalanceLabel } from "../lib/dayBalance";

interface BalanceCardProps {
  balance: DayBalanceDoc;
  parentNames: Record<string, string>;
  otherParentId: string;
}

/**
 * Motsvarar konceptet "Ställning" — antal dagar en förälder ligger plus.
 * Medvetet hållen på en enda rad: schemavyn ska rymmas på en mobilskärm
 * utan att man behöver skrolla för att se hela månaden.
 */
export default function BalanceCard({ balance, parentNames, otherParentId }: BalanceCardProps) {
  const label = formatBalanceLabel(balance, parentNames, otherParentId);
  const isEven = balance.balanceDays === 0;

  return (
    <div
      className={`flex items-center justify-between gap-3 rounded-xl px-4 py-2 shadow-sm ${
        isEven ? "bg-stone-100" : "bg-emerald-50"
      }`}
    >
      <span className="text-[10px] font-semibold uppercase tracking-wide text-stone-400">
        Ställning
      </span>
      <span
        className={`truncate text-sm font-bold ${isEven ? "text-stone-600" : "text-emerald-700"}`}
      >
        {label}
      </span>
    </div>
  );
}
