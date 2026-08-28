import { collection, doc, setDoc, Timestamp } from "firebase/firestore";
import { db } from "./firebase";
import { ChatMessageDoc } from "../types/schema";

/**
 * Skickar ett chattmeddelande. Tillåtet direkt från klienten enligt
 * firestore.rules, som också tvingar senderId == request.auth.uid och
 * blockerar update/delete (chatthistoriken ska inte gå att skriva om
 * i efterhand — särskilt viktigt när den innehåller överenskommelser
 * om ansvarsbyten).
 */
export async function sendChatMessage(args: {
  teamId: string;
  senderId: string;
  text: string;
  linkedShiftRequestId?: string;
}): Promise<string> {
  const ref = doc(collection(db, `teams/${args.teamId}/chatMessages`));
  const message: ChatMessageDoc = {
    id: ref.id,
    teamId: args.teamId,
    senderId: args.senderId,
    text: args.text,
    linkedShiftRequestId: args.linkedShiftRequestId,
    createdAt: Timestamp.now() as any,
  };
  await setDoc(ref, message);
  return ref.id;
}
