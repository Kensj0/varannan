"use client";

import { useEffect, useMemo, useState } from "react";
import {
  collection,
  doc,
  onSnapshot,
  query,
  where,
  orderBy,
  limit,
  Timestamp,
} from "firebase/firestore";
import { db } from "../firebase";
import {
  ChildDoc,
  CustodyCycleDoc,
  DayBalanceDoc,
  ShiftRequestDoc,
  BalanceRequestDoc,
  EventDoc,
  TeamDoc,
  ChatMessageDoc,
  PackListDoc,
  NoteDoc,
  TodoDoc,
  ChildInfoDoc,
  ChildAccountDoc,
} from "../../types/schema";

/**
 * Realtidslyssnare mot Firestore. Alla följer samma mönster:
 * onSnapshot i en useEffect, cleanup vid unmount/ändrat id, och
 * { data, loading, error } tillbaka så UI:t kan visa laddningsläge.
 *
 * Poängen med onSnapshot (istället för engångsläsning): när den ena
 * föräldern godkänner ett ansvarsbyte uppdateras den andres kalender
 * och ställning direkt, utan omladdning.
 */

interface ListenerState<T> {
  data: T;
  loading: boolean;
  error: Error | null;
}

// ---------------------------------------------------------------------------
// Team
// ---------------------------------------------------------------------------

export function useTeam(teamId: string | null | undefined): ListenerState<TeamDoc | null> {
  const [state, setState] = useState<ListenerState<TeamDoc | null>>({
    data: null,
    loading: true,
    error: null,
  });

  useEffect(() => {
    if (!teamId) {
      setState({ data: null, loading: false, error: null });
      return;
    }
    const unsub = onSnapshot(
      doc(db, "teams", teamId),
      (snap) => setState({ data: snap.exists() ? (snap.data() as TeamDoc) : null, loading: false, error: null }),
      (error) => setState({ data: null, loading: false, error })
    );
    return unsub;
  }, [teamId]);

  return state;
}

// ---------------------------------------------------------------------------
// Barn
// ---------------------------------------------------------------------------

export function useChildren(teamId: string | null | undefined): ListenerState<ChildDoc[]> {
  const [state, setState] = useState<ListenerState<ChildDoc[]>>({ data: [], loading: true, error: null });

  useEffect(() => {
    if (!teamId) {
      setState({ data: [], loading: false, error: null });
      return;
    }
    const unsub = onSnapshot(
      collection(db, `teams/${teamId}/children`),
      (snap) => setState({ data: snap.docs.map((d) => d.data() as ChildDoc), loading: false, error: null }),
      (error) => setState({ data: [], loading: false, error })
    );
    return unsub;
  }, [teamId]);

  return state;
}

// ---------------------------------------------------------------------------
// Boendecykel + ställning (singleton-dokument per barn)
// ---------------------------------------------------------------------------

export function useCustodyCycle(
  teamId: string | null | undefined,
  childId: string | null | undefined
): ListenerState<CustodyCycleDoc | null> {
  const [state, setState] = useState<ListenerState<CustodyCycleDoc | null>>({
    data: null,
    loading: true,
    error: null,
  });

  useEffect(() => {
    if (!teamId || !childId) {
      setState({ data: null, loading: false, error: null });
      return;
    }
    const unsub = onSnapshot(
      doc(db, `teams/${teamId}/children/${childId}/custodyCycle/main`),
      (snap) => setState({ data: snap.exists() ? (snap.data() as CustodyCycleDoc) : null, loading: false, error: null }),
      (error) => setState({ data: null, loading: false, error })
    );
    return unsub;
  }, [teamId, childId]);

  return state;
}

export function useDayBalance(
  teamId: string | null | undefined,
  childId: string | null | undefined
): ListenerState<DayBalanceDoc | null> {
  const [state, setState] = useState<ListenerState<DayBalanceDoc | null>>({
    data: null,
    loading: true,
    error: null,
  });

  useEffect(() => {
    if (!teamId || !childId) {
      setState({ data: null, loading: false, error: null });
      return;
    }
    const unsub = onSnapshot(
      doc(db, `teams/${teamId}/children/${childId}/dayBalance/main`),
      (snap) => setState({ data: snap.exists() ? (snap.data() as DayBalanceDoc) : null, loading: false, error: null }),
      (error) => setState({ data: null, loading: false, error })
    );
    return unsub;
  }, [teamId, childId]);

  return state;
}

// ---------------------------------------------------------------------------
// Ansvarsbyten
// ---------------------------------------------------------------------------

/** Godkända byten — dessa ritas ovanpå den fasta cykeln i CalendarView. */
export function useApprovedShiftRequests(
  teamId: string | null | undefined,
  childId: string | null | undefined
): ListenerState<ShiftRequestDoc[]> {
  return useShiftRequestsByStatus(teamId, childId, "approved");
}

