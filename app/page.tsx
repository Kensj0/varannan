"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useAuth } from "../lib/auth/AuthProvider";
import {
  requestAndSavePushToken,
  ensurePushTokenRegistered,
  getPushPermissionState,
  listenForForegroundMessages,
  updateHandoffReminderPrefs,
} from "../lib/pushNotifications";
import {
  useTeam,
  useChildren,
  useChildrenByIds,
  useCustodyCycle,
  useDayBalance,
  useApprovedShiftRequests,
  usePendingShiftRequests,
  useStructureRequests,
  usePendingBalanceRequests,
  useAllShiftRequests,
  useEventsForMonth,
  useChatMessages,
  usePackLists,
  useNotes,
  useTodos,
  useChildInfo,
  useChildAccounts,
  useCalendarInvitesPendingApproval,
} from "../lib/hooks/useFirestore";
import { useMyCalendars } from "../lib/hooks/useMyCalendars";
import { MyCalendar } from "../lib/onboardingClient";
import {
  createEvent,
  deleteEvent,
  excludeEventOccurrence,
  respondToShiftRequest,
  respondToShiftRequestBatch,
  respondToStructureRequest,
  submitShiftChange,
  submitShiftChangeBatch,
  setScheduleChangeMode,
  clearApprovedShiftsFrom,
  proposeBalanceAdjustment,
  respondToBalanceAdjustment,
  atSwitchHour,
  addDays,
} from "../lib/calendarActions";
import { sendChatMessage } from "../lib/chatActions";
import {
  createPackList,
  deletePackList,
  addPackListItem,
  removePackListItem,
  renamePackList,
  markPackListSeen,
  createNote,
  updateNote,
  deleteNote,
  createTodo,
  toggleTodo,
  archiveTodo,
} from "../lib/listActions";
import { getNextOrdinaryHandoff } from "../lib/custodyCycle";
import {
  updateChildInfo,
  createChildAccount,
  updateChildAccount,
  deleteChildAccount,
} from "../lib/childInfoActions";
import dynamic from "next/dynamic";
import CalendarView from "../components/CalendarView";
import { ManagedCalendar } from "../components/CalendarManagerPanel";
import BottomNav, { AppSection } from "../components/BottomNav";
import SubTabs from "../components/SubTabs";
import BalanceCard from "../components/BalanceCard";
import PendingShiftRequests from "../components/PendingShiftRequests";
import PendingStructureRequests from "../components/PendingStructureRequests";
import PendingCalendarInvites from "../components/PendingCalendarInvites";
import { googleConnectResultMessage } from "../lib/googleCalendarClient";

/**
 * Vyer utanför den första skärmen (kalendern) laddas i egna chunkar och
 * hämtas först när fliken öppnas. Utan detta låg all deras kod — chatt,
 * listor, barninfo, inställningar, onboarding-byggaren — i samma bunt
 * som appen laddar innan något ritas. `ssr: false` är gratis här: hela
 * appen är redan en statisk klientexport.
 */
const loading = () => <Centered>Laddar…</Centered>;
const SettingsView = dynamic(() => import("../components/SettingsView"), { loading });
const CustodyCycleBuilder = dynamic(() => import("../components/onboarding/CustodyCycleBuilder"), { loading });
const ChatView = dynamic(() => import("../components/ChatView"), { loading });
const PackListView = dynamic(() => import("../components/PackListView"), { loading });
const NotesView = dynamic(() => import("../components/NotesView"), { loading });
const TodoView = dynamic(() => import("../components/TodoView"), { loading });
const ChildInfoView = dynamic(() => import("../components/ChildInfoView"), { loading });
const AccountsView = dynamic(() => import("../components/AccountsView"), { loading });
const CycleSetupScreen = dynamic(() => import("../components/onboarding/CycleSetupScreen"), { loading });
const EmptyCalendarState = dynamic(() => import("../components/EmptyCalendarState"), { loading });
import {
  createFamilyTeam,
  createInvite,
  addChild,
  renameChild,
  deleteChild,
  createCalendarInvite,
  respondToCalendarInvite,
  saveCustodyCycle,
  repairPendingPartner,
  deleteMyAccount,
} from "../lib/onboardingClient";
import {
  PENDING_PARTNER_ID,
  DEFAULT_HANDOFF_REMINDER_PREFS,
  parentColorHex,
  scheduleChangeModeFor,
  ParentColorId,
  ScheduleChangeMode,
  CalendarRole,
} from "../types/schema";
import {
  buildFeedLinks,
  getCalendarFeedTokens,
  createCalendarFeedToken,
  setCustomSwitchHour,
  updateParentColor,
  CalendarFeedLinks,
} from "../lib/calendarExport";



type ListSubTab = "packlist" | "notes" | "todo";
type InfoSubTab = "childinfo" | "accounts";

const LIST_SUB_TABS: { id: ListSubTab; label: string }[] = [
  { id: "packlist", label: "Packlista" },
  { id: "notes", label: "Notes" },
  { id: "todo", label: "Todo" },
];

const INFO_SUB_TABS: { id: InfoSubTab; label: string }[] = [
  { id: "childinfo", label: "Barninfo" },
  { id: "accounts", label: "Konton" },
];

