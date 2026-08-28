"use strict";
"use client";
Object.defineProperty(exports, "__esModule", { value: true });
exports.useTeam = useTeam;
exports.useChildren = useChildren;
exports.useCustodyCycle = useCustodyCycle;
exports.useDayBalance = useDayBalance;
exports.useApprovedShiftRequests = useApprovedShiftRequests;
exports.usePendingShiftRequests = usePendingShiftRequests;
exports.useAllShiftRequests = useAllShiftRequests;
exports.usePackLists = usePackLists;
exports.useNotes = useNotes;
exports.useTodos = useTodos;
exports.useChildInfo = useChildInfo;
exports.useChildAccounts = useChildAccounts;
exports.useChatMessages = useChatMessages;
exports.useEventsForMonth = useEventsForMonth;
const react_1 = require("react");
const firestore_1 = require("firebase/firestore");
const firebase_1 = require("../firebase");
// ---------------------------------------------------------------------------
// Team
// ---------------------------------------------------------------------------
function useTeam(teamId) {
    const [state, setState] = (0, react_1.useState)({
        data: null,
        loading: true,
        error: null,
    });
    (0, react_1.useEffect)(() => {
        if (!teamId) {
            setState({ data: null, loading: false, error: null });
            return;
        }
        const unsub = (0, firestore_1.onSnapshot)((0, firestore_1.doc)(firebase_1.db, "teams", teamId), (snap) => setState({ data: snap.exists() ? snap.data() : null, loading: false, error: null }), (error) => setState({ data: null, loading: false, error }));
        return unsub;
    }, [teamId]);
    return state;
}
// ---------------------------------------------------------------------------
// Barn
// ---------------------------------------------------------------------------
function useChildren(teamId) {
    const [state, setState] = (0, react_1.useState)({ data: [], loading: true, error: null });
    (0, react_1.useEffect)(() => {
        if (!teamId) {
            setState({ data: [], loading: false, error: null });
            return;
        }
        const unsub = (0, firestore_1.onSnapshot)((0, firestore_1.collection)(firebase_1.db, `teams/${teamId}/children`), (snap) => setState({ data: snap.docs.map((d) => d.data()), loading: false, error: null }), (error) => setState({ data: [], loading: false, error }));
        return unsub;
    }, [teamId]);
    return state;
}
// ---------------------------------------------------------------------------
// Boendecykel + ställning (singleton-dokument per barn)
// ---------------------------------------------------------------------------
function useCustodyCycle(teamId, childId) {
    const [state, setState] = (0, react_1.useState)({
        data: null,
        loading: true,
        error: null,
    });
    (0, react_1.useEffect)(() => {
        if (!teamId || !childId) {
            setState({ data: null, loading: false, error: null });
            return;
        }
        const unsub = (0, firestore_1.onSnapshot)((0, firestore_1.doc)(firebase_1.db, `teams/${teamId}/children/${childId}/custodyCycle/main`), (snap) => setState({ data: snap.exists() ? snap.data() : null, loading: false, error: null }), (error) => setState({ data: null, loading: false, error }));
        return unsub;
    }, [teamId, childId]);
    return state;
}
function useDayBalance(teamId, childId) {
    const [state, setState] = (0, react_1.useState)({
        data: null,
        loading: true,
        error: null,
    });
    (0, react_1.useEffect)(() => {
        if (!teamId || !childId) {
            setState({ data: null, loading: false, error: null });
            return;
        }
        const unsub = (0, firestore_1.onSnapshot)((0, firestore_1.doc)(firebase_1.db, `teams/${teamId}/children/${childId}/dayBalance/main`), (snap) => setState({ data: snap.exists() ? snap.data() : null, loading: false, error: null }), (error) => setState({ data: null, loading: false, error }));
        return unsub;
    }, [teamId, childId]);
    return state;
}
// ---------------------------------------------------------------------------
// Ansvarsbyten
// ---------------------------------------------------------------------------
/** Godkända byten — dessa ritas ovanpå den fasta cykeln i CalendarView. */
function useApprovedShiftRequests(teamId, childId) {
    return useShiftRequestsByStatus(teamId, childId, "approved");
}
/** Väntande förfrågningar — visas som notis/kort att godkänna eller avböja. */
function usePendingShiftRequests(teamId, childId) {
    return useShiftRequestsByStatus(teamId, childId, "pending");
}
/** Alla byten oavsett status — används av chatten för att slå upp länkade kort. */
function useAllShiftRequests(teamId) {
    const [state, setState] = (0, react_1.useState)({
        data: {},
        loading: true,
        error: null,
    });
    (0, react_1.useEffect)(() => {
        if (!teamId) {
            setState({ data: {}, loading: false, error: null });
            return;
        }
        const unsub = (0, firestore_1.onSnapshot)((0, firestore_1.collection)(firebase_1.db, `teams/${teamId}/shiftRequests`), (snap) => {
            const byId = {};
            for (const d of snap.docs)
                byId[d.id] = d.data();
            setState({ data: byId, loading: false, error: null });
        }, (error) => setState({ data: {}, loading: false, error }));
        return unsub;
    }, [teamId]);
    return state;
}
function useShiftRequestsByStatus(teamId, childId, status) {
    const [state, setState] = (0, react_1.useState)({ data: [], loading: true, error: null });
    (0, react_1.useEffect)(() => {
        if (!teamId || !childId) {
            setState({ data: [], loading: false, error: null });
            return;
        }
        // OBS: kräver ett sammansatt index (childId + status + startAt).
        // Firestore loggar en direktlänk för att skapa det första gången
        // frågan körs — lägg sedan in det i firestore.indexes.json.
        const q = (0, firestore_1.query)((0, firestore_1.collection)(firebase_1.db, `teams/${teamId}/shiftRequests`), (0, firestore_1.where)("childId", "==", childId), (0, firestore_1.where)("status", "==", status), (0, firestore_1.orderBy)("startAt", "asc"));
        const unsub = (0, firestore_1.onSnapshot)(q, (snap) => setState({ data: snap.docs.map((d) => d.data()), loading: false, error: null }), (error) => setState({ data: [], loading: false, error }));
        return unsub;
    }, [teamId, childId, status]);
    return state;
}
// ---------------------------------------------------------------------------
// Packlistor, anteckningar och todos
// ---------------------------------------------------------------------------
/** Packlistor för ett visst barn — knyts i UI:t till nästa byte. */
function usePackLists(teamId, childId) {
    const [state, setState] = (0, react_1.useState)({ data: [], loading: true, error: null });
    (0, react_1.useEffect)(() => {
        if (!teamId || !childId) {
            setState({ data: [], loading: false, error: null });
            return;
        }
        const q = (0, firestore_1.query)((0, firestore_1.collection)(firebase_1.db, `teams/${teamId}/packLists`), (0, firestore_1.where)("childId", "==", childId), (0, firestore_1.orderBy)("createdAt", "asc"));
        const unsub = (0, firestore_1.onSnapshot)(q, (snap) => setState({ data: snap.docs.map((d) => d.data()), loading: false, error: null }), (error) => setState({ data: [], loading: false, error }));
        return unsub;
    }, [teamId, childId]);
    return state;
}
function useNotes(teamId) {
    const [state, setState] = (0, react_1.useState)({ data: [], loading: true, error: null });
    (0, react_1.useEffect)(() => {
        if (!teamId) {
            setState({ data: [], loading: false, error: null });
            return;
        }
        const q = (0, firestore_1.query)((0, firestore_1.collection)(firebase_1.db, `teams/${teamId}/notes`), (0, firestore_1.orderBy)("updatedAt", "desc"));
        const unsub = (0, firestore_1.onSnapshot)(q, (snap) => setState({ data: snap.docs.map((d) => d.data()), loading: false, error: null }), (error) => setState({ data: [], loading: false, error }));
        return unsub;
    }, [teamId]);
    return state;
}
/** Todos. `archived` styr om avbockade uppgifter ligger kvar i listan. */
function useTodos(teamId, includeArchived = false) {
    const [state, setState] = (0, react_1.useState)({ data: [], loading: true, error: null });
    (0, react_1.useEffect)(() => {
        if (!teamId) {
            setState({ data: [], loading: false, error: null });
            return;
        }
        const base = (0, firestore_1.collection)(firebase_1.db, `teams/${teamId}/todos`);
        const q = includeArchived
            ? (0, firestore_1.query)(base, (0, firestore_1.orderBy)("createdAt", "desc"))
            : (0, firestore_1.query)(base, (0, firestore_1.where)("archived", "==", false), (0, firestore_1.orderBy)("createdAt", "desc"));
        const unsub = (0, firestore_1.onSnapshot)(q, (snap) => setState({ data: snap.docs.map((d) => d.data()), loading: false, error: null }), (error) => setState({ data: [], loading: false, error }));
        return unsub;
    }, [teamId, includeArchived]);
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
function useChildInfo(teamId, childId) {
    const [state, setState] = (0, react_1.useState)({
        data: null,
        loading: true,
        error: null,
    });
    (0, react_1.useEffect)(() => {
        if (!teamId || !childId) {
            setState({ data: null, loading: false, error: null });
            return;
        }
        const unsub = (0, firestore_1.onSnapshot)((0, firestore_1.doc)(firebase_1.db, `teams/${teamId}/children/${childId}/childInfo/main`), (snap) => setState({ data: snap.exists() ? snap.data() : null, loading: false, error: null }), (error) => setState({ data: null, loading: false, error }));
        return unsub;
    }, [teamId, childId]);
    return state;
}
/** Delade konton — streamingtjänster, PIN-koder osv. */
function useChildAccounts(teamId, childId) {
    const [state, setState] = (0, react_1.useState)({ data: [], loading: true, error: null });
    (0, react_1.useEffect)(() => {
        if (!teamId || !childId) {
            setState({ data: [], loading: false, error: null });
            return;
        }
        const unsub = (0, firestore_1.onSnapshot)((0, firestore_1.collection)(firebase_1.db, `teams/${teamId}/children/${childId}/accounts`), (snap) => setState({ data: snap.docs.map((d) => d.data()), loading: false, error: null }), (error) => setState({ data: [], loading: false, error }));
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
function useChatMessages(teamId, messageLimit = 100) {
    const [state, setState] = (0, react_1.useState)({ data: [], loading: true, error: null });
    (0, react_1.useEffect)(() => {
        if (!teamId) {
            setState({ data: [], loading: false, error: null });
            return;
        }
        const q = (0, firestore_1.query)((0, firestore_1.collection)(firebase_1.db, `teams/${teamId}/chatMessages`), (0, firestore_1.orderBy)("createdAt", "desc"), (0, firestore_1.limit)(messageLimit));
        const unsub = (0, firestore_1.onSnapshot)(q, (snap) => setState({
            data: snap.docs.map((d) => d.data()).reverse(),
            loading: false,
            error: null,
        }), (error) => setState({ data: [], loading: false, error }));
        return unsub;
    }, [teamId, messageLimit]);
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
function useEventsForMonth(teamId, monthDate) {
    const [ranged, setRanged] = (0, react_1.useState)({ data: [], loading: true, error: null });
    const [recurring, setRecurring] = (0, react_1.useState)({ data: [], loading: true, error: null });
    // Primitiva värden som beroenden, annars startar lyssnaren om varje render.
    const year = monthDate.getFullYear();
    const month = monthDate.getMonth();
    (0, react_1.useEffect)(() => {
        if (!teamId) {
            setRanged({ data: [], loading: false, error: null });
            setRecurring({ data: [], loading: false, error: null });
            return;
        }
        // Marginal på en månad åt vardera håll, så aktiviteter i rutnätets
        // in-/utfyllnadsdagar också kommer med.
        const rangeStart = new Date(year, month - 1, 1);
        const rangeEnd = new Date(year, month + 2, 1);
        const rangedQuery = (0, firestore_1.query)((0, firestore_1.collection)(firebase_1.db, `teams/${teamId}/events`), (0, firestore_1.where)("startAt", ">=", firestore_1.Timestamp.fromDate(rangeStart)), (0, firestore_1.where)("startAt", "<", firestore_1.Timestamp.fromDate(rangeEnd)), (0, firestore_1.orderBy)("startAt", "asc"));
        const unsubRanged = (0, firestore_1.onSnapshot)(rangedQuery, (snap) => setRanged({ data: snap.docs.map((d) => d.data()), loading: false, error: null }), (error) => setRanged({ data: [], loading: false, error }));
        const recurringQuery = (0, firestore_1.query)((0, firestore_1.collection)(firebase_1.db, `teams/${teamId}/events`), (0, firestore_1.where)("recurrence", "!=", null), (0, firestore_1.where)("startAt", "<", firestore_1.Timestamp.fromDate(rangeEnd)));
        const unsubRecurring = (0, firestore_1.onSnapshot)(recurringQuery, (snap) => setRecurring({ data: snap.docs.map((d) => d.data()), loading: false, error: null }), (error) => setRecurring({ data: [], loading: false, error }));
        return () => {
            unsubRanged();
            unsubRecurring();
        };
    }, [teamId, year, month]);
    // Slå ihop och deduplicera — ett återkommande event vars startdatum
    // ligger inom intervallet fångas av båda frågorna.
    const data = (0, react_1.useMemo)(() => {
        const byId = new Map();
        for (const event of [...ranged.data, ...recurring.data])
            byId.set(event.id, event);
        return Array.from(byId.values());
    }, [ranged.data, recurring.data]);
    return {
        data,
        loading: ranged.loading || recurring.loading,
        error: ranged.error ?? recurring.error,
    };
}
