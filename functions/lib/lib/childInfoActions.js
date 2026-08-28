"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.updateChildInfo = updateChildInfo;
exports.clearChildInfoField = clearChildInfoField;
exports.createChildAccount = createChildAccount;
exports.updateChildAccount = updateChildAccount;
exports.deleteChildAccount = deleteChildAccount;
const firestore_1 = require("firebase/firestore");
const firebase_1 = require("./firebase");
/**
 * Skrivningar för Barninfo och Konton.
 *
 * SÄKERHET: de här dokumenten innehåller personnummer, passnummer,
 * medicinsk information och inloggningsuppgifter. De skyddas av
 * firestore.rules (endast teamets föräldrar) och är avindexerade i
 * firestore.indexes.json så att de aldrig blir sökbara.
 *
 * Firestore krypterar allt at-rest som standard, men Anthropics
 * rekommendation för produktion är att dessutom kryptera pinOrNote och
 * personalNumber klient-side med en nyckel som ligger utanför
 * databasen — då skyddas de även mot en felkonfigurerad regel eller en
 * läckt admin-nyckel. Det är INTE implementerat här (mockup).
 */
// ---------------------------------------------------------------------------
// Barninfo
// ---------------------------------------------------------------------------
/**
 * Uppdaterar ett eller flera fält. Använder merge så att ett fält kan
 * sparas utan att de andra skrivs över — formuläret sparar per rad.
 */
async function updateChildInfo(teamId, childId, patch, updatedBy) {
    await (0, firestore_1.setDoc)((0, firestore_1.doc)(firebase_1.db, `teams/${teamId}/children/${childId}/childInfo/main`), { ...patch, updatedBy, updatedAt: firestore_1.Timestamp.now() }, { merge: true });
}
/** Tömmer ett enskilt fält (t.ex. om man vill ta bort personnumret igen). */
async function clearChildInfoField(teamId, childId, field, updatedBy) {
    await (0, firestore_1.setDoc)((0, firestore_1.doc)(firebase_1.db, `teams/${teamId}/children/${childId}/childInfo/main`), { [field]: "", updatedBy, updatedAt: firestore_1.Timestamp.now() }, { merge: true });
}
// ---------------------------------------------------------------------------
// Delade konton
// ---------------------------------------------------------------------------
async function createChildAccount(args) {
    const ref = (0, firestore_1.doc)((0, firestore_1.collection)(firebase_1.db, `teams/${args.teamId}/children/${args.childId}/accounts`));
    const account = {
        id: ref.id,
        service: args.service,
        username: args.username,
        pinOrNote: args.pinOrNote,
        addedBy: args.addedBy,
        createdAt: firestore_1.Timestamp.now(),
    };
    await (0, firestore_1.setDoc)(ref, account);
    return ref.id;
}
async function updateChildAccount(teamId, childId, accountId, patch) {
    await (0, firestore_1.setDoc)((0, firestore_1.doc)(firebase_1.db, `teams/${teamId}/children/${childId}/accounts/${accountId}`), patch, { merge: true });
}
async function deleteChildAccount(teamId, childId, accountId) {
    await (0, firestore_1.deleteDoc)((0, firestore_1.doc)(firebase_1.db, `teams/${teamId}/children/${childId}/accounts/${accountId}`));
}