/** Väntande förfrågningar — visas som notis/kort att godkänna eller avböja. */
export function usePendingShiftRequests(
  teamId: string | null | undefined,
  childId: string | null | undefined
): ListenerState<ShiftRequestDoc[]> {
  return useShiftRequestsByStatus(teamId, childId, "pending");
}

/** Alla byten oavsett status — används av chatten för att slå upp länkade kort. */
export function useAllShiftRequests(
  teamId: string | null | undefined
): ListenerState<Record<string, ShiftRequestDoc>> {
  const [state, setState] = useState<ListenerState<Record<string, ShiftRequestDoc>>>({
    data: {},
    loading: true,
    error: null,
  });

  useEffect(() => {
    if (!teamId) {
      setState({ data: {}, loading: false, error: null });
      return;
    }
    const unsub = onSnapshot(
      collection(db, `teams/${teamId}/shiftRequests`),
      (snap) => {
        const byId: Record<string, ShiftRequestDoc> = {};
        for (const d of snap.docs) byId[d.id] = d.data() as ShiftRequestDoc;
        setState({ data: byId, loading: false, error: null });
      },
      (error) => setState({ data: {}, loading: false, error })
    );
    return unsub;
  }, [teamId]);

  return state;
}

/** Väntande justeringar av ställningen för ett barn. */
export function usePendingBalanceRequests(
  teamId: string | null | undefined,
  childId: string | null | undefined
): ListenerState<BalanceRequestDoc[]> {
  const [state, setState] = useState<ListenerState<BalanceRequestDoc[]>>({
    data: [],
    loading: true,
    error: null,
  });

  useEffect(() => {
    if (!teamId || !childId) {
      setState({ data: [], loading: false, error: null });
      return;
    }
    const q = query(
      collection(db, `teams/${teamId}/children/${childId}/balanceRequests`),
      where("status", "==", "pending")
    );
    const unsub = onSnapshot(
      q,
      (snap) =>
        setState({ data: snap.docs.map((d) => d.data() as BalanceRequestDoc), loading: false, error: null }),
      (error) => setState({ data: [], loading: false, error })
    );
    return unsub;
  }, [teamId, childId]);

  return state;
}

function useShiftRequestsByStatus(
  teamId: string | null | undefined,
  childId: string | null | undefined,
  status: ShiftRequestDoc["status"]
): ListenerState<ShiftRequestDoc[]> {
  const [state, setState] = useState<ListenerState<ShiftRequestDoc[]>>({ data: [], loading: true, error: null });

  useEffect(() => {
    if (!teamId || !childId) {
      setState({ data: [], loading: false, error: null });
      return;
    }
    // OBS: kräver ett sammansatt index (childId + status + startAt).
    // Firestore loggar en direktlänk för att skapa det första gången
    // frågan körs — lägg sedan in det i firestore.indexes.json.
    const q = query(
      collection(db, `teams/${teamId}/shiftRequests`),
      where("childId", "==", childId),
      where("status", "==", status),
      orderBy("startAt", "asc")
    );
    const unsub = onSnapshot(
      q,
      (snap) => setState({ data: snap.docs.map((d) => d.data() as ShiftRequestDoc), loading: false, error: null }),
      (error) => setState({ data: [], loading: false, error })
    );
    return unsub;
  }, [teamId, childId, status]);

  return state;
}

// ---------------------------------------------------------------------------
// Packlistor, anteckningar och todos
// ---------------------------------------------------------------------------

/** Packlistor för ett visst barn — knyts i UI:t till nästa byte. */
export function usePackLists(
  teamId: string | null | undefined,
  childId: string | null | undefined
): ListenerState<PackListDoc[]> {
  const [state, setState] = useState<ListenerState<PackListDoc[]>>({ data: [], loading: true, error: null });

  useEffect(() => {
    if (!teamId || !childId) {
      setState({ data: [], loading: false, error: null });
      return;
    }
    const q = query(
      collection(db, `teams/${teamId}/packLists`),
      where("childId", "==", childId),
      orderBy("createdAt", "asc")
    );
    const unsub = onSnapshot(
      q,
      (snap) => setState({ data: snap.docs.map((d) => d.data() as PackListDoc), loading: false, error: null }),
      (error) => setState({ data: [], loading: false, error })
    );
    return unsub;
  }, [teamId, childId]);

  return state;
}

