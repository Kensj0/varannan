"use client";

import CustodyCycleBuilder, { CycleParent } from "./CustodyCycleBuilder";
import { CustodyCycleBlock } from "../../types/schema";

interface CycleSetupScreenProps {
  childName: string;
  parents: [CycleParent, CycleParent];
  onSave: (blocks: CustodyCycleBlock[], cycleStartDate: string, switchHour: string) => Promise<void>;
}

/**
 * Visas när båda föräldrarna finns men barnet saknar boendeschema.
 * Det här är steget som tidigare låg i onboarding-wizarden, men som
 * inte kunde fungera där: cykelns block pekar på uid:n, och andra
 * förälderns uid finns inte förrän hen accepterat inbjudan.
 *
 * Bägge föräldrarna ser den här skärmen tills en av dem sparat schemat.
 */
export default function CycleSetupScreen({ childName, parents, onSave }: CycleSetupScreenProps) {
  return (
    <main className="mx-auto max-w-md px-6 py-10">
      <p className="mb-1 text-sm font-semibold uppercase tracking-wide text-rose-500">Sista steget</p>
      <CustodyCycleBuilder childName={childName} parents={parents} onSave={onSave} />
      <p className="mt-4 text-center text-xs text-stone-400">
        Ni kan ändra schemat senare. Tillfälliga avvikelser gör ni med "Ändra ansvar" i kalendern — de påverkar
        ställningen, till skillnad från en ändring av grundschemat.
      </p>
    </main>
  );
}
