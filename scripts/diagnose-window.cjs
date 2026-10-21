// Skrivskyddad diagnos: listar barn (kalendrar) och aktiviteter som skapats
// i ett tidsfönster, och markerar dubbletter. Gör bara läsanrop (where/get).
// Skriver ingenting till Firestore. Körs av .github/workflows/diagnose-window.yml.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const admin = require(path.join(__dirname, "..", "functions", "node_modules", "firebase-admin"));

const start = new Date(process.env.WINDOW_START);
const end = new Date(process.env.WINDOW_END);
if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
  throw new Error("WINDOW_START/WINDOW_END måste vara ISO-datum");
}

admin.initializeApp({
  credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)),
  projectId: "varannan-familj",
});
const db = admin.firestore();
const { Timestamp } = admin.firestore;

function hash(value) {
  return crypto.createHash("sha256").update(value).digest("hex").slice(0, 12);
}

function inWindow(query) {
  return query
    .where("createdAt", ">=", Timestamp.fromDate(start))
    .where("createdAt", "<", Timestamp.fromDate(end));
}

(async () => {
  // Frågar per team i stället för collectionGroup. Då behövs inget
  // sammansatt index, och ingen indexdeploy krävs.
  const teams = await db.collection("teams").get();
  const childDocs = [];
  const eventDocs = [];
  for (const team of teams.docs) {
    childDocs.push(...(await inWindow(team.ref.collection("children")).get()).docs);
    eventDocs.push(...(await inWindow(team.ref.collection("events")).get()).docs);
  }

  const children = childDocs.map((d) => ({
    path: d.ref.path,
    teamId: d.get("teamId") ?? null,
    // Namnet tas inte med. Bara en hash, så dubbletter går att hitta.
    nameHash: hash(d.get("name") ?? ""),
    createdAt: d.get("createdAt").toDate().toISOString(),
  }));

  // Dubbletter: samma namn i samma team, skapade i fönstret.
  const groups = new Map();
  for (const c of children) {
    const key = `${c.teamId}|${c.nameHash}`;
    groups.set(key, [...(groups.get(key) ?? []), c.path]);
  }
  const duplicates = [...groups.entries()]
    .filter(([, paths]) => paths.length > 1)
    .map(([key, paths]) => ({ teamId_nameHash: key, paths }));

  const events = eventDocs.map((d) => ({
    path: d.ref.path,
    teamId: d.get("teamId") ?? null,
    childId: d.get("childId") ?? null,
    createdAt: d.get("createdAt").toDate().toISOString(),
    // Antal uid:n med ett Google-event-id. Titlar tas inte med.
    googleEventIdCount: Object.keys(d.get("googleEventIds") ?? {}).length,
  }));

  const result = {
    window: { start: start.toISOString(), end: end.toISOString() },
    counts: { children: children.length, events: events.length, duplicateGroups: duplicates.length },
    children,
    duplicates,
    events,
  };

  fs.mkdirSync("diagnostics", { recursive: true });
  fs.writeFileSync(path.join("diagnostics", "window.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result.counts, null, 2));
  console.log(`Skrev diagnostics/window.json (${children.length} barn, ${events.length} aktiviteter)`);
})().catch((err) => {
  console.error("Diagnos misslyckades:", err.message);
  process.exit(1);
});
