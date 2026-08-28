"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.sendChatMessage = sendChatMessage;
const firestore_1 = require("firebase/firestore");
const firebase_1 = require("./firebase");
/**
 * Skickar ett chattmeddelande. Tillåtet direkt från klienten enligt
 * firestore.rules, som också tvingar senderId == request.auth.uid och
 * blockerar update/delete (chatthistoriken ska inte gå att skriva om
 * i efterhand — särskilt viktigt när den innehåller överenskommelser
 * om ansvarsbyten).
 */
async function sendChatMessage(args) {
    const ref = (0, firestore_1.doc)((0, firestore_1.collection)(firebase_1.db, `teams/${args.teamId}/chatMessages`));
    const message = {
        id: ref.id,
        teamId: args.teamId,
        senderId: args.senderId,
        text: args.text,
        linkedShiftRequestId: args.linkedShiftRequestId,
        createdAt: firestore_1.Timestamp.now(),
    };
    await (0, firestore_1.setDoc)(ref, message);
    return ref.id;
}
