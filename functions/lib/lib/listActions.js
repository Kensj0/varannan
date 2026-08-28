"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createPackList = createPackList;
exports.addPackListItem = addPackListItem;
exports.togglePackListItem = togglePackListItem;
exports.removePackListItem = removePackListItem;
exports.markPackListSeen = markPackListSeen;
exports.deletePackList = deletePackList;
exports.createNote = createNote;
exports.updateNote = updateNote;
exports.deleteNote = deleteNote;
exports.createTodo = createTodo;
exports.toggleTodo = toggleTodo;
exports.archiveTodo = archiveTodo;
exports.markTodoSeen = markTodoSeen;
const firestore_1 = require("firebase/firestore");
const firebase_1 = require("./firebase");
/**
 * Skrivningar för Packlista, Notes och Todo. Alla går direkt mot
 * Firestore — firestore.rules tillåter teammedlemmar att skriva i de
 * här collections, till skillnad från dayBalance/custodyCycle som
 * kräver Cloud Functions.
 */
// ---------------------------------------------------------------------------
// Packlistor
// ---------------------------------------------------------------------------
async function createPackList(args) {
    const ref = (0, firestore_1.doc)((0, firestore_1.collection)(firebase_1.db, `teams/${args.teamId}/packLists`));
    const packList = {
        id: ref.id,
        teamId: args.teamId,
        childId: args.childId,
        title: args.title,
        linkedShiftRequestId: args.linkedShiftRequestId,
        items: (args.items ?? []).map((name, i) => ({
            id: `${Date.now()}-${i}`,
            name,
            checked: false,
        })),
        seenBy: [args.createdBy],
        createdAt: firestore_1.Timestamp.now(),
        updatedAt: firestore_1.Timestamp.now(),
    };
    await (0, firestore_1.setDoc)(ref, packList);
    return ref.id;
}
async function addPackListItem(teamId, list, name) {
    const item = { id: `${Date.now()}`, name, checked: false };
    await (0, firestore_1.updateDoc)((0, firestore_1.doc)(firebase_1.db, `teams/${teamId}/packLists/${list.id}`), {
        items: [...list.items, item],
        updatedAt: firestore_1.Timestamp.now(),
    });
}
/**
 * Bockar av/på en post. Hela items-arrayen skrivs om eftersom Firestore
 * inte kan uppdatera ett enskilt element i en array — det är en medveten
 * avvägning: listorna är korta (packlistor, inte inventarier).
 */
async function togglePackListItem(teamId, list, itemId, userId) {
    const items = list.items.map((item) => item.id === itemId
        ? { ...item, checked: !item.checked, checkedBy: !item.checked ? userId : undefined }
        : item);
    await (0, firestore_1.updateDoc)((0, firestore_1.doc)(firebase_1.db, `teams/${teamId}/packLists/${list.id}`), {
        items,
        updatedAt: firestore_1.Timestamp.now(),
    });
}
async function removePackListItem(teamId, list, itemId) {
    await (0, firestore_1.updateDoc)((0, firestore_1.doc)(firebase_1.db, `teams/${teamId}/packLists/${list.id}`), {
        items: list.items.filter((i) => i.id !== itemId),
        updatedAt: firestore_1.Timestamp.now(),
    });
}
/** Motsvarar "Sedd av:"-raden i originalappen. */
async function markPackListSeen(teamId, listId, userId) {
    await (0, firestore_1.updateDoc)((0, firestore_1.doc)(firebase_1.db, `teams/${teamId}/packLists/${listId}`), {
        seenBy: (0, firestore_1.arrayUnion)(userId),
    });
}
async function deletePackList(teamId, listId) {
    await (0, firestore_1.deleteDoc)((0, firestore_1.doc)(firebase_1.db, `teams/${teamId}/packLists/${listId}`));
}
// ---------------------------------------------------------------------------
// Anteckningar
// ---------------------------------------------------------------------------
async function createNote(args) {
    const ref = (0, firestore_1.doc)((0, firestore_1.collection)(firebase_1.db, `teams/${args.teamId}/notes`));
    const note = {
        id: ref.id,
        teamId: args.teamId,
        title: args.title,
        content: args.content,
        createdBy: args.createdBy,
        createdAt: firestore_1.Timestamp.now(),
        updatedAt: firestore_1.Timestamp.now(),
    };
    await (0, firestore_1.setDoc)(ref, note);
    return ref.id;
}
async function updateNote(teamId, noteId, patch) {
    await (0, firestore_1.updateDoc)((0, firestore_1.doc)(firebase_1.db, `teams/${teamId}/notes/${noteId}`), {
        ...patch,
        updatedAt: firestore_1.Timestamp.now(),
    });
}
async function deleteNote(teamId, noteId) {
    await (0, firestore_1.deleteDoc)((0, firestore_1.doc)(firebase_1.db, `teams/${teamId}/notes/${noteId}`));
}
// ---------------------------------------------------------------------------
// Todos
// ---------------------------------------------------------------------------
async function createTodo(args) {
    const ref = (0, firestore_1.doc)((0, firestore_1.collection)(firebase_1.db, `teams/${args.teamId}/todos`));
    const todo = {
        id: ref.id,
        teamId: args.teamId,
        title: args.title,
        done: false,
        archived: false,
        seenBy: [args.createdBy],
        createdBy: args.createdBy,
        createdAt: firestore_1.Timestamp.now(),
    };
    await (0, firestore_1.setDoc)(ref, todo);
    return ref.id;
}
async function toggleTodo(teamId, todo, userId) {
    await (0, firestore_1.updateDoc)((0, firestore_1.doc)(firebase_1.db, `teams/${teamId}/todos/${todo.id}`), {
        done: !todo.done,
        doneBy: !todo.done ? userId : null,
        doneAt: !todo.done ? firestore_1.Timestamp.now() : null,
    });
}
/** "ARKIVERA" i originalappen — göms från listan utan att raderas. */
async function archiveTodo(teamId, todoId) {
    await (0, firestore_1.updateDoc)((0, firestore_1.doc)(firebase_1.db, `teams/${teamId}/todos/${todoId}`), { archived: true });
}
async function markTodoSeen(teamId, todoId, userId) {
    await (0, firestore_1.updateDoc)((0, firestore_1.doc)(firebase_1.db, `teams/${teamId}/todos/${todoId}`), {
        seenBy: (0, firestore_1.arrayUnion)(userId),
    });
}
