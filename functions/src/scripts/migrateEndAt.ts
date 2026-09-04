/**
 * migrateEndAt.ts
 * ----------------
 * Engångsmigrering: sätter explicit endAt på befintliga shiftRequests
 * (status pending/approved) som saknar det.
 *
 * VARFÖR: enkeldagsändringar sparades tidigare UTAN endAt.
 * findOverlappingApproved (functions/src/index.ts) och isInstantWithinShift
 * (lib/handoffPreview.ts, components/CalendarView.tsx) tolkar saknat endAt
 * som "pågår i all evighet" — så ett enda godkänt öppet byte blockerade
 * varje senare datum för barnet. Se calendarActions.ts submitShiftChange
 * för den permanenta fixen (endAt är nu obligatoriskt vid skrivning).
 *
 * BALANS-NEUTRAL: dayBalance.ts (calculateShiftDeltaDays) använde redan
 * getNextOrdinaryHandoff som fallback för saknat endAt, så ställningen
 * (dayBalance.balanceDays) är redan korrekt. Den här migreringen gör
 * bara den lagrade datan entydig — den rör INTE dayBalance-dokumenten.
 *
 * Batch-dokument (delar en batchId) har redan endAt satt av klienten och
 * hoppas därför automatiskt över (samma "sakna endAt"-filter).
 *
 * KÖRNING (från functions/):
 *   npm run build
 *   GOOGLE_APPLICATION_CREDENTIALS=/sökväg/till/nyckel.json node lib/functions/src/scripts/migrateEndAt.js
 *
 * Steg 1 — inventering (read-only, standard):
 *   ...migrateEndAt.js
 * Steg 2 — skriv på riktigt, efter att du granskat listan från steg 1:
 *   ...migrateEndAt.js --apply
 */

import * as admin from "firebase-admin";
import { getNextOrdinaryHandoff } from "../../../lib/custodyCycle";
import { CustodyCycleDoc, ShiftRequestDoc } from "../../../types/schema";

admin.initializeApp();
const db = admin.firestore();

const APPLY = process.argv.includes("--apply");
const MAX_OPS_PER_BATCH = 400; // Firestore-gränsen är 500 skrivningar/batch

function toDate(ts: { seconds: number; nanoseconds: number }): Date {
  return new Date(ts.seconds * 1000 + Math.round(ts.nanoseconds / 1e6));
}

async function main() {
  const teamsSnap = await db.collection("teams").get();
  console.log(`Hittade ${teamsSnap.size} team.\n`);

  const cycleCache = new Map<string, CustodyCycleDoc | null>();

  async function getCycle(teamId: string, childId: string): Promise<CustodyCycleDoc | null> {
    const key = `${teamId}/${childId}`;
    if (cycleCache.has(key)) return cycleCache.get(key)!;
    const snap = await db.doc(`teams/${teamId}/children/${childId}/custodyCycle/main`).get();
    const cycle = snap.exists ? (snap.data() as CustodyCycleDoc) : null;
    cycleCache.set(key, cycle);
    return cycle;
  }

  let candidates = 0;
  let skippedNoCycle = 0;
  let applied = 0;

  const batches: FirebaseFirestore.WriteBatch[] = [];
  let currentBatch = db.batch();
  let opsInBatch = 0;

  for (const teamDoc of teamsSnap.docs) {
    const teamId = teamDoc.id;
    const shiftReqsSnap = await db.collection(`teams/${teamId}/shiftRequests`).get();

    for (const doc of shiftReqsSnap.docs) {
      const data = doc.data() as ShiftRequestDoc;
      if (data.endAt) continue; // redan satt — t.ex. batch-dokument
      if (data.status !== "pending" && data.status !== "approved") continue;

      const cycle = await getCycle(teamId, data.childId);
      if (!cycle) {
        skippedNoCycle++;
        console.warn(
          `  [HOPPAR ÖVER — ingen custodyCycle] team ${teamId} barn ${data.childId} shiftRequest ${doc.id}`
        );
        continue;
      }

      const startAt = toDate(data.startAt as unknown as { seconds: number; nanoseconds: number });
      const endAt = getNextOrdinaryHandoff(cycle, startAt);

      candidates++;
      console.log(
        `team ${teamId} | barn ${data.childId} | ${doc.id} | ${data.status} | ` +
          `start ${startAt.toISOString()} | -> endAt ${endAt.toISOString()} | ` +
          `tar över: ${data.takingOverParentId} | note: ${data.note ?? "(ingen)"}`
      );

      if (APPLY) {
        currentBatch.update(doc.ref, { endAt: admin.firestore.Timestamp.fromDate(endAt) });
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
    console.log(`\nKlart. ${applied} shiftRequest-dokument fick ett explicit endAt.`);
  } else {
    console.log(
      `\nInventering klar (read-only, inget skrevs).\n` +
        `${candidates} kandidater hittade` +
        (skippedNoCycle > 0 ? `, ${skippedNoCycle} hoppade över (saknar custodyCycle)` : "") +
        `.\n\nGranska listan ovan. Kör sedan med --apply för att faktiskt skriva.`
    );
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
