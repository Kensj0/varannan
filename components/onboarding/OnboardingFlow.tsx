"use client";

import { useState } from "react";

type Step = "team" | "child" | "invite";

interface OnboardingFlowProps {
  currentUserName: string;
  onCreateTeam: (teamName: string) => Promise<{ teamId: string }>;
  onAddChild: (teamId: string, name: string, birthYear?: number) => Promise<{ childId: string }>;
  onCreateInvite: (teamId: string) => Promise<{ code: string; shareUrl: string }>;
  onFinish: () => void;
  /** Om användaren redan hunnit skapa familj/barn innan hen avbröt. */
  resumeTeamId?: string | null;
  resumeHasChild?: boolean;
}

/**
 * Wizard: Skapa familj → Lägg till barn → Bjud in andra föräldern.
 *
 * OBS ordningen: boendeschemat sätts INTE här. Ett schema pekar på båda
 * föräldrarnas uid:n, och andra föräldern finns inte förrän hen accepterat
 * inbjudan. Cykeln sätts därför upp efteråt, av CycleSetupScreen, när båda
 * är på plats — och då kan båda vara med och bestämma den, vilket är
 * rimligare för ett schema som rör dem lika mycket.
 */
export default function OnboardingFlow(props: OnboardingFlowProps) {
  const [step, setStep] = useState<Step>(
    props.resumeTeamId ? (props.resumeHasChild ? "invite" : "child") : "team"
  );
  const [teamId, setTeamId] = useState<string | null>(props.resumeTeamId ?? null);
  const [invite, setInvite] = useState<{ code: string; shareUrl: string } | null>(null);

  return (
    <div className="mx-auto flex min-h-screen max-w-sm flex-col justify-center px-6 py-10">
      <ProgressDots step={step} />

      {step === "team" && (
        <TeamStep
          onNext={async (teamName) => {
            const result = await props.onCreateTeam(teamName);
            setTeamId(result.teamId);
            setStep("child");
          }}
        />
      )}

      {step === "child" && teamId && (
        <ChildStep
          onNext={async (name, birthYear) => {
            await props.onAddChild(teamId, name, birthYear);
            setStep("invite");
          }}
        />
      )}

      {step === "invite" && teamId && (
        <InviteStep
          invite={invite}
          onCreateInvite={async () => {
            const result = await props.onCreateInvite(teamId);
            setInvite(result);
            return result;
          }}
          onDone={props.onFinish}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

function ProgressDots({ step }: { step: Step }) {
  const order: Step[] = ["team", "child", "invite"];
  const index = order.indexOf(step);
  return (
    <div className="mb-8 flex justify-center gap-2">
      {order.map((s, i) => (
        <span key={s} className={`h-1.5 w-6 rounded-full transition ${i <= index ? "bg-rose-500" : "bg-stone-200"}`} />
      ))}
    </div>
  );
}

function TeamStep({ onNext }: { onNext: (teamName: string) => Promise<void> }) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <div>
      <h1 className="mb-2 text-2xl font-bold text-stone-800">Skapa er familj</h1>
      <p className="mb-6 text-stone-500">
        Det här blir platsen där ni delar schema, listor och information om barnen.
      </p>
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="T.ex. Familjen Andersson"
        className="mb-6 w-full rounded-lg bg-stone-100 px-4 py-3 outline-none focus:ring-2 focus:ring-rose-400"
      />
      {error && <p className="mb-3 text-sm text-rose-600">{error}</p>}
      <button
        disabled={!name.trim() || busy}
        onClick={async () => {
          setBusy(true);
          setError(null);
          try {
            await onNext(name.trim());
          } catch {
            setError("Kunde inte skapa familjen. Försök igen.");
            setBusy(false);
          }
        }}
        className="w-full rounded-full bg-rose-500 py-3 font-semibold text-white disabled:opacity-40"
      >
        {busy ? "Skapar…" : "Nästa"}
      </button>
    </div>
  );
}

function ChildStep({ onNext }: { onNext: (name: string, birthYear?: number) => Promise<void> }) {
  const [name, setName] = useState("");
  const [birthYear, setBirthYear] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <div>
      <h1 className="mb-2 text-2xl font-bold text-stone-800">Lägg till ert barn</h1>
      <p className="mb-6 text-stone-500">
        Ni kan lägga till fler barn senare — varje barn får sitt eget schema.
      </p>
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Barnets namn"
        className="mb-3 w-full rounded-lg bg-stone-100 px-4 py-3 outline-none focus:ring-2 focus:ring-rose-400"
      />
      <input
        value={birthYear}
        onChange={(e) => setBirthYear(e.target.value.replace(/[^0-9]/g, "").slice(0, 4))}
        placeholder="Födelseår (valfritt)"
        inputMode="numeric"
        className="mb-6 w-full rounded-lg bg-stone-100 px-4 py-3 outline-none focus:ring-2 focus:ring-rose-400"
      />
      {error && <p className="mb-3 text-sm text-rose-600">{error}</p>}
      <button
        disabled={!name.trim() || busy}
        onClick={async () => {
          setBusy(true);
          setError(null);
          try {
            await onNext(name.trim(), birthYear ? Number(birthYear) : undefined);
          } catch {
            setError("Kunde inte spara barnet. Försök igen.");
            setBusy(false);
          }
        }}
        className="w-full rounded-full bg-rose-500 py-3 font-semibold text-white disabled:opacity-40"
      >
        {busy ? "Sparar…" : "Nästa"}
      </button>
    </div>
  );
}

function InviteStep({
  invite,
  onCreateInvite,
  onDone,
}: {
  invite: { code: string; shareUrl: string } | null;
  onCreateInvite: () => Promise<{ code: string; shareUrl: string }>;
  onDone: () => void;
}) {
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function share(shareUrl: string) {
    // Web Share API på mobil, annars kopiera till urklipp.
    if (typeof navigator !== "undefined" && navigator.share) {
      try {
        await navigator.share({
          title: "Varannan",
          text: "Gå med i vår familj i Varannan så delar vi schemat.",
          url: shareUrl,
        });
        return;
      } catch {
        // Användaren avbröt delningen — fall igenom till kopiering.
      }
    }
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch {
      setError("Kunde inte kopiera. Markera länken och kopiera manuellt.");
    }
  }

  return (
    <div>
      <h1 className="mb-2 text-2xl font-bold text-stone-800">Bjud in andra föräldern</h1>
      <p className="mb-6 text-stone-500">
        Boendeschemat sätts upp när ni båda är med, så ni kan bestämma det tillsammans.
      </p>

      {invite ? (
        <div className="mb-4">
          <div className="mb-3 rounded-xl bg-stone-50 p-4 text-center">
            <p className="text-xs font-semibold uppercase text-stone-400">Inbjudningskod</p>
            <p className="my-2 font-mono text-3xl font-bold tracking-widest text-rose-600">{invite.code}</p>
            <p className="break-all text-xs text-stone-400">{invite.shareUrl}</p>
          </div>
          <button
            onClick={() => share(invite.shareUrl)}
            className="mb-2 w-full rounded-full bg-rose-500 py-3 font-semibold text-white"
          >
            {copied ? "Länk kopierad" : "Dela länken"}
          </button>
          <p className="mb-4 text-center text-xs text-stone-400">Koden gäller i 72 timmar och kan bara användas en gång.</p>
        </div>
      ) : (
        <button
          disabled={loading}
          onClick={async () => {
            setLoading(true);
            setError(null);
            try {
              await onCreateInvite();
            } catch {
              setError("Kunde inte skapa koden. Försök igen.");
            } finally {
              setLoading(false);
            }
          }}
          className="mb-4 w-full rounded-full bg-rose-500 py-3 font-semibold text-white disabled:opacity-40"
        >
          {loading ? "Skapar kod…" : "Skapa inbjudningskod"}
        </button>
      )}

      {error && <p className="mb-3 text-sm text-rose-600">{error}</p>}

      <button onClick={onDone} className="w-full py-2 text-sm text-stone-500 hover:text-rose-500">
        {invite ? "Klar — till appen" : "Hoppa över, jag bjuder in senare"}
      </button>
    </div>
  );
}
