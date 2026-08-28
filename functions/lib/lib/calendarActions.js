"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createEvent = createEvent;
exports.proposeShiftRequest = proposeShiftRequest;
exports.respondToShiftRequest = respondToShiftRequest;
const firestore_1 = require("firebase/firestore");
const functions_1 = require("firebase/functions");
const firebase_1 = require("./firebase");
const chatActions_1 = require("./chatActions");
/**
 * Skrivningar från kalendervyn. Aktiviteter och nya (pending)
 * ansvarsbyten får skrivas direkt av teammedlemmar enligt
 * firestore.rules. Godkännande går via callable, eftersom det måste
 * uppdatera ställningen i samma transaktion.
 */
async function createEvent(args) {
    const ref = (0, firestore_1.doc)((0, firestore_1.collection)(firebase_1.db, `teams/${args.teamId}/events`));
    const event = {
        id: ref.id,
        teamId: args.teamId,
        childId: args.childId,
        title: args.title,
        startAt: firestore_1.Timestamp.fromDate(args.startAt),
        endAt: firestore_1.Timestamp.fromDate(args.endAt),
        recurrence: args.recurrence,
        createdBy: args.createdBy,
        createdAt: firestore_1.Timestamp.now(),
    };
    await (0, firestore_1.setDoc)(ref, event);
    return ref.id;
}
async function proposeShiftRequest(args) {
    const ref = (0, firestore_1.doc)((0, firestore_1.collection)(firebase_1.db, `teams/${args.teamId}/shiftRequests`));
    const request = {
        id: ref.id,
        teamId: args.teamId,
        childId: args.childId,
        requestedBy: args.requestedBy,
        takingOverParentId: args.takingOverParentId,
        startAt: firestore_1.Timestamp.fromDate(args.startAt),
        endAt: args.endAt ? firestore_1.Timestamp.fromDate(args.endAt) : undefined,
        handoffMethod: args.handoffMethod,
        note: args.note,
        status: "pending",
        createdAt: firestore_1.Timestamp.now(),
    };
    await (0, firestore_1.setDoc)(ref, request);
    // Lägg in förfrågan i chatten också, så båda föräldrarna har hela
    // historiken över förfrågningar och godkännanden på ett ställe.
    await (0, chatActions_1.sendChatMessage)({
        teamId: args.teamId,
        senderId: args.requestedBy,
        text: args.note ?? "",
        linkedShiftRequestId: ref.id,
    });
    return ref.id;
}
/** Godkänn eller avböj — kör transaktionen som uppdaterar ställningen. */
async function respondToShiftRequest(args) {
    const fn = (0, functions_1.httpsCallable)(firebase_1.functions, "approveShiftRequest");
    await fn(args);
}
