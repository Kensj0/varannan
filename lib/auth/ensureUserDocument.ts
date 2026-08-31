import { doc, getDoc, setDoc, serverTimestamp } from "firebase/firestore";
import { User } from "firebase/auth";
import { db } from "../firebase";
import { UserDoc } from "../../types/schema";

/**
 * Körs direkt efter lyckad inloggning/registrering. Skapar users/{uid}
 * om det inte redan finns. teamId lämnas null tills AuthGate ser att
 * det saknas och skickar användaren till onboarding-flödet.
 *
 * Tillåtet av firestore.rules (allow create: if request.auth.uid == uid) —
 * ingen Cloud Function behövs för det här steget.
 */
export async function ensureUserDocument(user: User): Promise<UserDoc> {
  const ref = doc(db, "users", user.uid);
  const snap = await getDoc(ref);

  if (snap.exists()) {
    return snap.data() as UserDoc;
  }

  const newUser: Omit<UserDoc, "teamId"> & { teamId: null } = {
    uid: user.uid,
    displayName: user.displayName ?? user.email?.split("@")[0] ?? "Förälder",
    email: user.email ?? "",
    teamId: null,
    createdAt: serverTimestamp() as any,
    // Firestores webb-SDK kastar fel på `undefined`-fält, så avatarUrl
    // inkluderas bara när användaren faktiskt har en profilbild (t.ex.
    // saknas photoURL vid e-post/lösenord-inloggning).
    ...(user.photoURL ? { avatarUrl: user.photoURL } : {}),
  };

  await setDoc(ref, newUser);
  return newUser as unknown as UserDoc;
}