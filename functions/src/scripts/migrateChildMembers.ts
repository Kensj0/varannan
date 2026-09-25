/**
 * migrateChildMembers.ts
 * ----------------------
 * Engångsmigrering: bygger `members`/`memberUids` på befintliga
 * child-dokument utifrån `calendarParentIds()` (child.parentIds med
 * fallback på team.parentIds), rollen sätts alltid till "parent".
 *
 * VARFÖR: se docs/roller-och-medlemskap.md, etapp 1. Reglerna i
 * firestore.rules kollar members/memberUids för childInfo/accounts/
 * dayBalance, men faller tillbaka på calendarMembers()/"parent" när
 * fälten saknas — så INGEN behörighet ändras av att köra den här
 * migreringen. Den gör bara datan explicit, så att etapp 2 (bjud in
 * en anhörig) har något att lägga till en rad i.
 *
 * ADDITIVT, ALDRIG DESTRUKTIVT:
 *   - Rör aldrig parentIds — det förblir sanningen för ställning och
 *     grundschema.
 *   - Hoppar över child-dokument som redan har members (idempotent —
 *     säker att köra flera gånger, t.ex. efter att addChild redan
 *     satt fälten på nya kalendrar).
 *   - Exkluderar PENDING_PARTNER_ID — det är en platshållare i
 *     grundschemat för en förälder som ännu inte anslutit, inte en
 *     riktig medlem.
 *   - Skriver bara till child-dokument som faktiskt har minst en
 *     verklig förälder att lägga till (annars vore memberUids: []
 *     vilseledande — jämför med "kalendern har ingen förälder" vs
 *     "kalendern har inte migrerats än", som är olika saker för
 *     reglernas fallback-logik).
 *
 * KÖRNING (från functions/):
 *   npm run build
 *   GOOGLE_APPLICATION_CREDENTIALS=/sökväg/till/nyckel.json node lib/functions/src/scripts/migrateChildMembers.js
 *
 * Steg 1 — inventering (read-only, standard):
 *   ...migrateChildMembers.js
 * Steg 2 — skriv på riktigt, efter att du granskat listan från steg 1:
 *   ...migrateChildMembers.js --apply
 */

import * as admin from "firebase-admin";
import { calendarParentIds, ChildDoc, PENDING_PARTNER_ID, TeamDoc } from "../../../types/schema";

admin.initializeApp();
const db = admin.firestore();

const APPLY = process.argv.includes("--apply");
const MAX_OPS_PER_BATCH = 400; // Firestore-gränsen är 500 skrivningar/batch

async function main() {
  const teamsSnap = await db.collection("teams").get();
  console.log(`Hittade ${teamsSnap.size} team.\n`);

  let totalScanned = 0;
  let alreadyMigrated = 0;
  let skippedNoParents = 0;
  let candidates = 0;
  let applied = 0;

  const batches: FirebaseFirestore.WriteBatch[] = [];
  let currentBatch = db.batch();
  let opsInBatch = 0;

  for (const teamDoc of teamsSnap.docs) {
    const teamId = teamDoc.id;
    const team = teamDoc.data() as TeamDoc;
    const childrenSnap = await db.collection(`teams/${teamId}/children`).get();
    console.log(`team ${teamId}: ${childrenSnap.size} kalendrar.`);

    for (const doc of childrenSnap.docs) {
      totalScanned++;
      const child = doc.data() as ChildDoc;

      if (child.members && Object.keys(child.members).length > 0) {
        alreadyMigrated++;
        continue; // redan migrerad, eller skapad efter roller fanns (addChild)
      }

      const parentUids = calendarParentIds(child, team).filter((id) => id !== PENDING_PARTNER_ID);
      if (parentUids.length === 0) {
        skippedNoParents++;
        console.warn(
          `  [HOPPAR ÖVER — inga riktiga föräldrar] team ${teamId} barn ${doc.id} (${child.name ?? "namnlös"})`
        );
        continue;
      }

      candidates++;
      console.log(
        `team ${teamId} | barn ${doc.id} (${child.name ?? "namnlös"}) -> members: [${parentUids.join(", ")}]`
      );

      if (APPLY) {
        const now = admin.firestore.FieldValue.serverTimestamp();
        const membersUpdate: Record<string, unknown> = {};
        for (const uid of parentUids) {
          // invitedBy är okänt i efterhand — sätts till uid:t självt
          // snarare än att gissa, så fältet inte pekar fel.
          membersUpdate[`members.${uid}`] = { role: "parent", addedAt: now, invitedBy: uid };
        }
        currentBatch.update(doc.ref, { ...membersUpdate, memberUids: parentUids });
        opsInBatch++;
        applied++;
        if (opsInBatch >= MAX_OPS_PER_BATCH) {
          batches.push(currentBatch);
          currentBatch = db.batch();
          opsInBatch = 0;
        }
      }
    }
  }
  if (opsInBatch > 0) batches.push(currentBatch);

  if (APPLY) {
    for (const batch of batches) await batch.commit();
    console.log(`\nKlart. ${applied} kalendrar fick members/memberUids.`);
  } else {
    console.log(
      `\nInventering klar (read-only, inget skrevs).\n` +
        `${totalScanned} kalendrar skannade totalt: ${alreadyMigrated} redan migrerade, ` +
        `${skippedNoParents} hoppade över (inga riktiga föräldrar — t.ex. bara PENDING_PARTNER_ID).\n` +
        `${candidates} kandidater hittade.\n\n` +
        `Granska listan ovan. Kör sedan med --apply för att faktiskt skriva.`
    );
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
