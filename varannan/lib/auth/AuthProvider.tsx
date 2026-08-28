"use client";

import { createContext, useContext, useEffect, useState, ReactNode } from "react";
import {
  User,
  onAuthStateChanged,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signInWithPopup,
  GoogleAuthProvider,
  signOut,
  updateProfile,
  sendPasswordResetEmail,
} from "firebase/auth";
import { auth } from "../firebase";
import { ensureUserDocument } from "./ensureUserDocument";
import { UserDoc } from "../../types/schema";

interface AuthContextValue {
  user: User | null;
  userDoc: UserDoc | null;
  loading: boolean;
  signUpWithEmail: (email: string, password: string, displayName: string) => Promise<void>;
  signInWithEmail: (email: string, password: string) => Promise<void>;
  signInWithGoogle: () => Promise<void>;
  resetPassword: (email: string) => Promise<void>;
  signOutUser: () => Promise<void>;
  /** Kalla efter t.ex. createFamilyTeam-callable lyckats, så UI:t uppdateras utan omladdning. */
  refreshUserDoc: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [userDoc, setUserDoc] = useState<UserDoc | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (firebaseUser) => {
      setUser(firebaseUser);
      if (firebaseUser) {
        const doc = await ensureUserDocument(firebaseUser);
        setUserDoc(doc);
      } else {
        setUserDoc(null);
      }
      setLoading(false);
    });
    return unsubscribe;
  }, []);

  async function refreshUserDoc() {
    if (!user) return;
    const doc = await ensureUserDocument(user);
    setUserDoc(doc);
  }

  async function signUpWithEmail(email: string, password: string, displayName: string) {
    const cred = await createUserWithEmailAndPassword(auth, email, password);
    if (displayName.trim()) {
      await updateProfile(cred.user, { displayName: displayName.trim() });
    }
    // onAuthStateChanged ovan skapar users/{uid} automatiskt.
  }

  async function signInWithEmail(email: string, password: string) {
    await signInWithEmailAndPassword(auth, email, password);
  }

  async function signInWithGoogle() {
    const provider = new GoogleAuthProvider();
    await signInWithPopup(auth, provider);
  }

  async function resetPassword(email: string) {
    await sendPasswordResetEmail(auth, email);
  }

  async function signOutUser() {
    await signOut(auth);
  }

  return (
    <AuthContext.Provider
      value={{ user, userDoc, loading, signUpWithEmail, signInWithEmail, signInWithGoogle, resetPassword, signOutUser, refreshUserDoc }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth måste användas inom en <AuthProvider>");
  return ctx;
}
