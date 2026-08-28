/**
 * Firestore-latensbenchmark — körs mot den LOKALA EMULATORN.
 *
 *   Terminal 1:  npm run emulators
 *   Terminal 2:  npm run bench:firestore
 *
 * VIKTIGT om vad siffrorna betyder:
 * Emulatorn kör över loopback och har ingen replikering. Den mäter alltså
 * antalet round trips och hur mycket data som flyttas — INTE verklig
 * nätverkslatens. Mot produktion (europe-north1 från en svensk mobil)
 * ligger en round trip typiskt på 30–150 ms istället för <1 ms.
 *
 * Det gör mätningen användbar ändå: den avslöjar N+1-problem och onödiga
 * round trips, som är exakt det som gör ont på riktigt nät. Multiplicera
 * antalet operationer med din verkliga RTT för en produktionsuppskattning.
 */

import { initializeApp, deleteApp } from "firebase/app";
import { getFirestore, connectFirestoreEmulator, collection, doc, setDoc, getDocs, getDoc, onSnapshot, query, where, orderBy, writeBatch, Timestamp, Firestore } from "firebase/firestore";

const PROJECT_ID = "varannan-bench";
const TEAM_ID = "bench-team";
const CHILD_ID = "bench-child";
const UID_A = "parentA";
const UID_B = "parentB";

function measure(label: string, ms: number, ops?: number) {
  const opsNote = ops ? `  (${ops} operationer → ~${(ops * 60).toLocaleString("sv-SE")} ms vid 60 ms RTT)` : "";
  console.log(`${label.padEnd(50)} ${ms.toFixed(1).padStart(8)} ms${opsNote}`);
}

async function time<T>(fn: () => Promise<T>): Promise<[T, number]> {
  const start = process.hrtime.bigint();
  const result = await fn();
  const end = process.hrtime.bigint();
  return [result, Number(end - start) / 1e6];
}

/** Väntar på första snapshot-callbacken och mäter tiden dit. */
function timeFirstSnapshot(q: any): Promise<{ ms: number; count: number }> {
  return new Promise((resolve, reject) => {
    const start = process.hrtime.bigint();
    const unsub = onSnapshot(
      q,
      (snap: any) => {
        const ms = Number(process.hrtime.bigint() - start) / 1e6;
        unsub();
        resolve({ ms, count: snap.size ?? (snap.exists?.() ? 1 : 0) });
      },
      reject
    );
  });
}

async function seed(db: Firestore, opts: { events: number; messages: number; todos: number }) {
  // Batch-skrivning: 500 dokument per batch är Firestores gräns.
  let batch = writeBatch(db);
  let pending = 0;

  async function flush() {
    if (pending > 0) {
      await batch.commit();
      batch = writeBatch(db);
      pending = 0;
    }
  }

  async function add(path: string, data: any) {
    batch.set(doc(db, path), data);
    if (++pending >= 400) await flush();
  }

  await add(`teams/${TEAM_ID}`, {
    id: TEAM_ID,
    name: "Benchfamiljen",
    parentIds: [UID_A, UID_B],
    parentProfiles: {
      [UID_A]: { uid: UID_A, displayName: "Förälder A" },
      [UID_B]: { uid: UID_B, displayName: "Förälder B" },
    },
    childIds: [CHILD_ID],
    createdAt: Timestamp.now(),
    createdBy: UID_A,
  });

  await add(`teams/${TEAM_ID}/children/${CHILD_ID}`, {
    id: CHILD_ID,
    teamId: TEAM_ID,
    name: "Benchbarn",
    createdAt: Timestamp.now(),
  });

  await add(`teams/${TEAM_ID}/children/${CHILD_ID}/custodyCycle/main`, {
    childId: CHILD_ID,
    blocks: [
      { parentId: UID_A, days: 2 },
      { parentId: UID_B, days: 2 },
      { parentId: UID_A, days: 3 },
      { parentId: UID_B, days: 2 },
      { parentId: UID_A, days: 2 },
      { parentId: UID_B, days: 3 },
    ],
    cycleStartDate: Timestamp.fromDate(new Date(2026, 0, 1)),
    switchHour: "12:00",
    timezone: "Europe/Stockholm",
    updatedAt: Timestamp.now(),
    updatedBy: UID_A,
  });

  await add(`teams/${TEAM_ID}/children/${CHILD_ID}/dayBalance/main`, {
    childId: CHILD_ID,
    balanceDays: 0,
    referenceParentId: UID_A,
    updatedAt: Timestamp.now(),
  });

  for (let i = 0; i < opts.events; i++) {
    const start = new Date(2026, 7, (i % 28) + 1, 13, 0);
    await add(`teams/${TEAM_ID}/events/ev${i}`, {
      id: `ev${i}`,
      teamId: TEAM_ID,
      childId: CHILD_ID,
      title: `Aktivitet ${i}`,
      startAt: Timestamp.fromDate(start),
      endAt: Timestamp.fromDate(new Date(start.getTime() + 3600_000)),
      recurrence: i % 10 === 0 ? { frequency: "weekly", interval: 1 } : null,
      createdBy: UID_A,
      createdAt: Timestamp.now(),
    });
  }

  for (let i = 0; i < opts.messages; i++) {
    await add(`teams/${TEAM_ID}/chatMessages/msg${i}`, {
      id: `msg${i}`,
      teamId: TEAM_ID,
      senderId: i % 2 ? UID_A : UID_B,
      text: `Meddelande ${i} med lite realistisk längd på texten.`,
      createdAt: Timestamp.fromDate(new Date(2026, 7, 1 + (i % 27), 10, i % 60)),
    });
  }

  for (let i = 0; i < opts.todos; i++) {
    await add(`teams/${TEAM_ID}/todos/todo${i}`, {
      id: `todo${i}`,
      teamId: TEAM_ID,
      title: `Uppgift ${i}`,
      done: i % 3 === 0,
      archived: false,
      seenBy: [UID_A],
      createdBy: UID_A,
      createdAt: Timestamp.now(),
    });
  }

  await flush();
}