export function useNotes(
  teamId: string | null | undefined,
  childId?: string | null,
  isFallbackCalendar = false
): ListenerState<NoteDoc[]> {
  const [state, setState] = useState<ListenerState<NoteDoc[]>>({ data: [], loading: true, error: null });

  useEffect(() => {
    if (!teamId) {
      setState({ data: [], loading: false, error: null });
      return;
    }
    const q = query(collection(db, `teams/${teamId}/notes`), orderBy("updatedAt", "desc"));
    const unsub = onSnapshot(
      q,
      (snap) =>
        setState({
          // Filtreras i klienten i stället för med where(): kombinationen
          // childId + orderBy kräver ett sammansatt index, och volymen
          // (en familjs anteckningar) gör det inte värt besväret.
          data: snap.docs
            .map((d) => d.data() as NoteDoc)
            .filter((n) => belongsToCalendar(n.childId, childId, isFallbackCalendar)),
          loading: false,
          error: null,
        }),
      (error) => setState({ data: [], loading: false, error })
    );
    return unsub;
  }, [teamId, childId, isFallbackCalendar]);

  return state;
}


/**
 * Hör dokumentet till den valda kalendern?
 *
 * Chatt, notes och todos låg tidigare på teamet och saknar childId. De
 * visas på den FÖRSTA kalendern i stället för att försvinna — annars
 * hade befintligt innehåll blivit oåtkomligt när delningen flyttades
 * ner på barnet.
 */
function belongsToCalendar(
  docChildId: string | undefined,
  childId: string | null | undefined,
  isFallbackCalendar: boolean
): boolean {
  if (!childId) return false;
  if (docChildId) return docChildId === childId;
  return isFallbackCalendar;
}

/** Todos. `archived` styr om avbockade uppgifter ligger kvar i listan. */
export function useTodos(
  teamId: string | null | undefined,
  includeArchived = false,
  childId?: string | null,
  isFallbackCalendar = false
): ListenerState<TodoDoc[]> {
  const [state, setState] = useState<ListenerState<TodoDoc[]>>({ data: [], loading: true, error: null });

  useEffect(() => {
    if (!teamId) {
      setState({ data: [], loading: false, error: null });
      return;
    }
    const base = collection(db, `teams/${teamId}/todos`);
    const q = includeArchived
      ? query(base, orderBy("createdAt", "desc"))
      : query(base, where("archived", "==", false), orderBy("createdAt", "desc"));

    const unsub = onSnapshot(
      q,
      (snap) =>
        setState({
          data: snap.docs
            .map((d) => d.data() as TodoDoc)
            .filter((t) => belongsToCalendar(t.childId, childId, isFallbackCalendar)),
          loading: false,
          error: null,
        }),
      (error) => setState({ data: [], loading: false, error })
    );
    return unsub;
  }, [teamId, includeArchived, childId, isFallbackCalendar]);

  return state;
}

// ---------------------------------------------------------------------------
// Barninfo & delade konton
// ---------------------------------------------------------------------------

/**
 * Barnets sparade information (singleton-dokument). Innehåller känsliga
 * fält — personnummer, passnummer, medicin/allergi — som enligt
 * firestore.rules bara teamets föräldrar kan läsa, och som medvetet
 * är avindexerade i firestore.indexes.json.
 */
export function useChildInfo(
  teamId: string | null | undefined,
  childId: string | null | undefined
): ListenerState<ChildInfoDoc | null> {
  const [state, setState] = useState<ListenerState<ChildInfoDoc | null>>({
    data: null,
    loading: true,
    error: null,
  });

  useEffect(() => {
    if (!teamId || !childId) {
      setState({ data: null, loading: false, error: null });
      return;
    }
    const unsub = onSnapshot(
      doc(db, `teams/${teamId}/children/${childId}/childInfo/main`),
      (snap) => setState({ data: snap.exists() ? (snap.data() as ChildInfoDoc) : null, loading: false, error: null }),
      (error) => setState({ data: null, loading: false, error })
    );
    return unsub;
  }, [teamId, childId]);

  return state;
}

/** Delade konton — streamingtjänster, PIN-koder osv. */
export function useChildAccounts(
  teamId: string | null | undefined,
  childId: string | null | undefined
): ListenerState<ChildAccountDoc[]> {
  const [state, setState] = useState<ListenerState<ChildAccountDoc[]>>({ data: [], loading: true, error: null });

  useEffect(() => {
    if (!teamId || !childId) {
      setState({ data: [], loading: false, error: null });
      return;
    }
    const unsub = onSnapshot(
      collection(db, `teams/${teamId}/children/${childId}/accounts`),
      (snap) => setState({ data: snap.docs.map((d) => d.data() as ChildAccountDoc), loading: false, error: null }),
      (error) => setState({ data: [], loading: false, error })
    );
    return unsub;
  }, [teamId, childId]);

  return state;
}

// ---------------------------------------------------------------------------
// Chatt
// ---------------------------------------------------------------------------