export default function HomePage() {
  const { user, userDoc, signOutUser, resetPassword, updateDisplayName } = useAuth();

  // Push-notiser: fråga om lov och visa en banderoll om pushar som
  // kommer in medan fliken redan är öppen (då visar inte webbläsaren
  // en OS-notis själv, se lib/pushNotifications.ts).
  const [pushPermission, setPushPermission] = useState<
    "unsupported" | "default" | "granted" | "denied" | null
  >(null);
  const [pushToast, setPushToast] = useState<{ title: string; body: string } | null>(null);
  /** Fel efter att lov getts — t.ex. saknad VAPID-nyckel. */
  const [pushError, setPushError] = useState<string | null>(null);

  useEffect(() => {
    getPushPermissionState().then(setPushPermission);
    let unsubscribe: (() => void) | undefined;
    listenForForegroundMessages((title, body) => {
      setPushToast({ title, body });
      setTimeout(() => setPushToast(null), 5000);
    }).then((unsub) => {
      unsubscribe = unsub;
    });
    return () => unsubscribe?.();
  }, []);

  async function enablePushNotifications() {
    if (!user) return;
    const result = await requestAndSavePushToken(user.uid);
    setPushPermission(result.permission);
    setPushError(result.error ?? null);
  }

  // Lov kan vara givet utan att någon giltig token finns: nyckeln kan ha
  // saknats vid första försöket, eller så har token roterat sedan dess.
  // Utan det här stod det "notiser är på" medan ingenting kom fram.
  const hasPushToken = (userDoc?.fcmTokens?.length ?? 0) > 0;
  useEffect(() => {
    if (!user || pushPermission !== "granted" || hasPushToken) return;
    ensurePushTokenRegistered(user.uid).then((result) => {
      setPushError(result.ok ? null : result.reason ?? null);
    });
  }, [user, pushPermission, hasPushToken]);

  // Påminnelser om överlämning (dagen innan / samma dag) — sparas per
  // användare på users/{uid}, läses av den schemalagda Cloud Functionen.
  const reminderPrefs = userDoc?.handoffReminderPrefs ?? DEFAULT_HANDOFF_REMINDER_PREFS;
  async function handleUpdateReminderPrefs(prefs: { dayBefore: boolean; sameDay: boolean; email?: boolean }) {
    if (!user) return;
    await updateHandoffReminderPrefs(user.uid, prefs);
  }

  // Alla kalendrar (uid) är med på, i ALLA familjer — inklusive det egna
  // hemmateamet med roll "parent" (se getMyCalendars). Källan till "+"-
  // väljaren och till vilken roll man har på den kalender man tittar på.
  const { calendars: myCalendars, refresh: refreshMyCalendars } = useMyCalendars(user?.uid ?? null);
  const homeTeamId = userDoc?.teamId ?? null;
  const homeCalendar = useMemo(
    () => myCalendars?.find((c) => c.teamId === homeTeamId) ?? null,
    [myCalendars, homeTeamId]
  );
  // Uttrycklig växling via "+"-panelen — satt direkt till HELA objektet
  // vid klick (se handleSelectCalendar), aldrig till bara ett id: annars
  // måste vi vänta på att getMyCalendars slår upp samma kalender igen
  // innan namn/roll/föräldrar för en FRÄMMANDE kalender är kända.
  const [activeCalendarOverride, setActiveCalendarOverride] = useState<MyCalendar | null>(null);
  // Aktiv kalender: en uttrycklig växling > hemmateamet > första
  // kalendern man är med på (en ren anhörig/utomstående utan eget team,
  // ELLER ett konto vars users.teamId pekar på ett tomt "skal"-team utan
  // någon egen kalender ännu — homeCalendar blir då null trots att
  // homeTeamId är satt, och vi ska INTE fastna där). Väntar MEDVETET på
  // myCalendars (se laddningsspärren nedan) i stället för att gissa på
  // homeTeamId direkt — annars kan ett sånt skal-team felaktigt bli den
  // aktiva kalendern för en anhörig som råkar ha ett, se
  // docs/roller-och-medlemskap.md ("AuthGate-fixen").
  const activeCalendar: MyCalendar | null =
    activeCalendarOverride ?? homeCalendar ?? myCalendars?.[0] ?? null;
  const teamId = activeCalendar?.teamId ?? null;
  const myRole: CalendarRole = activeCalendar?.role ?? "parent";
  const isOwnTeam = teamId !== null && teamId === homeTeamId;

  // EN lyssnare på hemmateamet, oavsett vilken kalender som just nu är
  // aktiv — annars tappar Inställningar (bjud in andra föräldern,
  // team-namn) rätt data så fort man växlar till en främmande kalender.
  // `team` (nedan) är samma dokument när man tittar på sitt eget team,
  // annars null (ingen läsrätt till en främmande teams/{teamId} — se
  // firestore.rules, isTeamMember krävs).
  const { data: homeTeam } = useTeam(homeTeamId);
  const team = isOwnTeam ? homeTeam : null;
  // useChildren gör en OFILTRERAD listfråga över hela children-
  // kollektionen i teamet — firestore.rules NEKAR den i sin helhet för
  // en anhörig/utomstående (Firestore kan inte bevisa att ALLA barn i
  // ett främmande team uppfyller isCalendarParticipant utan en
  // matchande where(), bekräftat med regeltest). Ett riktigt
  // anhörig-konto fastnade därför i "lägg till barn" — se
  // docs/roller-och-medlemskap.md. På en FRÄMMANDE kalender används
  // useChildrenByIds i stället, begränsad till de id:n man faktiskt är
  // medlem på (från myCalendars, samma team) — en query Firestore KAN
  // bevisa säker.
  const foreignChildIds = useMemo(
    () => (!isOwnTeam && teamId ? (myCalendars ?? []).filter((c) => c.teamId === teamId).map((c) => c.childId) : []),
    [isOwnTeam, teamId, myCalendars]
  );
  const { data: ownTeamChildren, loading: ownTeamChildrenLoading } = useChildren(isOwnTeam ? teamId : null);
  const { data: foreignChildren, loading: foreignChildrenLoading } = useChildrenByIds(
    !isOwnTeam ? teamId : null,
    foreignChildIds
  );
  const children = isOwnTeam ? ownTeamChildren : foreignChildren;
  const childrenLoading = isOwnTeam ? ownTeamChildrenLoading : foreignChildrenLoading;

  const [selectedChildId, setSelectedChildId] = useState<string | null>(null);
  /**
   * Vilket barn Barninfo/Konton visar. Medvetet SKILT från vilken
   * kalender som är vald: barnets uppgifter hör till personen, inte till
   * schemat man råkar titta på, så att bläddra bland barnkorten ska inte
   * byta kalender under fötterna på en.
   */
  const [selectedInfoChildId, setSelectedInfoChildId] = useState<string | null>(null);
  const [monthDate, setMonthDate] = useState(() => new Date());
  const [section, setSection] = useState<AppSection>("calendar");

  // Google skickar tillbaka till /?google=connected|denied|scope|error
  // efter samtyckesfönstret (functions/src/googleCalendarSync.ts). Visa
  // beskedet i Inställningar och städa bort parametern ur adressen.
  const [googleResult, setGoogleResult] = useState<{ ok: boolean; text: string } | null>(null);
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const result = params.get("google");
    if (!result) return;
    const message = googleConnectResultMessage(result);
    if (message) {
      setGoogleResult(message);
      setSection("settings");
    }
    params.delete("google");
    const qs = params.toString();
    window.history.replaceState(null, "", window.location.pathname + (qs ? `?${qs}` : ""));
  }, []);
  const [listSubTab, setListSubTab] = useState<ListSubTab>("packlist");
  const [infoSubTab, setInfoSubTab] = useState<InfoSubTab>("childinfo");

  // Realtidslyssnarna för flikarna utanför kalendern (chatt, listor,
  // barninfo) öppnas först när fliken faktiskt besökts — och stängs inte
  // igen. Att prenumerera på allt direkt vid inloggning innebar ett
  // sjutal extra onSnapshot-kanaler plus en full läsning av hela
  // shiftRequests-kollektionen innan ens kalendern hunnit ritas.
  const [visitedSections, setVisitedSections] = useState<Set<AppSection>>(
    () => new Set<AppSection>(["calendar"])
  );
  useEffect(() => {
    setVisitedSections((prev) => (prev.has(section) ? prev : new Set(prev).add(section)));
  }, [section]);
  const chatVisited = visitedSections.has("chat");
  const listsVisited = visitedSections.has("lists");
  const infoVisited = visitedSections.has("info");

  // Vilka flikar rollen på DEN AKTIVA kalendern stänger av: viewer ser
  // bara Schema. relative saknar bara Chatt — Info (barninfo/konton) FÅR
  // hen se (Kenny 2026-09-26), bara inte redigera (se canEditInfo och
  // ChildInfoView/AccountsView-propparna nedan). BottomNav visar
  // avstängda flikar nedtonade och gör knapptrycket till en no-op —
  // se BottomNav.tsx.
  const disabledSections = useMemo<Set<AppSection>>(() => {
    if (myRole === "viewer") return new Set<AppSection>(["chat", "lists", "info"]);
    if (myRole === "relative") return new Set<AppSection>(["chat"]);
    return new Set<AppSection>();
  }, [myRole]);
  // Om man bläddrar med öppen Chatt/Info och sen växlar (via "+") till en
  // kalender där rollen inte längre får visa den fliken — hoppa tillbaka
  // till Schema i stället för att stå kvar på en flik man inte borde se.
  useEffect(() => {
    if (disabledSections.has(section)) setSection("calendar");
  }, [disabledSections, section]);

  // Välj första barnet automatiskt så fort listan laddats. På en
  // FRÄMMANDE kalender (isOwnTeam false) föredras activeCalendar.childId
  // framför children[0]: är en anhörig med på FLERA syskon i samma
  // familj kan de två listorna (myCalendars respektive children) komma i
  // olika ordning, och då måste barnet matcha den kalender man faktiskt
  // valt (aktiv roll/föräldranamn kommer från just den). På hemmateamet
  // är beteendet oförändrat — bara children[0] avgör, som innan.
  const activeChildId =
    selectedChildId ?? (!isOwnTeam ? activeCalendar?.childId : null) ?? children[0]?.id ?? null;
  // Kalendern ÄR barnet: barninfo, konton, listor och chatt visar samma
  // barn som schemat. Den tidigare uppdelningen (eget val i Barninfo)
  // är borttagen — den gjorde att man kunde titta på ett barns uppgifter
  // medan schemat visade ett annat.
  const activeInfoChildId = activeChildId;
  const activeInfoChild = children.find((c) => c.id === activeInfoChildId) ?? null;
  /** Äldre chatt/notes/todos saknar childId och hör hem på första kalendern. */
  const isFallbackCalendar = children.length > 0 && children[0]?.id === activeChildId;

  // Mitt eget läge styr hur den ANDRA får ändra mina dagar — det är det
  // jag ställer in. Motpartens läge styr vad JAG får göra, och avgör
  // därför om en ändring blir en förfrågan eller gäller direkt.
  const myScheduleChangeMode = scheduleChangeModeFor(team, user?.uid);



  async function handleSelectColor(colorId: ParentColorId) {
    if (!teamId) return;
    await updateParentColor(teamId, colorId);
  }

  /**
   * "+"-panelen listar `myCalendars` rakt av (se calendars-proppen till
   * CalendarView nedan), så den rad man klickar på finns garanterat kvar
   * däri — ingen väntan på ett nytt getMyCalendars-anrop krävs.
   */
  function handleSelectCalendar(calendar: { id: string; teamId: string }) {
    const match =
      myCalendars?.find((c) => c.teamId === calendar.teamId && c.childId === calendar.id) ?? null;
    setActiveCalendarOverride(match);
    setSelectedChildId(calendar.id);
  }

  async function handleCreateCalendar(name: string) {
    // En ren anhörig utan eget hemmateam har inget team att lägga
    // kalendern i än — skapa ett åt hen först. Blir automatiskt hens nya
    // hemmateam (users.teamId), med rollen "parent" där.
    const ownTeamId = homeTeamId ?? (await createFamilyTeam("Vårt schema")).teamId;
    const { childId } = await addChild(ownTeamId, name);
    // myCalendars (getMyCalendars) vet ännu inget om den HÄR nybakade
    // kalendern — den hämtas bara en gång, inte i realtid. Att sätta
    // activeCalendarOverride till null (lita på att homeTeamId/
    // homeCalendar löser det) lämnade ett glapp: teamId pekade kvar på
    // den FÖRRA aktiva kalendern (t.ex. en anhörig-kalender i en annan
    // familj) medan selectedChildId redan pekade på det NYA barnet —
    // activeChild hittades då aldrig, AddFirstChildScreen visades i
    // onödan, och DEN skärmens egna "Spara" pekade i sin tur mot FEL
    // team (permission-denied/403, eftersom man inte är förälder där).
    // En riktig anhörig-testanvändare hittade detta. Sätt därför
    // kalendern man just skapade DIREKT som aktiv, och uppdatera
    // myCalendars i bakgrunden så "+"-listan stämmer nästa gång den öppnas.
    setActiveCalendarOverride({
      teamId: ownTeamId,
      childId,
      childName: name,
      role: "parent",
      parentNames: { [user!.uid]: user?.displayName ?? "Du" },
      memberCount: 1,
    });
    setSelectedChildId(childId);
    refreshMyCalendars();
  }

  async function handleRenameCalendar(calendarId: string, name: string) {
    if (!homeTeamId) return;
    await renameChild(homeTeamId, calendarId, name);
    // myCalendars ("+"-listan) hämtas bara en gång, inte i realtid — utan
    // detta stod det gamla namnet kvar där tills sidan laddades om, trots
    // att kalenderns egen header (som lyssnar på children/{childId}
    // direkt) redan visade det nya.
    refreshMyCalendars();
  }

  async function handleInviteToCalendar(calendarId: string) {
    if (!homeTeamId) throw new Error("Inget team.");
    // Utan role blir det förälder-flödet, som alltid ger status "sent"
    // med en kod direkt — ingen godkännande-runda.
    const res = await createCalendarInvite(homeTeamId, calendarId);
    if (!res.shareUrl) throw new Error("Kunde inte skapa inbjudan.");
    return { shareUrl: res.shareUrl };
  }

  async function handleInviteRelative(
    calendarId: string,
    email: string,
    role: Exclude<CalendarRole, "parent">
  ) {
    if (!homeTeamId) throw new Error("Inget team.");
    const res = await createCalendarInvite(homeTeamId, calendarId, { role, invitedEmail: email });
    return { status: res.status };
  }

  async function handleRespondToCalendarInvite(code: string, decision: "approve" | "decline") {
    await respondToCalendarInvite(code, decision);
  }

  /**
   * Servern raderar all data (eller lämnar delade kalendrar, se
   * deleteMyAccount i functions/src/index.ts) och tar sist bort
   * Auth-kontot. Loggar ut lokalt direkt efteråt — AuthGate visar då
   * landningssidan, precis som för vem som helst utan session.
   */
  async function handleDeleteAccount() {
    await deleteMyAccount();
    await signOutUser();
  }

  /**
   * calendarTeamId är kalenderns EGET team — inte nödvändigtvis
   * homeTeamId, som en anhörig/utomstående saknar helt och en förälder
   * bara har för sitt EGET hemmateam (se ManagedCalendar.teamId,
   * CalendarManagerPanel). Fungerar för alla tre roller: servern
   * (deleteChild) avgör lämna vs. radera helt utifrån VEM som är kvar,
   * inte vilken roll den som lämnar hade.
   */
  async function handleDeleteCalendar(calendarTeamId: string, calendarId: string, confirmation: string) {
    await deleteChild(calendarTeamId, calendarId, confirmation);
    // Vyn kan stå på den kalender som just försvann — släpp valet så att
    // fallbacken (hemmateamet/första kalendern) tar över i stället för
    // att peka på ett dokument som inte finns.
    if (selectedChildId === calendarId) setSelectedChildId(null);
    if (selectedInfoChildId === calendarId) setSelectedInfoChildId(null);
    if (activeCalendarOverride?.teamId === calendarTeamId && activeCalendarOverride?.childId === calendarId) {
      setActiveCalendarOverride(null);
    }
    // myCalendars ("+"-listan) hämtas bara en gång, inte i realtid — utan
    // detta skulle den borttagna kalendern hänga kvar i listan tills
    // sidan laddas om.
    refreshMyCalendars();
  }

  async function handleAddInfoChild(name: string) {
    if (!teamId) return;
    const { childId } = await addChild(teamId, name);
    setSelectedInfoChildId(childId);
  }

  async function handleChangeScheduleChangeMode(mode: ScheduleChangeMode) {
    if (!teamId) return;
    await setScheduleChangeMode(teamId, mode);
  }

  async function handleChangeSwitchHour(hh: string, mm: string) {
    if (!teamId || !activeChildId) return;
    await setCustomSwitchHour(teamId, activeChildId, `${hh}:${mm}`);
  }
  const activeChild = children.find((c) => c.id === activeChildId) ?? null;

  // dayBalance/balanceRequests/childInfo/accounts kräver föräldraroll på
  // KALENDERN (firestore.rules: isParentOfCalendar) — en anhörig/
  // utomstående nekas alltid, så fråga inte alls (sparar en lyssnare som
  // bara skulle permission-denya, och BalanceCard/Barninfo göms ändå för
  // de rollerna nedan).
  const isParentHere = myRole === "parent";
  const { data: cycle } = useCustodyCycle(teamId, activeChildId);
  const { data: balance } = useDayBalance(isParentHere ? teamId : null, activeChildId);
  const { data: approvedShifts } = useApprovedShiftRequests(teamId, activeChildId);
  const { data: pendingShifts } = usePendingShiftRequests(teamId, activeChildId);
  const { data: structureRequests } = useStructureRequests(teamId, activeChildId);
  // teamInvites-listning kräver isTeamMember (hemmateamet), och bara en
  // förälder kan godkänna en väntande inbjudan.
  const { data: pendingCalendarInvites } = useCalendarInvitesPendingApproval(
    isOwnTeam && isParentHere ? teamId : null,
    activeChildId
  );
  const { data: pendingBalanceRequests } = usePendingBalanceRequests(isParentHere ? teamId : null, activeChildId);
  // En ofiltrerad listfråga (default nedan) nekas i sin helhet av
  // reglerna för en anhörig/utomstående på en FRÄMMANDE kalender — se
  // useNotes/useTodos nedan för samma resonemang. events saknar en egen
  // "strict"-flagga för month-frågan i sig, men strictChildId styr en
  // parallell, snävare fråga som fungerar utan isTeamMember.
  const { data: events } = useEventsForMonth(teamId, monthDate, !isOwnTeam ? activeChildId : null);
  // Chatten kräver isTeamMember (bara hemmateamet, se firestore.rules) —
  // fråga aldrig på en främmande kalender, oavsett besökt flik.
  const { data: allShiftRequests } = useAllShiftRequests(isOwnTeam && chatVisited ? teamId : null);
  const { data: chatMessages } = useChatMessages(
    isOwnTeam && chatVisited ? teamId : null,
    100,
    activeChildId,
    isFallbackCalendar
  );
  // Packlistor/anteckningar/todo: parent+relative, aldrig viewer (tabellen
  // i docs/roller-och-medlemskap.md) — en viewer som råkat besöka Listor
  // FÖRE en kalenderväxling ska inte fortsätta fråga (och få nekat) på
  // den nya, viewer-rollade kalendern.
  const canSeeLists = myRole !== "viewer";
  const { data: packLists } = usePackLists(listsVisited && canSeeLists ? teamId : null, activeChildId);
  const { data: notes } = useNotes(
    listsVisited && canSeeLists ? teamId : null,
    activeChildId,
    isFallbackCalendar,
    !isOwnTeam
  );
  const { data: todos } = useTodos(
    listsVisited && canSeeLists ? teamId : null,
    false,
    activeChildId,
    isFallbackCalendar,
    !isOwnTeam
  );
  // Barninfo/konton: parent+relative läser (canViewCalendarContent),
  // aldrig viewer — samma "canSeeLists"-princip som ovan, men bara en
  // förälder får REDIGERA (se canEditInfo, skickas till
  // ChildInfoView/AccountsView nedan).
  const { data: childInfo } = useChildInfo(canSeeLists ? teamId : null, activeInfoChildId);
  const { data: childAccounts } = useChildAccounts(canSeeLists ? teamId : null, activeInfoChildId);
  const canEditInfo = isParentHere;

  // Förälder-metadata. På hemmateamet från teamets cachade profiler
  // (users/{uid} är bara läsbart för ägaren själv, därför ligger namnen
  // i team-dokumentet). På en FRÄMMANDE kalender har vi ingen läsrätt
  // till teams/{teamId} alls (isTeamMember krävs) — där används i
  // stället parentNames som getMyCalendars redan levererar (Admin SDK,
  // kringgår den spärren server-sidan), med en deterministisk
  // platshållarfärg (samma fallback som redan används för en ej ansluten
  // partner — bara kosmetiskt, ingen extra data behövs).
  const parents = useMemo(() => {
    if (!isOwnTeam) {
      const ids = activeCalendar ? Object.keys(activeCalendar.parentNames) : [];
      const real = ids.map((id, i) => ({
        id,
        name: activeCalendar!.parentNames[id] ?? "Förälder",
        color: parentColorHex(undefined, i),
      }));
      if (real.length < 2) {
        real.push({
          id: PENDING_PARTNER_ID,
          name: "Väntar på inbjudan",
          color: parentColorHex(undefined, real.length),
        });
      }
      return real;
    }
    const ids = team?.parentIds ?? [];
    const real = ids.map((id, i) => ({
      id,
      name:
        team?.parentProfiles?.[id]?.displayName ??
        (id === user?.uid ? user?.displayName ?? "Du" : "Andra föräldern"),
      color: parentColorHex(team?.parentProfiles?.[id]?.colorId, i),
    }));
    // Andra föräldern har inte anslutit än — fyll ut med en platshållare
    // så resten av vyn (färger, "otherParentId" m.m.) alltid kan anta att
    // det finns två poster, utan att blockera appen tills hen bjudits in.
    if (real.length < 2) {
      real.push({
        id: PENDING_PARTNER_ID,
        name: "Väntar på inbjudan",
        color: parentColorHex(undefined, real.length),
      });
    }
    return real;
  }, [isOwnTeam, activeCalendar, team, user]);

  // Självläkning: team som anslöts innan listChildIds-buggen fixades har
  // kvar PENDING_PARTNER_ID i schemat, vilket gör att kalendern visar EN
  // förälder på alla dagar. Byt ut den mot partnerns riktiga uid en gång.
  const repairAttempted = useRef(false);
  const [editingStructure, setEditingStructure] = useState(false);
  // Efter att grundschemat sparats: fråga vad som ska hända med godkända
  // avvikelser framåt. De beskriver undantag från ett schema som inte
  // längre gäller, så att behålla dem är ett aktivt val — inte en default.
  const [pendingCycleChange, setPendingCycleChange] = useState<{
    fromDate: string;
    affected: number;
  } | null>(null);
  useEffect(() => {
    if (repairAttempted.current) return;
    if (!teamId || !cycle) return;
    if ((team?.parentIds?.length ?? 0) < 2) return;
    if (!cycle.blocks?.some((b) => b.parentId === PENDING_PARTNER_ID)) return;

    repairAttempted.current = true;
    repairPendingPartner(teamId).catch((err) => {
      console.error("[repairPendingPartner] misslyckades:", err);
    });
  }, [teamId, cycle, team]);

  // Prenumerationslänkarna (ICS) — två stycken, en per förälder. Hämtas lat
  // bara när teamet, barnet och den andra föräldern är kända.
  const [feedLinks, setFeedLinks] = useState<Record<string, CalendarFeedLinks> | null>(null);
  // Tokens sparas separat: samma token kan bygga flera flöden med olika
  // omfattning (mina dagar / den andres dagar), vilket krävs för att kunna
  // ge dem var sin färg i Google Kalender.
  const [feedTokens, setFeedTokens] = useState<Record<string, string> | null>(null);
  useEffect(() => {
    // ICS-länkarna hör till kugghjulet (CalendarSettingsPanel), som bara
    // renderas för parent (se CalendarView.tsx) — fråga aldrig annars.
    if (!isParentHere || !teamId || !activeChildId || !parents[1]?.id) return;
    let cancelled = false;
    getCalendarFeedTokens(teamId, activeChildId)
      .then((tokens) => {
        if (cancelled) return;
        const links: Record<string, CalendarFeedLinks> = {};
        for (const [parentId, token] of Object.entries(tokens)) {
          links[parentId] = buildFeedLinks(teamId, activeChildId, parentId, token);
        }
        setFeedTokens(tokens);
        setFeedLinks(links);
      })
      .catch(() => {
        /* saknad länk är inget fel — knappen visas istället */
      });
    return () => {
      cancelled = true;
    };
  }, [isParentHere, teamId, activeChildId, parents]);

  async function handleCreateFeed() {
    if (!isParentHere || !teamId || !activeChildId || !parents[1]?.id) return;
    const tokens = await createCalendarFeedToken(teamId, activeChildId);
    const links: Record<string, CalendarFeedLinks> = {};
    for (const [parentId, token] of Object.entries(tokens)) {
      links[parentId] = buildFeedLinks(teamId, activeChildId, parentId, token);
    }
    setFeedTokens(tokens);
    setFeedLinks(links);
  }
  const parentNames = useMemo(
    () => Object.fromEntries(parents.map((p) => [p.id, p.name])),
    [parents]
  );

  /** Delad mellan CalendarView (aktiv kalender) och EmptyCalendarState (ingen alls). */
  const calendarRows: ManagedCalendar[] = useMemo(
    () =>
      (myCalendars ?? []).map((c) => ({
        id: c.childId,
        teamId: c.teamId,
        name: c.childName,
        memberCount: c.memberCount,
        role: c.role,
      })),
    [myCalendars]
  );

  // Väntar ALLTID in getMyCalendars innan aktiv kalender avgörs — även
  // för ett konto med users.teamId satt. Ett tidigare försök att gissa
  // "parent på hemmateamet" direkt (utan att vänta) för att undvika en
  // extra laddningsblinkning visade sig fel för ett konto vars
  // hemmateam är ett tomt skal utan egen kalender: det låste fast på
  // det tomma teamet i stället för att falla vidare till den riktiga
  // anhörig-kalendern (se activeCalendar ovan). Kostar en kort
  // laddningsskärm extra för alla — värt det för att aldrig fastna.
  if (myCalendars === null || childrenLoading) {
    return <Centered>Laddar…</Centered>;
  }

  // Ingen aktiv kalender — antingen mitt i den allra första onboardingen
  // (team skapat, inget barn än) eller efter att ha lämnat/raderat sin
  // sista kalender (handleDeleteCalendar). Samma app-skal som resten av
  // sidan i stället för en särskild onboardingskärm, se
  // EmptyCalendarState och docs/roller-och-medlemskap.md (Kenny
  // 2026-09-27).
  if (!activeChild) {
    return (
      <EmptyCalendarState
        calendars={calendarRows}
        onSelectCalendar={handleSelectCalendar}
        onCreateCalendar={handleCreateCalendar}
        onRenameCalendar={handleRenameCalendar}
        onDeleteCalendar={handleDeleteCalendar}
        onInviteToCalendar={handleInviteToCalendar}
        onInviteRelative={handleInviteRelative}
        onSignOut={signOutUser}
      />
    );
  }

  // Schemat kan sättas upp solo, innan andra föräldern anslutit — de block
  // som tillhör hen pekar då tillfälligt på platshållaren PENDING_PARTNER_ID.
  // Den ersätts automatiskt med partnerns riktiga uid när inbjudan
  // accepteras, så detta steg får INTE vänta på att parents.length === 2.
  // Uppföljningsfrågan efter att grundschemat gjorts om. Ligger före
  // editingStructure-grenen så att den visas när byggaren stängts.
  if (pendingCycleChange && activeChild) {
    const { fromDate, affected } = pendingCycleChange;
    return (
      <div className="mx-auto flex min-h-screen max-w-sm flex-col justify-center px-6">
        <h1 className="mb-2 text-2xl font-bold text-stone-800">Grundschemat är sparat</h1>
        <p className="mb-6 text-stone-500">
          Det finns {affected} godkänd{affected === 1 ? "" : "a"} ändring
          {affected === 1 ? "" : "ar"} från och med {fromDate}. De gjordes mot det gamla schemat — vill du
          behålla dem?
        </p>

        <button
          onClick={() => setPendingCycleChange(null)}
          className="mb-3 w-full rounded-2xl bg-white p-4 text-left shadow-sm"
        >
          <span className="block font-semibold text-stone-800">Behåll dem</span>
          <span className="mt-1 block text-sm text-stone-500">
            Dagarna ligger kvar som undantag ovanpå det nya schemat, och ställningen är oförändrad.
          </span>
        </button>

        <button
          onClick={async () => {
            try {
              await clearApprovedShiftsFrom({
                teamId: teamId!,
                childId: activeChild.id,
                fromDate,
              });
            } catch (err) {
              console.error("[clearApprovedShiftsFrom] misslyckades:", err);
            } finally {
              setPendingCycleChange(null);
            }
          }}
          className="mb-4 w-full rounded-2xl bg-white p-4 text-left shadow-sm"
        >
          <span className="block font-semibold text-stone-800">Ta bort dem</span>
          <span className="mt-1 block text-sm text-stone-500">
            Schemat följer det nya mönstret rakt av. Ställningen justeras tillbaka med lika mycket som
            ändringarna gav. Dagar som redan passerat rörs inte.
          </span>
        </button>
      </div>
    );
  }

  // "Ändra grundschema" från Inställningar. Samma byggare som i
  // onboarding, men förifylld med nuvarande cykel. Bara custodyCycle
  // skrivs om — aktiviteter och godkända bytesdagar ligger i egna
  // dokument och rörs inte.
  if (editingStructure && activeChild && cycle) {
    const self = parents[0] ?? {
      id: user!.uid,
      name: user?.displayName ?? "Du",
      color: parentColorHex(undefined, 0),
    };
    const partner = parents[1] ?? {
      id: PENDING_PARTNER_ID,
      name: "Andra föräldern",
      color: parentColorHex(undefined, 1),
    };
    return (
      <div className="mx-auto max-w-md px-4 py-6">
        <h1 className="mb-1 text-2xl font-bold text-stone-800">Ändra grundschema</h1>
        <p className="mb-6 text-sm text-stone-500">
          Aktiviteter och godkända bytesdagar påverkas inte.
        </p>
        <CustodyCycleBuilder
          childName={activeChild.name}
          parents={[
            { id: self.id, name: self.name, color: self.color },
            { id: partner.id, name: partner.name, color: partner.color },
          ]}
          initialBlocks={cycle.blocks}
          initialStartDate={cycle.cycleStartDate}
          initialSwitchHour={cycle.switchHour}
          submitLabel="Spara ändringar"
          onCancel={() => setEditingStructure(false)}
          onSave={async (blocks, cycleStartDate, switchHour) => {
            await saveCustodyCycle({
              teamId: teamId!,
              childId: activeChild.id,
              blocks,
              cycleStartDate,
              switchHour,
              referenceParentId: self.id,
            });
            setEditingStructure(false);

            // Fråga bara när det finns något att ta ställning till.
            const cutoff = new Date(`${cycleStartDate}T00:00:00`).getTime();
            const affected = approvedShifts.filter(
              (r) => r.startAt.seconds * 1000 >= cutoff
            ).length;
            if (affected > 0) {
              setPendingCycleChange({ fromDate: cycleStartDate, affected });
            }
          }}
        />
      </div>
    );
  }

  if (!cycle) {
    const self = parents[0] ?? {
      id: user!.uid,
      name: user?.displayName ?? "Du",
      color: parentColorHex(undefined, 0),
    };
    const partner = parents[1] ?? {
      id: PENDING_PARTNER_ID,
      name: "Andra föräldern",
      color: parentColorHex(undefined, 1),
    };
    return (
      <CycleSetupScreen
        childName={activeChild.name}
        parents={[
          { id: self.id, name: self.name, color: self.color },
          { id: partner.id, name: partner.name, color: partner.color },
        ]}
        onSave={async (blocks, cycleStartDate, switchHour) => {
          await saveCustodyCycle({
            teamId: teamId!,
            childId: activeChild.id,
            blocks,
            cycleStartDate,
            switchHour,
            referenceParentId: self.id,
          });
        }}
      />
    );
  }

  // Andra föräldern kanske inte anslutit än — schemat och kalendern
  // fungerar redan (mot platshållaren), så det blockerar inte längre.
  // En banner högst upp låter en bjuda in när man vill istället.
  // Gäller den AKTIVA kalendern (styr "ändra grundschema"-tillgänglighet
  // nedan) — hemmateamets egen status (Inställningar-bannern "bjud in
  // andra föräldern") är en annan fråga, se homeHasPartner.
  const hasPartner = (team?.parentIds?.length ?? 0) >= 2;
  // Ingen hemmakalender alls (en ren anhörig/utomstående) → ingenting att
  // bjuda in någon till, så bannern ska aldrig visas för det kontot.
  const homeHasPartner = !homeTeamId || (homeTeam?.parentIds?.length ?? 0) >= 2;

  const otherParentId = parents.find((p) => p.id !== balance?.referenceParentId)?.id ?? parents[1].id;

  // Vem som avgör om en dagändring gäller direkt eller blir en förfrågan:
  // MOTPARTEN till den som gör ändringen — den som annars skulle godkänna.
  // Det är alltid "den andra än jag", oavsett vem ställningen är signerad
  // mot. Skilt från otherParentId ovan ("andra sidan av ställningen"),
  // som bara sammanfaller med det här när referensföräldern gör ändringen.
  // applyScheduleChangeDirect på servern gör exakt samma val (id !== uid);
  // matchar de inte får klienten 400 failed-precondition.
  const counterpartId =
    parents.find((p) => p.id !== user?.uid && p.id !== PENDING_PARTNER_ID)?.id ?? otherParentId;

  // Etapp 4 (docs/roller-och-medlemskap.md): en anhörigs "Ändra ansvar"
  // kräver BÅDA föräldrarnas ja. De riktiga föräldra-id:na, oavsett vem
  // som råkar vara inloggad — servern (approveShiftRequest) räknar ändå
  // ut samma lista själv vid godkännande, det här är bara vad klienten
  // stämplar som progressindikator vid skapandet.
  const realParentIds = parents.filter((p) => p.id !== PENDING_PARTNER_ID).map((p) => p.id);

  // Godkända dagar där en anhörig/utomstående SJÄLV haft ansvaret —
  // målar aldrig om dagens färg (se filtreringen på
  // approvedShiftRequests/pendingShiftRequests nedan), men visas som en
  // egen tagg ("Hos {namn}") i CalendarView. Namnet kommer från
  // child.members[uid].displayName, cachat av acceptCalendarInvite
  // eftersom en anhörig saknar users.teamId (ingen annan plats
  // föräldrarna redan har läsrätt till).
  const custodyTags = approvedShifts
    .filter((r) => !realParentIds.includes(r.takingOverParentId))
    .map((r) => ({
      date: new Date(r.startAt.seconds * 1000),
      label: activeChild.members?.[r.takingOverParentId]?.displayName ?? "Anhörig",
    }));

  /** uid -> visningsnamn för anhöriga/utomstående, till PendingShiftRequests. */
  const relativeNames: Record<string, string> = Object.fromEntries(
    Object.entries(activeChild.members ?? {})
      .filter(([, m]) => m.displayName)
      .map(([uid, m]) => [uid, m.displayName!])
  );

  // Barnväljaren visas bara när det faktiskt finns flera barn — annars
  // äter den höjd i onödan. Övriga rubriker är borttagna: månad och
  // barnets namn står redan i kalenderns egen header.
  //
  // Bara för Listor: kalendern har sin egen väljare i inställnings-
  // panelen och Barninfo bläddrar mellan barnkort, så där skulle chipsen
  // bli ett andra, konkurrerande sätt att välja samma sak.
  const showChildChips = children.length > 1 && section === "lists";

  return (
    <div className="fixed inset-0 flex flex-col bg-stone-50">
      {pushToast && (
        <div className="fixed left-1/2 top-3 z-50 w-[calc(100%-2rem)] max-w-sm -translate-x-1/2 rounded-xl bg-stone-800 px-4 py-3 text-white shadow-lg">
          <p className="text-sm font-semibold">{pushToast.title}</p>
          <p className="text-xs text-stone-300">{pushToast.body}</p>
        </div>
      )}

      <div className="mx-auto flex w-full max-w-md flex-1 flex-col overflow-hidden">
        {showChildChips && (
          <div className="flex shrink-0 gap-2 overflow-x-auto px-4 pt-3">
            {children.map((child) => (
              <button
                key={child.id}
                onClick={() => setSelectedChildId(child.id)}
                className={`whitespace-nowrap rounded-full px-3 py-1 text-xs font-medium ${
                  child.id === activeChildId ? "bg-rose-500 text-white" : "bg-white text-stone-600"
                }`}
              >
                {child.name}
              </button>
            ))}
          </div>
        )}

        {section === "chat" ? (
          <div className="flex flex-1 flex-col overflow-hidden px-4 py-3">
            <ChatView
              messages={chatMessages}
              currentUserId={user!.uid}
              parentNames={parentNames}
              shiftRequestsById={allShiftRequests}
              childName={activeChild.name}
              onSend={async (text) => {
                await sendChatMessage({
                  teamId: teamId!,
                  childId: activeChild.id,
                  senderId: user!.uid,
                  text,
                });
              }}
            />
          </div>
        ) : (
          <div className="flex-1 overflow-y-auto px-4 py-3">
            {section === "lists" && (
              <>
                <SubTabs tabs={LIST_SUB_TABS} active={listSubTab} onChange={(id) => setListSubTab(id as ListSubTab)} />

                {listSubTab === "packlist" && (
                  <PackListView
                    lists={packLists}
                    currentUserId={user!.uid}
                    parentNames={parentNames}
                    childName={activeChild.name}
                    nextOrdinaryHandoff={getNextOrdinaryHandoff(cycle, new Date())}
                    onCreateList={async (title) => {
                      await createPackList({
                        teamId: teamId!,
                        childId: activeChild.id,
                        title,
                        createdBy: user!.uid,
                      });
                    }}
                    onAddItem={(list, name) => addPackListItem(teamId!, list, name)}
                    onRemoveItem={(list, itemId) => removePackListItem(teamId!, list, itemId)}
                    onRenameList={(listId, title) => renamePackList(teamId!, listId, title)}
                    onMarkSeen={(listId) => markPackListSeen(teamId!, listId, user!.uid)}
                    onDeleteList={(listId) => deletePackList(teamId!, listId)}
                  />
                )}

                {listSubTab === "notes" && (
                  <NotesView
                    notes={notes}
                    parentNames={parentNames}
                    onCreate={async (title, content) => {
                      await createNote({
                        teamId: teamId!,
                        childId: activeChild.id,
                        title,
                        content,
                        createdBy: user!.uid,
                      });
                    }}
                    onUpdate={(noteId, patch) => updateNote(teamId!, noteId, patch)}
                    onDelete={(noteId) => deleteNote(teamId!, noteId)}
                  />
                )}

                {listSubTab === "todo" && (
                  <TodoView
                    todos={todos}
                    currentUserId={user!.uid}
                    parentNames={parentNames}
                    onCreate={async (title) => {
                      await createTodo({
                        teamId: teamId!,
                        childId: activeChild.id,
                        title,
                        createdBy: user!.uid,
                      });
                    }}
                    onToggle={(todo) => toggleTodo(teamId!, todo, user!.uid)}
                    onArchive={(todoId) => archiveTodo(teamId!, todoId)}
                  />
                )}
              </>
            )}

            {section === "info" && (
              <>
                <SubTabs tabs={INFO_SUB_TABS} active={infoSubTab} onChange={(id) => setInfoSubTab(id as InfoSubTab)} />

                {infoSubTab === "childinfo" && (
                  <ChildInfoView
                    childList={children.map((c) => ({ id: c.id, name: c.name }))}
                    activeChildId={activeInfoChild!.id}
                    onSelectChild={setSelectedChildId}
                    onAddChild={handleCreateCalendar}
                    info={childInfo}
                    onSave={(patch) =>
                      updateChildInfo(teamId!, activeInfoChild!.id, patch, user!.uid)
                    }
                    readOnly={!canEditInfo}
                  />
                )}

                {infoSubTab === "accounts" && (
                  <AccountsView
                    accounts={childAccounts}
                    parentNames={parentNames}
                    onCreate={async (service, username, pinOrNote) => {
                      await createChildAccount({
                        teamId: teamId!,
                        childId: activeInfoChild!.id,
                        service,
                        username,
                        pinOrNote,
                        addedBy: user!.uid,
                      });
                    }}
                    onUpdate={(accountId, patch) =>
                      updateChildAccount(teamId!, activeInfoChild!.id, accountId, patch)
                    }
                    onDelete={(accountId) => deleteChildAccount(teamId!, activeInfoChild!.id, accountId)}
                    readOnly={!canEditInfo}
                  />
                )}
              </>
            )}

            {section === "settings" && (
              <SettingsView
                displayName={user?.displayName ?? "Du"}
                email={user?.email ?? null}
                onResetPassword={resetPassword}
                onSignOut={signOutUser}
                pushPermission={pushPermission}
                onEnablePush={enablePushNotifications}
                pushRegistered={hasPushToken}
                pushError={pushError}
                hasPartner={homeHasPartner}
                teamName={homeTeam?.name}
                onCreateInvite={() => createInvite(homeTeamId!)}
                onUpdateDisplayName={updateDisplayName}
                onDeleteAccount={handleDeleteAccount}
                googleCalendar={userDoc?.googleCalendar}
                googleResultMessage={googleResult}
                reminderPrefs={reminderPrefs}
                onUpdateReminderPrefs={handleUpdateReminderPrefs}
              />
            )}

            {section === "calendar" && (
              <>
                {balance && (
                  <div className="mb-3">
                    <BalanceCard
                      balance={balance}
                      parentNames={parentNames}
                      otherParentId={otherParentId}
                      currentUserId={user!.uid}
                      pendingRequests={pendingBalanceRequests}
                      onPropose={async (deltaDays) => {
                        await proposeBalanceAdjustment({
                          teamId: teamId!,
                          childId: activeChild.id,
                          deltaDays,
                        });
                      }}
                      onRespond={async (requestId, decision) => {
                        await respondToBalanceAdjustment({
                          teamId: teamId!,
                          childId: activeChild.id,
                          requestId,
                          decision,
                        });
                      }}
                    />
                  </div>
                )}

                <PendingStructureRequests
                  requests={structureRequests}
                  currentUserId={user!.uid}
                  otherParentName={parentNames[counterpartId] ?? "Andra föräldern"}
                  onRespond={async (requestId, decision) => {
                    await respondToStructureRequest({ teamId: teamId!, requestId, decision });
                  }}
                />

                <PendingCalendarInvites
                  invites={pendingCalendarInvites}
                  currentUserId={user!.uid}
                  childName={activeChild.name}
                  onRespond={handleRespondToCalendarInvite}
                />

                {pendingShifts.length > 0 && (
                  <div className="mb-4">
                    <PendingShiftRequests
                      requests={pendingShifts}
                      currentUserId={user!.uid}
                      parentNames={parentNames}
                      relativeNames={relativeNames}
                      childName={activeChild.name}
                      onRespond={async (shiftRequestId, decision) => {
                        await respondToShiftRequest({
                          teamId: teamId!,
                          childId: activeChild.id,
                          shiftRequestId,
                          decision,
                        });
                      }}
                      onShowInCalendar={(date) =>
                        setMonthDate(new Date(date.getFullYear(), date.getMonth(), 1))
                      }
                      onRespondBatch={async (batchId, decision) => {
                        await respondToShiftRequestBatch({
                          teamId: teamId!,
                          childId: activeChild.id,
                          batchId,
                          decision,
                        });
                      }}
                    />
                  </div>
                )}

                <CalendarView
                  monthDate={monthDate}
                  onChangeMonth={setMonthDate}
                  teamId={teamId!}
                  childId={activeChild.id}
                  childName={activeChild.name}
                  cycle={cycle}
                  parents={[parents[0], parents[1]]}
                  // En anhörigs egen custody-dag (takingOverParentId är
                  // hens uid, inte en av de två riktiga föräldrarna) ska
                  // INTE måla om dagens färg i kalendern — den stannar på
                  // ordinarie schemalagd förälder (Kenny 2026-09-26).
                  // PendingShiftRequests-bannern nedan använder fortfarande
                  // OFILTRERADE pendingShifts, så den fortsätter visa och
                  // låta föräldrarna godkänna/avböja dem som vanligt.
                  approvedShiftRequests={approvedShifts.filter((r) => realParentIds.includes(r.takingOverParentId))}
                  pendingShiftRequests={pendingShifts.filter((r) => realParentIds.includes(r.takingOverParentId))}
                  custodyTags={custodyTags}
                  events={events.filter((e) => !e.childId || e.childId === activeChild.id)}
                  currentUserId={user!.uid}
                  onCreateActivity={async (date, title, recurring) => {
                    // Aktiviteten läggs kl 13:00–14:00 som standard, samma
                    // förval som i originalappens "Ny aktivitet"-dialog.
                    const startAt = new Date(date);
                    startAt.setHours(13, 0, 0, 0);
                    const endAt = new Date(startAt.getTime() + 60 * 60 * 1000);

                    await createEvent({
                      teamId: teamId!,
                      childId: activeChild.id,
                      title: title || "Ny aktivitet",
                      startAt,
                      endAt,
                      recurrence: recurring
                        ? { frequency: "weekly", interval: 1, byWeekday: [startAt.getDay()] }
                        : undefined,
                      createdBy: user!.uid,
                    });
                  }}
                  onDeleteActivity={async (occurrence, scope) => {
                    // "Bara den här gången" lagras som ett undantag på
                    // serien; "alla tillfällen" raderar hela aktiviteten.
                    if (scope === "occurrence") {
                      await excludeEventOccurrence({
                        teamId: teamId!,
                        eventId: occurrence.eventId,
                        occurrenceStart: occurrence.startAt,
                      });
                    } else {
                      await deleteEvent({ teamId: teamId!, eventId: occurrence.eventId });
                    }
                  }}
                  onProposeShift={async (date, takingOverParentId) => {
                    // Bytet sker vid schemats bytestid, inte midnatt.
                    const startAt = atSwitchHour(date, cycle.switchHour);
                    await submitShiftChange({
                      teamId: teamId!,
                      childId: activeChild.id,
                      requestedBy: user!.uid,
                      takingOverParentId,
                      startAt,
                      // "Ändra ansvar" (dagklicket) gäller ALLTID exakt ETT
                      // dygn: från bytestiden den valda dagen till bytestiden
                      // NÄSTA dag — aldrig längre, oavsett var nästa ORDINARIE
                      // byte råkar ligga i cykeln. Band tidigare till
                      // getNextOrdinaryHandoff, vilket gav en förvirrande och
                      // FEL förhandsvisning ("Livia fortsätter till 5 okt")
                      // och drog ställningen för flera dagar när det ordinarie
                      // blocket var längre än ett dygn — en riktig
                      // användartest hittade detta. Kalenderns ändringsläge
                      // (submitShiftChangeBatch) gör redan exakt samma sak
                      // per målad dag.
                      endAt: atSwitchHour(addDays(date, 1), cycle.switchHour),
                      mode: isParentHere ? scheduleChangeModeFor(team, counterpartId) : "request",
                      requiredApprovers: isParentHere ? undefined : realParentIds,
                    });
                  }}
                  onProposeShiftBatch={async (changes) => {
                    // Bulk-ändringsläget (pennan) är parent-only i
                    // CalendarView, så requiredApprovers hör inte hemma
                    // här i praktiken — men skickas ändå med av samma
                    // härdningsskäl om det någonsin blir nåbart.
                    await submitShiftChangeBatch({
                      teamId: teamId!,
                      childId: activeChild.id,
                      requestedBy: user!.uid,
                      switchHour: cycle.switchHour,
                      changes,
                      mode: isParentHere ? scheduleChangeModeFor(team, counterpartId) : "request",
                      requiredApprovers: isParentHere ? undefined : realParentIds,
                    });
                  }}
                  pushPermission={pushPermission}
                  onEnablePush={enablePushNotifications}
                  reminderPrefs={reminderPrefs}
                  onUpdateReminderPrefs={handleUpdateReminderPrefs}
                  myColorId={team?.parentProfiles?.[user!.uid]?.colorId}
                  onSelectColor={handleSelectColor}
                  otherParentColorHex={
                    (parents.find((p) => p.id !== user!.uid) ?? parents[1]).color
                  }
                  feedLinks={
                    feedTokens?.[user!.uid] && teamId && activeChild
                      ? buildFeedLinks(teamId, activeChild.id, user!.uid, feedTokens[user!.uid], {
                          onlyParentId: user!.uid,
                          // Aktiviteter ligger i ett eget flöde, så de kan
                          // få egen färg i Google (som färgar per kalender).
                          includeActivities: false,
                        })
                      : feedLinks
                        ? feedLinks[user!.uid]
                        : null
                  }
                  otherFeedLinks={
                    feedTokens?.[user!.uid] && teamId && activeChild && counterpartId
                      ? buildFeedLinks(teamId, activeChild.id, user!.uid, feedTokens[user!.uid], {
                          onlyParentId: counterpartId,
                          // Aktiviteter ligger redan i det egna flödet —
                          // utan detta dubbleras de när man lägger till båda.
                          includeActivities: false,
                        })
                      : null
                  }
                  otherParentName={parentNames[counterpartId] ?? "Andra föräldern"}
                  onCreateFeed={handleCreateFeed}
                  onChangeSwitchHour={handleChangeSwitchHour}
                  onEditStructure={
                    hasPartner && cycle ? () => setEditingStructure(true) : undefined
                  }
                  activityFeedLinks={
                    feedTokens?.[user!.uid] && teamId
                      ? buildFeedLinks(teamId, activeChild.id, user!.uid, feedTokens[user!.uid], {
                          activitiesOnly: true,
                        })
                      : null
                  }
                  calendars={calendarRows}
                  activeCalendarId={`${teamId}:${activeChild.id}`}
                  onSelectCalendar={handleSelectCalendar}
                  onCreateCalendar={handleCreateCalendar}
                  onRenameCalendar={handleRenameCalendar}
                  onDeleteCalendar={handleDeleteCalendar}
                  onInviteToCalendar={handleInviteToCalendar}
                  onInviteRelative={handleInviteRelative}
                  scheduleChangeMode={myScheduleChangeMode}
                  onChangeScheduleChangeMode={handleChangeScheduleChangeMode}
                  myRole={myRole}
                />
              </>
            )}
          </div>
        )}
      </div>

      <div className="mx-auto w-full max-w-md shrink-0">
        <BottomNav active={section} onChange={setSection} disabled={disabledSections} />
      </div>
    </div>
  );
}


function Centered({ children }: { children: React.ReactNode }) {
  return <div className="mx-auto flex min-h-screen max-w-sm flex-col justify-center px-6 text-center">{children}</div>;
}
