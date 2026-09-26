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
import {
  doc,
  documentId,
  getDoc,
  getDocs,
  setDoc,
  updateDoc,
  deleteDoc,
  collection,
  query,
  where,
  orderBy,
} from "firebase/firestore";

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

    // --- events/packLists/notes/todos/shiftRequests/scheduleStructureRequests/
    //     chatMessages/teamInvites — etapp 2 ---
    await db.doc(`teams/${TEAM_A}/events/eventFamilyWide`).set({
      id: "eventFamilyWide",
      teamId: TEAM_A,
      title: "Familjemiddag",
      // childId SAKNAS avsiktligt — familje-gemensam aktivitet.
      startAt: ts,
      endAt: ts,
      createdBy: PARENT_1,
      createdAt: ts,
    });
    await db.doc(`teams/${TEAM_A}/events/eventByParent`).set({
      id: "eventByParent",
      teamId: TEAM_A,
      childId: CHILD_A,
      title: "Tandläkare",
      startAt: ts,
      endAt: ts,
      createdBy: PARENT_1,
      createdAt: ts,
    });
    await db.doc(`teams/${TEAM_A}/events/eventByRelative1`).set({
      id: "eventByRelative1",
      teamId: TEAM_A,
      childId: CHILD_A,
      title: "Hos mormor",
      startAt: ts,
      endAt: ts,
      createdBy: RELATIVE,
      createdAt: ts,
    });
    await db.doc(`teams/${TEAM_A}/events/eventByRelative2`).set({
      id: "eventByRelative2",
      teamId: TEAM_A,
      childId: CHILD_A,
      title: "Hos mormor igen",
      startAt: ts,
      endAt: ts,
      createdBy: RELATIVE,
      createdAt: ts,
    });

    await db.doc(`teams/${TEAM_A}/packLists/packListA`).set({
      id: "packListA",
      teamId: TEAM_A,
      childId: CHILD_A,
      title: "Packlista",
      items: [],
    });

    await db.doc(`teams/${TEAM_A}/notes/noteOnChild`).set({
      id: "noteOnChild",
      teamId: TEAM_A,
      childId: CHILD_A,
      text: "Kom ihåg solkräm",
      createdBy: PARENT_1,
      createdAt: ts,
    });
    await db.doc(`teams/${TEAM_A}/notes/noteFamilyWide`).set({
      id: "noteFamilyWide",
      teamId: TEAM_A,
      // childId saknas — familje-gemensam anteckning.
      text: "Städdag på lördag",
      createdBy: PARENT_1,
      createdAt: ts,
    });

    await db.doc(`teams/${TEAM_A}/todos/todoOnChild`).set({
      id: "todoOnChild",
      teamId: TEAM_A,
      childId: CHILD_A,
      text: "Boka tandläkartid",
      done: false,
      createdBy: PARENT_1,
      createdAt: ts,
    });

    await db.doc(`teams/${TEAM_A}/shiftRequests/shiftA`).set({
      id: "shiftA",
      teamId: TEAM_A,
      childId: CHILD_A,
      requestedBy: PARENT_1,
      takingOverParentId: PARENT_2,
      startAt: ts,
      status: "pending",
      createdAt: ts,
    });

    await db.doc(`teams/${TEAM_A}/scheduleStructureRequests/structA`).set({
      id: "structA",
      teamId: TEAM_A,
      childId: CHILD_A,
      requestedBy: PARENT_1,
      addressedTo: PARENT_2,
      kind: "switchHour",
      payload: {},
      summary: "bytestid 08:00 → 18:00",
      status: "pending",
      createdAt: ts,
    });

    await db.doc(`teams/${TEAM_A}/chatMessages/chatA`).set({
      id: "chatA",
      teamId: TEAM_A,
      childId: CHILD_A,
      senderId: PARENT_1,
      text: "Hej!",
      createdAt: ts,
    });

    await db.doc(`teamInvites/PENDING-INVIT`).set({
      code: "PENDING-INVIT",
      teamId: TEAM_A,
      childId: CHILD_A,
      role: "relative",
      invitedEmail: "anhorig@example.com",
      invitedBy: PARENT_1,
      used: false,
      status: "pending_approval",
      requiredApprovers: [PARENT_1, PARENT_2],
      approvedBy: [PARENT_1],
      expiresAt: ts,
      createdAt: ts,
    });

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

  console.log(
    "childInfo — parent+relative läser (Kenny 2026-09-26: \"det ska anhörig ha\"), " +
      "bara parent skriver, viewer aldrig"
  );
  await check(
    "förälder i members kan läsa",
    () => getDoc(doc(dbAs(PARENT_1), `teams/${TEAM_A}/children/${CHILD_A}/childInfo/main`)),
    true
  );
  await check(
    "anhörig (relative) KAN läsa",
    () => getDoc(doc(dbAs(RELATIVE), `teams/${TEAM_A}/children/${CHILD_A}/childInfo/main`)),
    true
  );
  await check(
    "anhörig (relative) kan INTE skriva",
    () =>
      updateDoc(doc(dbAs(RELATIVE), `teams/${TEAM_A}/children/${CHILD_A}/childInfo/main`), {
        personnummer: "fusk",
      }),
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
  await check(
    "en anhörig kan INTE lista HELA children-kollektionen ofiltrerat (useChildren i app/page.tsx " +
      "gör exakt detta — Firestore kan inte bevisa att ALLA dokument i kollektionen uppfyller " +
      "regeln utan en matchande where(), så hela frågan nekas, den filtreras INTE per dokument)",
    () => getDocs(collection(dbAs(RELATIVE), `teams/${TEAM_A}/children`)),
    false
  );
  await check(
    "förälder (via isTeamMember) kan lista HELA children-kollektionen",
    () => getDocs(collection(dbAs(PARENT_1), `teams/${TEAM_A}/children`)),
    true
  );
  await check(
    "en anhörig KAN lista children-kollektionen filtrerad på where(documentId(),'in',[egna id:n]) " +
      "— fixen för buggen ovan (useChildrenByIds i lib/hooks/useFirestore.ts)",
    () =>
      getDocs(
        query(collection(dbAs(RELATIVE), `teams/${TEAM_A}/children`), where(documentId(), "in", [CHILD_A]))
      ),
    true
  );

  console.log("\ncustodyCycle — synlig för ALLA tre roller (\"Se schema och aktiviteter\": ja/ja/ja)");
  await check(
    "anhörig kan läsa grundschemat (för att se kalendern)",
    () => getDoc(doc(dbAs(RELATIVE), `teams/${TEAM_A}/children/${CHILD_A}/custodyCycle/main`)),
    true
  );
  await check(
    "utomstående (viewer) kan OCKSÅ läsa grundschemat",
    () => getDoc(doc(dbAs(VIEWER), `teams/${TEAM_A}/children/${CHILD_A}/custodyCycle/main`)),
    true
  );
  await check(
    "obesläktad person kan INTE läsa grundschemat",
    () => getDoc(doc(dbAs(OUTSIDER), `teams/${TEAM_A}/children/${CHILD_A}/custodyCycle/main`)),
    false
  );

  console.log("\nevents — familje-gemensamt (utan childId) kvar på parent-bara, kalenderscopat öppet för relative/viewer");
  await check(
    "anhörig kan läsa en aktivitet knuten till kalendern",
    () => getDoc(doc(dbAs(RELATIVE), `teams/${TEAM_A}/events/eventByParent`)),
    true
  );
  await check(
    "utomstående kan läsa en aktivitet knuten till kalendern",
    () => getDoc(doc(dbAs(VIEWER), `teams/${TEAM_A}/events/eventByParent`)),
    true
  );
  await check(
    "anhörig kan INTE läsa en familje-gemensam aktivitet (utan childId)",
    () => getDoc(doc(dbAs(RELATIVE), `teams/${TEAM_A}/events/eventFamilyWide`)),
    false
  );
  await check(
    "obesläktad person kan INTE läsa kalenderns aktivitet",
    () => getDoc(doc(dbAs(OUTSIDER), `teams/${TEAM_A}/events/eventByParent`)),
    false
  );
  await check(
    "anhörig kan lägga in en ny aktivitet på kalendern",
    () =>
      setDoc(doc(dbAs(RELATIVE), `teams/${TEAM_A}/events/eventByRelativeNew`), {
        id: "eventByRelativeNew",
        teamId: TEAM_A,
        childId: CHILD_A,
        title: "Fotbollsträning",
        startAt: { seconds: 0, nanoseconds: 0 },
        endAt: { seconds: 0, nanoseconds: 0 },
        createdBy: RELATIVE,
        createdAt: { seconds: 0, nanoseconds: 0 },
      }),
    true
  );
  await check(
    "utomstående kan INTE lägga in en aktivitet",
    () =>
      setDoc(doc(dbAs(VIEWER), `teams/${TEAM_A}/events/eventByViewerNew`), {
        id: "eventByViewerNew",
        teamId: TEAM_A,
        childId: CHILD_A,
        title: "Ska inte gå igenom",
        startAt: { seconds: 0, nanoseconds: 0 },
        endAt: { seconds: 0, nanoseconds: 0 },
        createdBy: VIEWER,
        createdAt: { seconds: 0, nanoseconds: 0 },
      }),
    false
  );
  await check(
    "anhörig kan ta bort SIN EGEN aktivitet",
    () => deleteDoc(doc(dbAs(RELATIVE), `teams/${TEAM_A}/events/eventByRelative1`)),
    true
  );
  await check(
    "anhörig kan INTE ta bort förälderns aktivitet",
    () => deleteDoc(doc(dbAs(RELATIVE), `teams/${TEAM_A}/events/eventByParent`)),
    false
  );
  await check(
    "förälder kan ta bort VILKEN aktivitet som helst (inklusive anhörigs)",
    () => deleteDoc(doc(dbAs(PARENT_1), `teams/${TEAM_A}/events/eventByRelative2`)),
    true
  );

  console.log(
    "\nlistfrågor — en OFILTRERAD lista över hela kollektionen nekas för en anhörig " +
      "(useNotes/useTodos/useEventsForMonth default-läge), en where(childId==)-filtrerad " +
      "fungerar (strict-läget de hookarna nu har, används av app/page.tsx för en aktiv " +
      "kalender man är anhörig/utomstående på)"
  );
  await check(
    "anhörig: OFILTRERAD notes-lista (hela teamet) nekas i sin helhet",
    () => getDocs(query(collection(dbAs(RELATIVE), `teams/${TEAM_A}/notes`), orderBy("updatedAt", "desc"))),
    false
  );
  await check(
    "anhörig: where(childId==)-filtrerad notes-lista fungerar",
    () =>
      getDocs(
        query(
          collection(dbAs(RELATIVE), `teams/${TEAM_A}/notes`),
          where("childId", "==", CHILD_A),
          orderBy("updatedAt", "desc")
        )
      ),
    true
  );
  await check(
    "anhörig: OFILTRERAD todos-lista (hela teamet) nekas i sin helhet",
    () =>
      getDocs(
        query(
          collection(dbAs(RELATIVE), `teams/${TEAM_A}/todos`),
          where("archived", "==", false),
          orderBy("createdAt", "desc")
        )
      ),
    false
  );
  await check(
    "anhörig: where(childId==)-filtrerad todos-lista fungerar",
    () =>
      getDocs(
        query(
          collection(dbAs(RELATIVE), `teams/${TEAM_A}/todos`),
          where("childId", "==", CHILD_A),
          where("archived", "==", false),
          orderBy("createdAt", "desc")
        )
      ),
    true
  );
  await check(
    "anhörig: OFILTRERAD events-lista (hela teamet, en månad) nekas i sin helhet",
    () =>
      getDocs(
        query(
          collection(dbAs(RELATIVE), `teams/${TEAM_A}/events`),
          where("startAt", ">=", { seconds: -1, nanoseconds: 0 }),
          where("startAt", "<", { seconds: 1, nanoseconds: 0 }),
          orderBy("startAt", "asc")
        )
      ),
    false
  );
  await check(
    "anhörig: where(childId==)-filtrerad events-lista fungerar",
    () =>
      getDocs(
        query(
          collection(dbAs(RELATIVE), `teams/${TEAM_A}/events`),
          where("childId", "==", CHILD_A),
          where("startAt", ">=", { seconds: -1, nanoseconds: 0 }),
          where("startAt", "<", { seconds: 1, nanoseconds: 0 }),
          orderBy("startAt", "asc")
        )
      ),
    true
  );

  console.log("\npackLists/notes/todos — parent och relative fullt, viewer inget alls");
  await check(
    "anhörig kan läsa packlistan",
    () => getDoc(doc(dbAs(RELATIVE), `teams/${TEAM_A}/packLists/packListA`)),
    true
  );
  await check(
    "utomstående kan INTE läsa packlistan",
    () => getDoc(doc(dbAs(VIEWER), `teams/${TEAM_A}/packLists/packListA`)),
    false
  );
  await check(
    "anhörig kan skriva i packlistan",
    () => updateDoc(doc(dbAs(RELATIVE), `teams/${TEAM_A}/packLists/packListA`), { title: "Uppdaterad packlista" }),
    true
  );
  await check(
    "anhörig kan läsa en anteckning knuten till kalendern",
    () => getDoc(doc(dbAs(RELATIVE), `teams/${TEAM_A}/notes/noteOnChild`)),
    true
  );
  await check(
    "anhörig kan INTE läsa en familje-gemensam anteckning (utan childId)",
    () => getDoc(doc(dbAs(RELATIVE), `teams/${TEAM_A}/notes/noteFamilyWide`)),
    false
  );
  await check(
    "utomstående kan INTE läsa en anteckning",
    () => getDoc(doc(dbAs(VIEWER), `teams/${TEAM_A}/notes/noteOnChild`)),
    false
  );
  await check(
    "anhörig kan läsa en todo knuten till kalendern",
    () => getDoc(doc(dbAs(RELATIVE), `teams/${TEAM_A}/todos/todoOnChild`)),
    true
  );
  await check(
    "utomstående kan INTE läsa en todo",
    () => getDoc(doc(dbAs(VIEWER), `teams/${TEAM_A}/todos/todoOnChild`)),
    false
  );

  console.log("\nshiftRequests — läsning för alla tre roller, skapande för parent+relative");
  await check(
    "anhörig kan läsa ett väntande byte",
    () => getDoc(doc(dbAs(RELATIVE), `teams/${TEAM_A}/shiftRequests/shiftA`)),
    true
  );
  await check(
    "utomstående kan OCKSÅ läsa ett väntande byte (del av schemat)",
    () => getDoc(doc(dbAs(VIEWER), `teams/${TEAM_A}/shiftRequests/shiftA`)),
    true
  );
  await check(
    "anhörig kan föreslå ett byte",
    () =>
      setDoc(doc(dbAs(RELATIVE), `teams/${TEAM_A}/shiftRequests/shiftByRelative`), {
        id: "shiftByRelative",
        teamId: TEAM_A,
        childId: CHILD_A,
        requestedBy: RELATIVE,
        takingOverParentId: PARENT_1,
        startAt: { seconds: 0, nanoseconds: 0 },
        status: "pending",
        createdAt: { seconds: 0, nanoseconds: 0 },
      }),
    true
  );
  await check(
    "utomstående kan INTE föreslå ett byte",
    () =>
      setDoc(doc(dbAs(VIEWER), `teams/${TEAM_A}/shiftRequests/shiftByViewer`), {
        id: "shiftByViewer",
        teamId: TEAM_A,
        childId: CHILD_A,
        requestedBy: VIEWER,
        takingOverParentId: PARENT_1,
        startAt: { seconds: 0, nanoseconds: 0 },
        status: "pending",
        createdAt: { seconds: 0, nanoseconds: 0 },
      }),
    false
  );

  console.log("\nscheduleStructureRequests — läsning breddad till relative, skrivning fortsatt bara callables");
  await check(
    "anhörig kan läsa ett väntande schemaförslag",
    () => getDoc(doc(dbAs(RELATIVE), `teams/${TEAM_A}/scheduleStructureRequests/structA`)),
    true
  );
  await check(
    "utomstående kan INTE läsa ett väntande schemaförslag",
    () => getDoc(doc(dbAs(VIEWER), `teams/${TEAM_A}/scheduleStructureRequests/structA`)),
    false
  );

  console.log("\nchatMessages — REGRESSION: fortsatt stängt för relative/viewer trots breddningen ovan");
  await check(
    "anhörig kan INTE läsa chatten",
    () => getDoc(doc(dbAs(RELATIVE), `teams/${TEAM_A}/chatMessages/chatA`)),
    false
  );
  await check(
    "utomstående kan INTE läsa chatten",
    () => getDoc(doc(dbAs(VIEWER), `teams/${TEAM_A}/chatMessages/chatA`)),
    false
  );
  await check(
    "förälder kan läsa chatten som förut",
    () => getDoc(doc(dbAs(PARENT_1), `teams/${TEAM_A}/chatMessages/chatA`)),
    true
  );

  console.log("\nteamInvites — get på känd kod öppet, list begränsad till kalenderns föräldrar");
  await check(
    "vem som helst inloggad kan slå upp en KÄND kod (join-sidan)",
    () => getDoc(doc(dbAs(OUTSIDER), `teamInvites/PENDING-INVIT`)),
    true
  );
  await check(
    "förälder kan LISTA väntande inbjudningar för sitt eget team",
    () =>
      getDocs(query(collection(dbAs(PARENT_2), "teamInvites"), where("teamId", "==", TEAM_A))),
    true
  );
  await check(
    "obesläktad person kan INTE lista inbjudningar för familj A",
    () =>
      getDocs(query(collection(dbAs(OUTSIDER), "teamInvites"), where("teamId", "==", TEAM_A))),
    false
  );
  await check(
    "anhörig (users.teamId pekar på ETT ANNAT team) kan INTE lista familj A:s inbjudningar",
    () =>
      getDocs(query(collection(dbAs(RELATIVE), "teamInvites"), where("teamId", "==", TEAM_A))),
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
