"use client";

import { useState } from "react";
import { useAuth } from "../../lib/auth/AuthProvider";

type Mode = "signin" | "signup";

export default function LoginForm() {
  const { signInWithEmail, signUpWithEmail, signInWithGoogle, resetPassword } = useAuth();

  const [mode, setMode] = useState<Mode>("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [resetSent, setResetSent] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      if (mode === "signup") {
        await signUpWithEmail(email, password, displayName);
      } else {
        await signInWithEmail(email, password);
      }
    } catch (err) {
      setError(mapFirebaseError(err));
    } finally {
      setLoading(false);
    }
  }

  async function handleGoogle() {
    setError(null);
    setLoading(true);
    try {
      await signInWithGoogle();
    } catch (err) {
      setError(mapFirebaseError(err));
    } finally {
      setLoading(false);
    }
  }

  async function handleReset() {
    if (!email.trim()) {
      setError("Fyll i din e-post ovan först.");
      return;
    }
    setError(null);
    try {
      await resetPassword(email.trim());
      setResetSent(true);
    } catch (err) {
      setError(mapFirebaseError(err));
    }
  }

  return (
    <div className="mx-auto flex min-h-screen max-w-sm flex-col justify-center px-6">
      <h1 className="mb-1 text-3xl font-bold text-stone-800">Varannan</h1>
      <p className="mb-8 text-stone-500">
        {mode === "signin" ? "Logga in för att se ert schema." : "Skapa konto för att komma igång."}
      </p>

      <button
        onClick={handleGoogle}
        disabled={loading}
        className="mb-4 flex w-full items-center justify-center gap-2 rounded-full border border-stone-300 py-3 font-semibold text-stone-700 hover:bg-stone-50 disabled:opacity-40"
      >
        <GoogleIcon />
        Fortsätt med Google
      </button>

      <div className="mb-4 flex items-center gap-3 text-xs text-stone-400">
        <div className="h-px flex-1 bg-stone-200" />
        eller
        <div className="h-px flex-1 bg-stone-200" />
      </div>

      <form onSubmit={handleSubmit}>
        {mode === "signup" && (
          <input
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder="Ditt namn"
            className="mb-3 w-full rounded-lg bg-stone-100 px-4 py-3 outline-none focus:ring-2 focus:ring-rose-400"
          />
        )}
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="E-post"
          autoComplete="email"
          className="mb-3 w-full rounded-lg bg-stone-100 px-4 py-3 outline-none focus:ring-2 focus:ring-rose-400"
        />
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Lösenord"
          autoComplete={mode === "signup" ? "new-password" : "current-password"}
          className="mb-2 w-full rounded-lg bg-stone-100 px-4 py-3 outline-none focus:ring-2 focus:ring-rose-400"
        />

        {mode === "signin" && (
          <button type="button" onClick={handleReset} className="mb-4 block text-sm text-stone-400 hover:text-rose-500">
            Glömt lösenord?
          </button>
        )}
        {mode === "signup" && <div className="mb-4" />}

        {resetSent && <p className="mb-4 text-sm text-emerald-600">Återställningslänk skickad — kolla din e-post.</p>}
        {error && <p className="mb-4 text-sm text-rose-600">{error}</p>}

        <button
          type="submit"
          disabled={loading || !email.trim() || !password.trim()}
          className="w-full rounded-full bg-rose-500 py-3 font-semibold text-white disabled:opacity-40"
        >
          {mode === "signin" ? "Logga in" : "Skapa konto"}
        </button>
      </form>

      <button
        onClick={() => setMode(mode === "signin" ? "signup" : "signin")}
        className="mt-6 text-sm text-stone-500"
      >
        {mode === "signin" ? "Inget konto än? " : "Har redan ett konto? "}
        <span className="font-semibold text-rose-600">{mode === "signin" ? "Skapa ett" : "Logga in"}</span>
      </button>
    </div>
  );
}

function mapFirebaseError(err: unknown): string {
  const code = (err as { code?: string })?.code ?? "";
  switch (code) {
    case "auth/invalid-email":
      return "Ogiltig e-postadress.";
    case "auth/user-not-found":
    case "auth/wrong-password":
    case "auth/invalid-credential":
      return "Fel e-post eller lösenord.";
    case "auth/email-already-in-use":
      return "Det finns redan ett konto med den e-postadressen.";
    case "auth/weak-password":
      return "Lösenordet måste vara minst 6 tecken.";
    case "auth/popup-closed-by-user":
      return "Google-inloggningen avbröts.";
    default:
      return "Något gick fel. Försök igen.";
  }
}

function GoogleIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
      <path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.62Z" />
      <path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.81.54-1.85.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H.95v2.33A9 9 0 0 0 9 18Z" />
      <path fill="#FBBC05" d="M3.97 10.72A5.4 5.4 0 0 1 3.68 9c0-.6.1-1.18.29-1.72V4.95H.95A9 9 0 0 0 0 9c0 1.45.35 2.83.95 4.05l3.02-2.33Z" />
      <path fill="#EA4335" d="M9 3.58c1.32 0 2.51.45 3.44 1.35l2.58-2.58C13.46.89 11.43 0 9 0A9 9 0 0 0 .95 4.95l3.02 2.33C4.68 5.16 6.66 3.58 9 3.58Z" />
    </svg>
  );
}