async function main() {
  const app = initializeApp({ projectId: PROJECT_ID }, `bench-${Date.now()}`);
  const db = getFirestore(app);

  try {
    connectFirestoreEmulator(db, "localhost", 8080);
  } catch {
    // Redan ansluten
  }

  // Snabb koll att emulatorn faktiskt svarar. Firestore-SDK:n loggar
  // egna anslutningsfel innan vårt catch hinner köra, så vi dämpar
  // konsolen under just den här kontrollen.
  const originalError = console.error;
  const originalWarn = console.warn;
  console.error = () => {};
  console.warn = () => {};
  try {
    await Promise.race([
      getDoc(doc(db, "teams/__ping__")),
      new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 5000)),
    ]);
  } catch (err) {
    console.error = originalError;
    console.warn = originalWarn;
    console.error("\n  Kunde inte nå Firestore-emulatorn på localhost:8080.");
    console.error("  Starta den i en annan terminal först:\n");
    console.error("      npm run emulators\n");
    process.exit(1);
  }
  console.error = originalError;
  console.warn = originalWarn;

  console.log("\nSeedar testdata i emulatorn…");
  const [, seedMs] = await time(() => seed(db, { events: 200, messages: 300, todos: 50 }));
  console.log(`Klart på ${seedMs.toFixed(0)} ms\n`);

  console.log("=".repeat(78));
  console.log("  FIRESTORE-LATENS (emulator — mäter round trips, inte nätverk)");
  console.log("=".repeat(78) + "\n");

  console.log("--- Kallstart: vad som laddas när appen öppnas ---\n");

  const teamSnap = await timeFirstSnapshot(doc(db, `teams/${TEAM_ID}`));
  measure("useTeam (1 dokument)", teamSnap.ms, 1);

  const childrenSnap = await timeFirstSnapshot(collection(db, `teams/${TEAM_ID}/children`));
  measure(`useChildren (${childrenSnap.count} dokument)`, childrenSnap.ms, 1);

  const cycleSnap = await timeFirstSnapshot(doc(db, `teams/${TEAM_ID}/children/${CHILD_ID}/custodyCycle/main`));
  measure("useCustodyCycle (1 dokument)", cycleSnap.ms, 1);

  const balanceSnap = await timeFirstSnapshot(doc(db, `teams/${TEAM_ID}/children/${CHILD_ID}/dayBalance/main`));
  measure("useDayBalance (1 dokument)", balanceSnap.ms, 1);

  console.log("\n--- Kalenderfliken ---\n");

  const rangeStart = Timestamp.fromDate(new Date(2026, 6, 1));
  const rangeEnd = Timestamp.fromDate(new Date(2026, 9, 1));

  const rangedEvents = await timeFirstSnapshot(
    query(
      collection(db, `teams/${TEAM_ID}/events`),
      where("startAt", ">=", rangeStart),
      where("startAt", "<", rangeEnd),
      orderBy("startAt", "asc")
    )
  );
  measure(`events: intervallfråga (${rangedEvents.count} st)`, rangedEvents.ms, 1);

  const recurringEvents = await timeFirstSnapshot(
    query(
      collection(db, `teams/${TEAM_ID}/events`),
      where("recurrence", "!=", null),
      where("startAt", "<", rangeEnd)
    )
  );
  measure(`events: återkommande (${recurringEvents.count} st)`, recurringEvents.ms, 1);

  const allShifts = await timeFirstSnapshot(collection(db, `teams/${TEAM_ID}/shiftRequests`));
  measure(`shiftRequests: alla (${allShifts.count} st)`, allShifts.ms, 1);

  console.log("\n--- Chattfliken ---\n");

  const chat = await timeFirstSnapshot(
    query(collection(db, `teams/${TEAM_ID}/chatMessages`), orderBy("createdAt", "desc"))
  );
  measure(`chatMessages: alla (${chat.count} st)`, chat.ms, 1);

  console.log("\n--- Skrivningar ---\n");

  const [, writeEventMs] = await time(async () => {
    await setDoc(doc(db, `teams/${TEAM_ID}/events/new-event`), {
      id: "new-event",
      teamId: TEAM_ID,
      childId: CHILD_ID,
      title: "Ny aktivitet",
      startAt: Timestamp.now(),
      endAt: Timestamp.now(),
      createdBy: UID_A,
      createdAt: Timestamp.now(),
    });
  });
  measure("createEvent (1 skrivning)", writeEventMs, 1);

  const [, writeChatMs] = await time(async () => {
    await setDoc(doc(db, `teams/${TEAM_ID}/chatMessages/new-msg`), {
      id: "new-msg",
      teamId: TEAM_ID,
      senderId: UID_A,
      text: "Hej!",
      createdAt: Timestamp.now(),
    });
  });
  measure("sendChatMessage (1 skrivning)", writeChatMs, 1);

  // proposeShiftRequest gör TVÅ skrivningar: förfrågan + chattmeddelande.
  const [, proposeMs] = await time(async () => {
    await setDoc(doc(db, `teams/${TEAM_ID}/shiftRequests/new-shift`), {
      id: "new-shift",
      teamId: TEAM_ID,
      childId: CHILD_ID,
      requestedBy: UID_A,
      takingOverParentId: UID_B,
      startAt: Timestamp.now(),
      status: "pending",
      createdAt: Timestamp.now(),
    });
    await setDoc(doc(db, `teams/${TEAM_ID}/chatMessages/shift-msg`), {
      id: "shift-msg",
      teamId: TEAM_ID,
      senderId: UID_A,
      text: "",
      linkedShiftRequestId: "new-shift",
      createdAt: Timestamp.now(),
    });
  });
  measure("proposeShiftRequest (2 skrivningar i följd)", proposeMs, 2);

  console.log("\n--- Packlista: hela items-arrayen skrivs om ---\n");

  const bigList = {
    id: "list1",
    teamId: TEAM_ID,
    childId: CHILD_ID,
    title: "Stor packlista",
    items: Array.from({ length: 50 }, (_, i) => ({ id: `i${i}`, name: `Sak ${i}`, checked: false })),
    seenBy: [UID_A],
    createdAt: Timestamp.now(),
    updatedAt: Timestamp.now(),
  };
  await setDoc(doc(db, `teams/${TEAM_ID}/packLists/list1`), bigList);

  const [, toggleMs] = await time(async () => {
    const items = bigList.items.map((it, i) => (i === 25 ? { ...it, checked: true } : it));
    await setDoc(doc(db, `teams/${TEAM_ID}/packLists/list1`), { ...bigList, items }, { merge: true });
  });
  measure("togglePackListItem (50 poster skrivs om)", toggleMs, 1);

  console.log("\n--- Total kallstart (allt parallellt, som i appen) ---\n");

  const [, parallelMs] = await time(async () => {
    await Promise.all([
      timeFirstSnapshot(doc(db, `teams/${TEAM_ID}`)),
      timeFirstSnapshot(collection(db, `teams/${TEAM_ID}/children`)),
      timeFirstSnapshot(doc(db, `teams/${TEAM_ID}/children/${CHILD_ID}/custodyCycle/main`)),
      timeFirstSnapshot(doc(db, `teams/${TEAM_ID}/children/${CHILD_ID}/dayBalance/main`)),
      timeFirstSnapshot(collection(db, `teams/${TEAM_ID}/shiftRequests`)),
      timeFirstSnapshot(
        query(
          collection(db, `teams/${TEAM_ID}/events`),
          where("startAt", ">=", rangeStart),
          where("startAt", "<", rangeEnd),
          orderBy("startAt", "asc")
        )
      ),
      timeFirstSnapshot(query(collection(db, `teams/${TEAM_ID}/chatMessages`), orderBy("createdAt", "desc"))),
      timeFirstSnapshot(collection(db, `teams/${TEAM_ID}/todos`)),
    ]);
  });
  measure("8 lyssnare parallellt", parallelMs);

  console.log(`
${"=".repeat(78)}
  TOLKNING

  Emulatorn kör över loopback, så absoluta tal säger inget om verklig
  latens. Det som ÄR meningsfullt: antalet round trips per vy, och att
  lyssnarna körs parallellt (inte i följd).

  Uppskattning för produktion: multiplicera antalet operationer med din
  RTT. Med 60 ms från svensk mobil till europe-north1 blir en kallstart
  ~60-80 ms om lyssnarna är parallella — men ~500 ms om de körs
  sekventiellt. Appen startar dem parallellt via separata useEffect,
  vilket är rätt.

  Två saker värda att hålla ögonen på:
   - proposeShiftRequest gör 2 sekventiella skrivningar (förfrågan +
     chattmeddelande). Det dubblar latensen; en writeBatch skulle göra
     det till en round trip.
   - togglePackListItem skriver om hela items-arrayen. Med 50 poster är
     dokumentet fortfarande litet, men det växer linjärt.
${"=".repeat(78)}
`);

  await deleteApp(app);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
