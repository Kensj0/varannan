// Spärr före deploy, kör av firebase.json (predeploy) både lokalt och i CI.
// Deployen stoppas om:
//   - du inte står på main
//   - arbetskopian har ändringar som inte är committade
//   - taggen production saknas, eller inte ligger i historiken för HEAD
const { execSync } = require("child_process");

const run = (cmd) => execSync(cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const fail = (msg) => {
  console.error(`Deploy stoppad: ${msg}`);
  process.exit(1);
};

const branch = run("git rev-parse --abbrev-ref HEAD");
if (branch !== "main") {
  fail(`du står på "${branch}", inte på main.`);
}

if (run("git status --porcelain") !== "") {
  fail("arbetskopian har ändringar som inte är committade.");
}

try {
  run("git rev-parse -q --verify refs/tags/production");
} catch {
  fail("taggen production saknas. Hämta den med: git fetch --tags");
}

try {
  execSync("git merge-base --is-ancestor production HEAD", { stdio: "ignore" });
} catch {
  fail("taggen production ligger inte i historiken för HEAD.");
}

console.log(`OK: på main, ren arbetskopia, production (${run("git rev-parse --short production")}) i historiken.`);
