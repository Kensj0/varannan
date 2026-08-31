import {
  collection,
  doc,
  setDoc,
  updateDoc,
  deleteDoc,
  arrayUnion,
  Timestamp,
} from "firebase/firestore";
import { db } from "./firebase";
import { PackListDoc, PackListItemDoc, NoteDoc, TodoDoc } from "../types/schema";

/**
 * Skrivningar för Packlista, Notes och Todo. Alla går direkt mot
 * Firestore — firestore.rules tillåter teammedlemmar att skriva i de
 * här collections, till skillnad från dayBalance/custodyCycle som
 * kräver Cloud Functions.
 */

// ---------------------------------------------------------------------------
// Packlistor
// ---------------------------------------------------------------------------

export async function createPackList(args: {
  teamId: string;
  childId: string;
  title: string;
  items?: string[];
  linkedShiftRequestId?: string;
  createdBy: string;
}): Promise<string> {
  const ref = doc(collection(db, `teams/${args.teamId}/packLists`));
  const packList: any = {
    id: ref.id,
    teamId: args.teamId,
    childId: args.childId,
    title: args.title,
    items: (args.items ?? []).map((name, i) => ({
      id: `${Date.now()}-${i}`,
      name,
      checked: false,
    })),
    seenBy: [args.createdBy],
    createdAt: Timestamp.now() as any,
    updatedAt: Timestamp.now() as any,
  };
  if (args.linkedShiftRequestId) {
    packList.linkedShiftRequestId = args.linkedShiftRequestId;
  }
  await setDoc(ref, packList);
  return ref.id;
}

export async function addPackListItem(teamId: string, list: PackListDoc, name: string): Promise<void> {
  const item: PackListItemDoc = { id: `${Date.now()}`, name, checked: false };
  await updateDoc(doc(db, `teams/${teamId}/packLists/${list.id}`), {
    items: [...list.items, item],
    updatedAt: Timestamp.now(),
  });
}

/**
 * Bockar av/på en post. Hela items-arrayen skrivs om eftersom Firestore
 * inte kan uppdatera ett enskilt element i en array — det är en medveten
 * avvägning: listorna är korta (packlistor, inte inventarier).
 */
export async function togglePackListItem(
  teamId: string,
  list: PackListDoc,
  itemId: string,
  userId: string
): Promise<void> {
  const items = list.items.map((item) =>
    item.id === itemId
      ? { ...item, checked: !item.checked, checkedBy: !item.checked ? userId : undefined }
      : item
  );
  await updateDoc(doc(db, `teams/${teamId}/packLists/${list.id}`), {
    items,
    updatedAt: Timestamp.now(),
  });
}

export async function removePackListItem(teamId: string, list: PackListDoc, itemId: string): Promise<void> {
  await updateDoc(doc(db, `teams/${teamId}/packLists/${list.id}`), {
    items: list.items.filter((i) => i.id !== itemId),
    updatedAt: Timestamp.now(),
  });
}

/** Motsvarar "Sedd av:"-raden i originalappen. */
export async function markPackListSeen(teamId: string, listId: string, userId: string): Promise<void> {
  await updateDoc(doc(db, `teams/${teamId}/packLists/${listId}`), {
    seenBy: arrayUnion(userId),
  });
}

export async function deletePackList(teamId: string, listId: string): Promise<void> {
  await deleteDoc(doc(db, `teams/${teamId}/packLists/${listId}`));
}

// ---------------------------------------------------------------------------
// Anteckningar
// ---------------------------------------------------------------------------

export async function createNote(args: {
  teamId: string;
  title: string;
  content: string;
  createdBy: string;
}): Promise<string> {
  const ref = doc(collection(db, `teams/${args.teamId}/notes`));
  const note: NoteDoc = {
    id: ref.id,
    teamId: args.teamId,
    title: args.title,
    content: args.content,
    createdBy: args.createdBy,
    createdAt: Timestamp.now() as any,
    updatedAt: Timestamp.now() as any,
  };
  await setDoc(ref, note);
  return ref.id;
}

export async function updateNote(
  teamId: string,
  noteId: string,
  patch: { title?: string; content?: string }
): Promise<void> {
  await updateDoc(doc(db, `teams/${teamId}/notes/${noteId}`), {
    ...patch,
    updatedAt: Timestamp.now(),
  });
}

export async function deleteNote(teamId: string, noteId: string): Promise<void> {
  await deleteDoc(doc(db, `teams/${teamId}/notes/${noteId}`));
}

// ---------------------------------------------------------------------------
// Todos
// ---------------------------------------------------------------------------

export async function createTodo(args: {
  teamId: string;
  title: string;
  createdBy: string;
}): Promise<string> {
  const ref = doc(collection(db, `teams/${args.teamId}/todos`));
  const todo: TodoDoc = {
    id: ref.id,
    teamId: args.teamId,
    title: args.title,
    done: false,
    archived: false,
    seenBy: [args.createdBy],
    createdBy: args.createdBy,
    createdAt: Timestamp.now() as any,
  };
  await setDoc(ref, todo);
  return ref.id;
}

export async function toggleTodo(teamId: string, todo: TodoDoc, userId: string): Promise<void> {
  await updateDoc(doc(db, `teams/${teamId}/todos/${todo.id}`), {
    done: !todo.done,
    doneBy: !todo.done ? userId : null,
    doneAt: !todo.done ? Timestamp.now() : null,
  });
}

/** "ARKIVERA" i originalappen — göms från listan utan att raderas. */
export async function archiveTodo(teamId: string, todoId: string): Promise<void> {
  await updateDoc(doc(db, `teams/${teamId}/todos/${todoId}`), { archived: true });
}

export async function markTodoSeen(teamId: string, todoId: string, userId: string): Promise<void> {
  await updateDoc(doc(db, `teams/${teamId}/todos/${todoId}`), {
    seenBy: arrayUnion(userId),
  });
}
