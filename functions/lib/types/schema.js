"use strict";
/**
 * VARANNAN — Firestore datamodell (NoSQL)
 * ----------------------------------------
 * Alla collections är top-level. Nästan allt kopplas ihop via `teamId`
 * (= "familjen", dvs de två föräldrarna + gemensamma barn).
 *
 * Firestore-paths:
 *   /users/{uid}
 *   /teams/{teamId}
 *   /teams/{teamId}/children/{childId}                (subcollection)
 *   /teams/{teamId}/children/{childId}/childInfo/main  (singleton-doc)
 *   /teams/{teamId}/children/{childId}/accounts/{accountId}
 *   /teams/{teamId}/children/{childId}/custodyCycle/main (singleton-doc)
 *   /teams/{teamId}/children/{childId}/dayBalance/main   (singleton-doc)
 *   /teams/{teamId}/events/{eventId}
 *   /teams/{teamId}/shiftRequests/{shiftRequestId}
 *   /teams/{teamId}/packLists/{packListId}
 *   /teams/{teamId}/notes/{noteId}
 *   /teams/{teamId}/todos/{todoId}
 *   /teams/{teamId}/chatMessages/{messageId}
 */
Object.defineProperty(exports, "__esModule", { value: true });
