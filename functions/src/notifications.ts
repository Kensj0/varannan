import * as admin from "firebase-admin";

/**
 * Skickar en push till alla enheter en användare har registrerat
 * (users/{uid}.fcmTokens). Städar tyst bort tokens som Firebase
 * rapporterar som ogiltiga/avregistrerade (t.ex. appen avinstallerad,
 * webbläsardata rensad) — annars växer listan bara och skickandet blir
 * långsammare och långsammare över tid.
 */
/**
 * Skickar en push. Kastar ALDRIG vidare — notiser är sidoeffekter och
 * körs efter att den egentliga handlingen redan committats. Ett fel från
 * FCM (ogiltig token, API-kvot, nätverk) fällde tidigare hela den
 * anropande callablen med "INTERNAL", så användaren fick ett felmeddelande
 * trots att ändringen faktiskt sparats.
 */
export async function sendPushToUser(
  db: admin.firestore.Firestore,
  uid: string,
  notification: { title: string; body: string },
  data?: Record<string, string>
): Promise<void> {
  try {
    await sendPushToUserOrThrow(db, uid, notification, data);
  } catch (err) {
    console.error(`[sendPushToUser] kunde inte skicka till ${uid}:`, err);
  }
}

async function sendPushToUserOrThrow(
  db: admin.firestore.Firestore,
  uid: string,
  notification: { title: string; body: string },
  data?: Record<string, string>
): Promise<void> {
  const userSnap = await db.doc(`users/${uid}`).get();
  const tokens: string[] = userSnap.data()?.fcmTokens ?? [];
  if (tokens.length === 0) return;

  const response = await admin.messaging().sendEachForMulticast({
    tokens,
    notification,
    data,
  });

  const deadTokens: string[] = [];
  response.responses.forEach((result, i) => {
    const code = result.error?.code;
    if (code === "messaging/registration-token-not-registered" || code === "messaging/invalid-argument") {
      deadTokens.push(tokens[i]);
    }
  });
  if (deadTokens.length > 0) {
    await db.doc(`users/${uid}`).update({
      fcmTokens: admin.firestore.FieldValue.arrayRemove(...deadTokens),
    });
  }
}

/** Skickar samma push till flera användare parallellt. */
export async function sendPushToUsers(
  db: admin.firestore.Firestore,
  uids: string[],
  notification: { title: string; body: string },
  data?: Record<string, string>
): Promise<void> {
  await Promise.all(uids.map((uid) => sendPushToUser(db, uid, notification, data)));
}
