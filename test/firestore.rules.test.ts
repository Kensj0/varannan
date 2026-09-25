/**
 * firestore.rules.test.ts
 * -----------------------
 * Regeltester för roller (docs/roller-och-medlemskap.md, etapp 1).
 * Körs mot Firestore-emulatorn, ALDRIG mot produktion. Samma enkla
 * stil som test/correctness.ts (ingen testrunner, bara ett script).
 *
 * Testar tre saker för varje ändrad regel:
 *   1. Bakåtkompatibilitet — en kalender UTAN members/memberUids
 *      (som idag i produktion) beter sig precis som innan roll-
 *      ändringarna: föräldrarna i parentIds har full åtkomst.
 *   2. En anhörig (relative) — som ännu inte kan skapas i produktion
 *      (inbjudningsflödet är etapp 2), men vars roll ändå måste
 *      spärras korrekt så snart migreringen/etapp 2 lägger till en.
 *   3. Att children/{childId} aldrig går att skriva till direkt från
 *      klienten, oavsett roll — bara Cloud Functions (admin SDK,
 *      kringgår dessa regler helt) får sätta members/memberUids.
 *
 * KÖRNING:
 *   Terminal 1: firebase emulators:start --only firestore
 *   Terminal 2: npm run test:rules
 *
 *   (eller allt i ett: firebase emulators:exec --only firestore "npm run test:rules")
 *
 * Om ett test failar: LÄS FELET INNAN DU ÄNDRAR REGLERNA FÖR ATT FÅ
 * GRÖNT. Ett test som failar för att en anhörig FÅR åtkomst den inte
 * ska ha är precis den bugg reglerna finns för att förhindra.
 */

import * as fs from "fs";
import * as path from "path";
import {
  initializeTestEnvironment,
  assertSucceeds,
  assertFails,
  RulesTestEnvironment,
} from "@firebase/rules-unit-testing";
import { doc, getDoc, updateDoc } from "firebase/firestore";

const PROJECT_ID = "varannan-rules-test";
const RULES_PATH = path.resolve(process.cwd(), "firestore.rules");

const TEAM_A = "teamA";
const CHILD_A = "childA";
const PARENT_1 = "parent1";
const PARENT_2 = "parent2";
const RELATIVE = "relative1";
const VIEWER = "viewer1";
const OUTSIDER = "outsider1";

const TEAM_LEGACY = "teamLegacy";
const CHILD_LEGACY = "childLegacy"; // saknar members/memberUids helt — dagens produktionsform
const LEGACY_PARENT_1 = "legacyParent1";
const LEGACY_PARENT_2 = "legacyParent2";

let passed = 0;
let failed = 0;

async function check(label: string, run: () => Promise<unknown>, shouldSucceed: boolean) {
  const assertion = shouldSucceed ? assertSucceeds(run()) : assertFails(run());
  try {
    await assertion;
    passed++;
    console.log(`  ✓ ${label}`);
  } catch (err) {
    failed++;
    console.log(`  ✗ ${label}`);
    console.log(`      förväntat: ${shouldSucceed ? "tillåtet" : "nekat"}, men blev tvärtom`);
    console.log(`      ${(err as Error).message?.split("\n")[0] ?? err}`);
  }
}

async function seed(testEnv: RulesTestEnvironment) {
  await testEnv.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();
    const ts = { seconds: 0, nanoseconds: 0 };

    // --- Familj A: fullt migrerad, med roller ---
    await db.doc(`teams/${TEAM_A}`).set({
      id: TEAM_A,
      parentIds: [PARENT_1, PARENT_2],
      createdAt: ts,
    });
    await db.doc(`teams/${TEAM_A}/children/${CHILD_A}`).set({
      id: CHILD_A,
      teamId: TEAM_A,
      name: "Testbarnet",
      parentIds: [PARENT_1, PARENT_2],
      members: {
        [PARENT_1]: { role: "parent", addedAt: ts, invitedBy: PARENT_1 },
        [PARENT_2]: { role: "parent", addedAt: ts, invitedBy: PARENT_1 },
        [RELATIVE]: { role: "relative", addedAt: ts, invitedBy: PARENT_1 },
        [VIEWER]: { role: "viewer", addedAt: ts, invitedBy: PARENT_1 },
      },
      memberUids: [PARENT_1, PARENT_2, RELATIVE, VIEWER],
      createdAt: ts,
    });
    await db.doc(`teams/${TEAM_A}/children/${CHILD_A}/childInfo/main`).set({ personnummer: "hemligt" });
    await db.doc(`teams/${TEAM_A}/children/${CHILD_A}/dayBalance/main`).set({
      childId: CHILD_A,
      balanceDays: 0,
      referenceParentId: PARENT_1,
      updatedAt: ts,
    });
    await db.doc(`teams/${TEAM_A}/children/${CHILD_A}/custodyCycle/main`).set({ switchHour: "12:00" });

    // Bara PARENT_1/PARENT_2 har users.teamId == TEAM_A. Anhörigen och
    // den utomstående hör "hemma" i andra team (eller inget alls) —
    // exakt som en mormor med barnbarn i flera familjer.
    await db.doc(`users/${PARENT_1}`).set({ teamId: TEAM_A });
    await db.doc(`users/${PARENT_2}`).set({ teamId: TEAM_A });
    await db.doc(`users/${RELATIVE}`).set({ teamId: "teamRelativesOwn" });
    await db.doc(`users/${VIEWER}`).set({ teamId: null });

    // --- Familj "Legacy": ingen migrering körd, exakt dagens produktionsform ---
    await db.doc(`teams/${TEAM_LEGACY}`).set({
      id: TEAM_LEGACY,
      parentIds: [LEGACY_PARENT_1, LEGACY_PARENT_2],
      createdAt: ts,
    });
    await db.doc(`teams/${TEAM_LEGACY}/children/${CHILD_LEGACY}`).set({
      id: CHILD_LEGACY,
      teamId: TEAM_LEGACY,
      name: "Gammalt barn",
      parentIds: [LEGACY_PARENT_1, LEGACY_PARENT_2],
      // OBS: inget members/memberUids-fält alls.
      createdAt: ts,
    });
    await db
      .doc(`teams/${TEAM_LEGACY}/children/${CHILD_LEGACY}/childInfo/main`)
      .set({ personnummer: "hemligt-legacy" });
    await db.doc(`users/${LEGACY_PARENT_1}`).set({ teamId: TEAM_LEGACY });
    await db.doc(`users/${LEGACY_PARENT_2}`).set({ teamId: TEAM_LEGACY });
  });
}