/**
 * Senaste meddelandena i teamets chatt. Hämtas i fallande ordning
 * (nyast först) med en gräns, och vänds sedan så UI:t kan rendera
 * kronologiskt utan att behöva läsa hela historiken.
 */
export function useChatMessages(
  teamId: string | null | undefined,
  messageLimit = 100,
  childId?: string | null,
  isFallbackCalendar = false
): ListenerState<ChatMessageDoc[]> {
  const [state, setState] = useState<ListenerState<ChatMessageDoc[]>>({ data: [], loading: true, error: null });

  useEffect(() => {
    if (!teamId) {
      setState({ data: [], loading: false, error: null });
      return;
    }
    const q = query(
      collection(db, `teams/${teamId}/chatMessages`),
      orderBy("createdAt", "desc"),
      // Hämtas rikligare än vad som visas, eftersom filtreringen per
      // kalender sker i klienten — annars kunde limit ätas upp av
      // meddelanden som hör till en annan kalender.
      limit(messageLimit * 4)
    );
    const unsub = onSnapshot(
      q,
      (snap) =>
        setState({
          data: snap.docs
            .map((d) => d.data() as ChatMessageDoc)
            .filter((m) => belongsToCalendar(m.childId, childId, isFallbackCalendar))
            .slice(0, messageLimit)
            .reverse(),
          loading: false,
          error: null,
        }),
      (error) => setState({ data: [], loading: false, error })
    );
    return unsub;
  }, [teamId, messageLimit, childId, isFallbackCalendar]);

  return state;
}

// ---------------------------------------------------------------------------
// Aktiviteter för en viss månad
// ---------------------------------------------------------------------------

/**
 * Aktiviteter som är relevanta för en viss månad.
 *
 * Två lyssnare, eftersom ett ÅTERKOMMANDE event kan ha `startAt` långt
 * bakåt i tiden (ett event som började i mars har tillfällen i augusti).
 * En ren intervallfråga på startAt skulle missa dem helt:
 *   1. Engångsaktiviteter — filtrerade på månadens intervall.
 *   2. Återkommande moder-events — alla som startat före intervallets slut,
 *      expanderas sedan av lib/recurrence.ts vid rendering.
 */
export function useEventsForMonth(
  teamId: string | null | undefined,
  monthDate: Date
): ListenerState<EventDoc[]> {
  const [ranged, setRanged] = useState<ListenerState<EventDoc[]>>({ data: [], loading: true, error: null });
  const [recurring, setRecurring] = useState<ListenerState<EventDoc[]>>({ data: [], loading: true, error: null });

  // Primitiva värden som beroenden, annars startar lyssnaren om varje render.
  const year = monthDate.getFullYear();
  const month = monthDate.getMonth();

  useEffect(() => {
    if (!teamId) {
      setRanged({ data: [], loading: false, error: null });
      setRecurring({ data: [], loading: false, error: null });
      return;
    }

    // Marginal på en månad åt vardera håll, så aktiviteter i rutnätets
    // in-/utfyllnadsdagar också kommer med.
    const rangeStart = new Date(year, month - 1, 1);
    const rangeEnd = new Date(year, month + 2, 1);

    const rangedQuery = query(
      collection(db, `teams/${teamId}/events`),
      where("startAt", ">=", Timestamp.fromDate(rangeStart)),
      where("startAt", "<", Timestamp.fromDate(rangeEnd)),
      orderBy("startAt", "asc")
    );
    const unsubRanged = onSnapshot(
      rangedQuery,
      (snap) => setRanged({ data: snap.docs.map((d) => d.data() as EventDoc), loading: false, error: null }),
      (error) => setRanged({ data: [], loading: false, error })
    );

    const recurringQuery = query(
      collection(db, `teams/${teamId}/events`),
      where("recurrence", "!=", null),
      where("startAt", "<", Timestamp.fromDate(rangeEnd))
    );
    const unsubRecurring = onSnapshot(
      recurringQuery,
      (snap) => setRecurring({ data: snap.docs.map((d) => d.data() as EventDoc), loading: false, error: null }),
      (error) => setRecurring({ data: [], loading: false, error })
    );

    return () => {
      unsubRanged();
      unsubRecurring();
    };
  }, [teamId, year, month]);

  // Slå ihop och deduplicera — ett återkommande event vars startdatum
  // ligger inom intervallet fångas av båda frågorna.
  const data = useMemo(() => {
    const byId = new Map<string, EventDoc>();
    for (const event of [...ranged.data, ...recurring.data]) byId.set(event.id, event);
    return Array.from(byId.values());
  }, [ranged.data, recurring.data]);

  return {
    data,
    loading: ranged.loading || recurring.loading,
    error: ranged.error ?? recurring.error,
  };
}
