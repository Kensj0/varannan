"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createFamilyTeam = createFamilyTeam;
exports.createInvite = createInvite;
exports.acceptInvite = acceptInvite;
exports.addChild = addChild;
exports.saveCustodyCycle = saveCustodyCycle;
const functions_1 = require("firebase/functions");
const firestore_1 = require("firebase/firestore");
const firebase_1 = require("../firebase");
/**
 * team/invite/cykel går via Cloud Functions eftersom firestore.rules
 * medvetet blockerar de skrivningarna från klienten (se README-avsnittet
 * "Säkerhet"). addChild går DIREKT mot Firestore eftersom rules redan
 * tillåter teammedlemmar att skriva i children-subkollektionen.
 */
async function createFamilyTeam(teamName) {
    const fn = (0, functions_1.httpsCallable)(firebase_1.functions, "createFamilyTeam");
    const res = await fn({ teamName });
    return res.data;
}
async function createInvite(teamId) {
    const fn = (0, functions_1.httpsCallable)(firebase_1.functions, "createInvite");
    // Servern validerar origin mot ALLOWED_APP_ORIGINS och faller tillbaka
    // på ett känt värde om det inte matchar — se functions/src/index.ts.
    const baseUrl = typeof window !== "undefined" ? window.location.origin : undefined;
    const res = await fn({ teamId, baseUrl });
    return res.data;
}
async function acceptInvite(code) {
    const fn = (0, functions_1.httpsCallable)(firebase_1.functions, "acceptInvite");
    const res = await fn({ code });
    return res.data;
}
async function addChild(teamId, name, birthYear) {
    const ref = (0, firestore_1.doc)((0, firestore_1.collection)(firebase_1.db, `teams/${teamId}/children`));
    const childDoc = {
        id: ref.id,
        teamId,
        name,
        birthYear,
        createdAt: { seconds: Math.floor(Date.now() / 1000), nanoseconds: 0 },
    };
    await (0, firestore_1.setDoc)(ref, childDoc);
    return { childId: ref.id };
}
async function saveCustodyCycle(args) {
    const fn = (0, functions_1.httpsCallable)(firebase_1.functions, "saveCustodyCycle");
    await fn({
        teamId: args.teamId,
        childId: args.childId,
        blocks: args.blocks,
        cycleStartDate: args.cycleStartDate,
        switchHour: args.switchHour,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        referenceParentId: args.referenceParentId,
    });
}