async function main() {
  const testEnv = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: { rules: fs.readFileSync(RULES_PATH, "utf8") },
  });
  await testEnv.clearFirestore();
  await seed(testEnv);

  const dbAs = (uid: string) => testEnv.authenticatedContext(uid).firestore();

  console.log("childInfo — bara föräldrar, aldrig anhörig/utomstående");
  await check(
    "förälder i members kan läsa",
    () => getDoc(doc(dbAs(PARENT_1), `teams/${TEAM_A}/children/${CHILD_A}/childInfo/main`)),
    true
  );
  await check(
    "anhörig (relative) kan INTE läsa",
    () => getDoc(doc(dbAs(RELATIVE), `teams/${TEAM_A}/children/${CHILD_A}/childInfo/main`)),
    false
  );
  await check(
    "utomstående (viewer) kan INTE läsa",
    () => getDoc(doc(dbAs(VIEWER), `teams/${TEAM_A}/children/${CHILD_A}/childInfo/main`)),
    false
  );
  await check(
    "helt obesläktad person kan INTE läsa",
    () => getDoc(doc(dbAs(OUTSIDER), `teams/${TEAM_A}/children/${CHILD_A}/childInfo/main`)),
    false
  );
  await check(
    "BAKÅTKOMPATIBELT: förälder på en icke-migrerad (legacy) kalender kan fortfarande läsa",
    () => getDoc(doc(dbAs(LEGACY_PARENT_1), `teams/${TEAM_LEGACY}/children/${CHILD_LEGACY}/childInfo/main`)),
    true
  );

  console.log("\ndayBalance — bara föräldrar");
  await check(
    "förälder kan läsa ställningen",
    () => getDoc(doc(dbAs(PARENT_2), `teams/${TEAM_A}/children/${CHILD_A}/dayBalance/main`)),
    true
  );
  await check(
    "anhörig kan INTE läsa ställningen",
    () => getDoc(doc(dbAs(RELATIVE), `teams/${TEAM_A}/children/${CHILD_A}/dayBalance/main`)),
    false
  );
  await check(
    "ingen — inte ens en förälder — kan skriva direkt (bara callables)",
    () => updateDoc(doc(dbAs(PARENT_1), `teams/${TEAM_A}/children/${CHILD_A}/dayBalance/main`), { balanceDays: 999 }),
    false
  );

  console.log("\nchildren/{childId} — läsning ja, skrivning aldrig från klienten");
  await check(
    "förälder (via isTeamMember) kan läsa barn-dokumentet",
    () => getDoc(doc(dbAs(PARENT_1), `teams/${TEAM_A}/children/${CHILD_A}`)),
    true
  );
  await check(
    "anhörig utan users.teamId == TEAM_A kan ändå läsa, via kalendermedlemskap",
    () => getDoc(doc(dbAs(RELATIVE), `teams/${TEAM_A}/children/${CHILD_A}`)),
    true
  );
  await check(
    "obesläktad person kan INTE läsa",
    () => getDoc(doc(dbAs(OUTSIDER), `teams/${TEAM_A}/children/${CHILD_A}`)),
    false
  );
  await check(
    "KRITISKT: en anhörig kan INTE ge sig själv rollen parent genom att skriva members direkt",
    () =>
      updateDoc(doc(dbAs(RELATIVE), `teams/${TEAM_A}/children/${CHILD_A}`), {
        [`members.${RELATIVE}.role`]: "parent",
      }),
    false
  );
  await check(
    "KRITISKT: inte ens en riktig förälder kan skriva till barn-dokumentet direkt",
    () => updateDoc(doc(dbAs(PARENT_1), `teams/${TEAM_A}/children/${CHILD_A}`), { name: "Nytt namn" }),
    false
  );

  console.log("\ncustodyCycle — synlig för parent och relative, inte helt obesläktad");
  await check(
    "anhörig kan läsa grundschemat (för att se kalendern)",
    () => getDoc(doc(dbAs(RELATIVE), `teams/${TEAM_A}/children/${CHILD_A}/custodyCycle/main`)),
    true
  );
  await check(
    "obesläktad person kan INTE läsa grundschemat",
    () => getDoc(doc(dbAs(OUTSIDER), `teams/${TEAM_A}/children/${CHILD_A}/custodyCycle/main`)),
    false
  );

  console.log("\ncross-familj — en anhörig i familj A kommer inte åt familj Legacy");
  await check(
    "relative1 (bara medlem i familj A) kan INTE läsa familj Legacys childInfo",
    () => getDoc(doc(dbAs(RELATIVE), `teams/${TEAM_LEGACY}/children/${CHILD_LEGACY}/childInfo/main`)),
    false
  );

  await testEnv.cleanup();

  console.log(`\n${passed} godkända, ${failed} misslyckade.`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
