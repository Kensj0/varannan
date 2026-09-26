"use client";

import { useState } from "react";
import { TeamInviteDoc } from "../types/schema";

interface PendingCalendarInvitesProps {
  invites: TeamInviteDoc[];
  currentUserId: string;
  childName: string;
  onRespond: (code: string, decision: "approve" | "decline") => Promise<void>;
}

function roleLabel(role: TeamInviteDoc["role"]): string {
  if (role === "viewer") return "utomstående";
  return "anhörig";
}

/**
 * Väntande anhörig/utomstående-inbjudningar som kräver ett ja eller nej
 * innan koden mailas till den inbjudna (dubbelt godkännande, etapp 2 —
 * se docs/roller-och-medlemskap.md och approveCalendarInvite i
 * functions/src/index.ts).
 *
 * Samma mönster som PendingStructureRequests: den som skapade
 * inbjudan ser den utan knappar (väntar), den som faktiskt behöver
 * godkänna ser Godkänn/Neka. En förälder vars scheduleChangeMode är
 * "notis" räknas som redan godkänd av servern och dyker aldrig upp
 * här som blockerande.
 */
export default function PendingCalendarInvites({
  invites,
  currentUserId,
  childName,
  onRespond,
}: PendingCalendarInvitesProps) {
  const [busyCode, setBusyCode] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const relevant = invites.filter(
    (invite) =>
      invite.invitedBy === currentUserId ||
      ((invite.requiredApprovers ?? []).includes(currentUserId) &&
        !(invite.approvedBy ?? []).includes(currentUserId))
  );

  if (relevant.length === 0) return null;

  return (
    <div className="mb-3 space-y-2">
      {relevant.map((invite) => {
        const mine = invite.invitedBy === currentUserId;
        const label = roleLabel(invite.role);
        return (
          <div key={invite.code} className="rounded-2xl bg-amber-50 p-3 ring-1 ring-amber-200">
            <p className="text-sm font-semibold text-amber-900">
              {mine ? "Väntar på godkännande" : `Inbjudan som ${label}`}
            </p>
            <p className="mt-0.5 text-[13px] leading-snug text-amber-800">
              {mine
                ? `${invite.invitedEmail} väntar på att bli inbjuden som ${label} till ${childName} — den andra föräldern behöver godkänna först.`
                : `Någon vill bjuda in ${invite.invitedEmail} som ${label} till ${childName}.`}
            </p>

            {!mine && (
              <div className="mt-2 flex gap-2">
                <button
                  disabled={busyCode === invite.code}
                  onClick={async () => {
                    setBusyCode(invite.code);
                    setError(null);
                    try {
                      await onRespond(invite.code, "decline");
                    } catch {
                      setError("Kunde inte svara. Försök igen.");
                    } finally {
                      setBusyCode(null);
                    }
                  }}
                  className="flex-1 rounded-full border border-amber-300 bg-white py-1.5 text-sm font-semibold text-amber-800 disabled:opacity-50"
                >
                  Neka
                </button>
                <button
                  disabled={busyCode === invite.code}
                  onClick={async () => {
                    setBusyCode(invite.code);
                    setError(null);
                    try {
                      await onRespond(invite.code, "approve");
                    } catch {
                      setError("Kunde inte svara. Försök igen.");
                    } finally {
                      setBusyCode(null);
                    }
                  }}
                  className="flex-1 rounded-full bg-amber-600 py-1.5 text-sm font-semibold text-white disabled:opacity-50"
                >
                  {busyCode === invite.code ? "Sparar…" : "Godkänn"}
                </button>
              </div>
            )}

            {error && <p className="mt-1 text-[11px] text-rose-700">{error}</p>}
          </div>
        );
      })}
    </div>
  );
}
