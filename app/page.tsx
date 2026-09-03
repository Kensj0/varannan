"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useAuth } from "../lib/auth/AuthProvider";
import {
  requestAndSavePushToken,
  getPushPermissionState,
  listenForForegroundMessages,
  updateHandoffReminderPrefs,
} from "../lib/pushNotifications";
import {
  useTeam,
  useChildren,
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
} from "../lib/hooks/useFirestore";
import {
  createEvent,
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
} from "../lib/calendarActions";
import { sendChatMessage } from "../lib/chatActions";
import {
  createPackList,
  deletePackList,
  addPackListItem,
  togglePackListItem,
  removePackListItem,
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
import CalendarView from "../components/CalendarView";
import BottomNav, { AppSection } from "../components/BottomNav";
import SubTabs from "../components/SubTabs";
import SettingsView from "../components/SettingsView";
import CustodyCycleBuilder from "../components/onboarding/CustodyCycleBuilder";
import BalanceCard from "../components/BalanceCard";
import PendingShiftRequests from "../components/PendingShiftRequests";
import PendingStructureRequests from "../components/PendingStructureRequests";
import ChatView from "../components/ChatView";
import PackListView from "../components/PackListView";
import NotesView from "../components/NotesView";
import TodoView from "../components/TodoView";
import ChildInfoView from "../components/ChildInfoView";
import AccountsView from "../components/AccountsView";
import CycleSetupScreen from "../components/onboarding/CycleSetupScreen";
import AddFirstChildScreen from "../components/onboarding/AddFirstChildScreen";
import {
  createInvite,
  addChild,
  renameChild,
  deleteChild,
  createCalendarInvite,
  saveCustodyCycle,
  repairPendingPartner,
} from "../lib/onboardingClient";
import {
  PENDING_PARTNER_ID,
  DEFAULT_HANDOFF_REMINDER_PREFS,
  parentColorHex,
  scheduleChangeModeFor,
  calendarParentIds,
  ParentColorId,
  ScheduleChangeMode,
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
    setPushPermission(result);
  }

  // Påminnelser om överlämning (dagen innan / samma dag) — sparas per
  // användare på users/{uid}, läses av den schemalagda Cloud Functionen.
  const reminderPrefs = userDoc?.handoffReminderPrefs ?? DEFAULT_HANDOFF_REMINDER_PREFS;
  async function handleUpdateReminderPrefs(prefs: { dayBefore: boolean; sameDay: boolean }) {
    if (!user) return;
    await updateHandoffReminderPrefs(user.uid, prefs);
  }

  const teamId = userDoc?.teamId ?? null;

  const { data: team } = useTeam(teamId);
  const { data: children, loading: childrenLoading } = useChildren(teamId);

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
  const [listSubTab, setListSubTab] = useState<ListSubTab>("packlist");
  const [infoSubTab, setInfoSubTab] = useState<InfoSubTab>("childinfo");

  // Välj första barnet automatiskt så fort listan laddats.
  const activeChildId = selectedChildId ?? children[0]?.id ?? null;
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

  async function handleCreateCalendar(name: string) {
    if (!teamId) return;
    const { childId } = await addChild(teamId, name);
    // Hoppa direkt till den nya kalendern — annars ser det ut som att
    // ingenting hände, eftersom vyn ligger kvar på den gamla.
    setSelectedChildId(childId);
  }

  async function handleRenameCalendar(calendarId: string, name: string) {
    if (!teamId) return;
    await renameChild(teamId, calendarId, name);
  }

  async function handleInviteToCalendar(calendarId: string) {
    if (!teamId) throw new Error("Inget team.");
    return createCalendarInvite(teamId, calendarId);
  }

  async function handleDeleteCalendar(calendarId: string) {
    if (!teamId) return;
    await deleteChild(teamId, calendarId);
    // Vyn kan stå på den kalender som just försvann — släpp valet så att
    // fallbacken (första barnet) tar över i stället för att peka på ett
    // dokument som inte finns.
    if (selectedChildId === calendarId) setSelectedChildId(null);
    if (selectedInfoChildId === calendarId) setSelectedInfoChildId(null);
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

  const { data: cycle } = useCustodyCycle(teamId, activeChildId);
  const { data: balance } = useDayBalance(teamId, activeChildId);
  const { data: approvedShifts } = useApprovedShiftRequests(teamId, activeChildId);
  const { data: pendingShifts } = usePendingShiftRequests(teamId, activeChildId);
  const { data: structureRequests } = useStructureRequests(teamId, activeChildId);
  const { data: pendingBalanceRequests } = usePendingBalanceRequests(teamId, activeChildId);
  const { data: events } = useEventsForMonth(teamId, monthDate);
  const { data: allShiftRequests } = useAllShiftRequests(teamId);
  const { data: chatMessages } = useChatMessages(teamId, 100, activeChildId, isFallbackCalendar);
  const { data: packLists } = usePackLists(teamId, activeChildId);
  const { data: notes } = useNotes(teamId, activeChildId, isFallbackCalendar);
  const { data: todos } = useTodos(teamId, false, activeChildId, isFallbackCalendar);
  const { data: childInfo } = useChildInfo(teamId, activeInfoChildId);
  const { data: childAccounts } = useChildAccounts(teamId, activeInfoChildId);

  // Förälder-metadata från teamets cachade profiler (users/{uid} är bara
  // läsbart för ägaren själv, därför ligger namnen i team-dokumentet).
  const parents = useMemo(() => {
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
  }, [team, user]);

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
    if (!teamId || !activeChildId || !parents[1]?.id) return;
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
  }, [teamId, activeChildId, parents]);

  async function handleCreateFeed() {
    if (!teamId || !activeChildId || !parents[1]?.id) return;
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

  if (childrenLoading) {
    return <Centered>Laddar…</Centered>;
  }

  // Uppsättningen kan vara ofullständig — t.ex. om någon stängde webbläsaren
  // mitt i onboarding. Varje lucka får en skärm som går att ta sig vidare
  // från, i stället för en återvändsgränd.
  if (!activeChild) {
    return (
      <AddFirstChildScreen
        onAddChild={async (name, birthYear) => {
          await addChild(teamId!, name, birthYear);
        }}
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
  const hasPartner = (team?.parentIds?.length ?? 0) >= 2;

  const otherParentId = parents.find((p) => p.id !== balance?.referenceParentId)?.id ?? parents[1].id;

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
                    onToggleItem={(list, itemId) => togglePackListItem(teamId!, list, itemId, user!.uid)}
                    onRemoveItem={(list, itemId) => removePackListItem(teamId!, list, itemId)}
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
                hasPartner={hasPartner}
                teamName={team?.name}
                onCreateInvite={() => createInvite(teamId!)}
                onUpdateDisplayName={updateDisplayName}
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
                  otherParentName={parentNames[otherParentId] ?? "Andra föräldern"}
                  onRespond={async (requestId, decision) => {
                    await respondToStructureRequest({ teamId: teamId!, requestId, decision });
                  }}
                />

                {pendingShifts.length > 0 && (
                  <div className="mb-4">
                    <PendingShiftRequests
                      requests={pendingShifts}
                      currentUserId={user!.uid}
                      parentNames={parentNames}
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
                  childId={activeChild.id}
                  childName={activeChild.name}
                  cycle={cycle}
                  parents={[parents[0], parents[1]]}
                  approvedShiftRequests={approvedShifts}
                  pendingShiftRequests={pendingShifts}
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
                  onProposeShift={async (date, takingOverParentId) => {
                    await submitShiftChange({
                      teamId: teamId!,
                      childId: activeChild.id,
                      requestedBy: user!.uid,
                      takingOverParentId,
                      // Bytet sker vid schemats bytestid, inte midnatt.
                      startAt: atSwitchHour(date, cycle.switchHour),
                      mode: scheduleChangeModeFor(team, otherParentId),
                    });
                  }}
                  onProposeShiftBatch={async (changes) => {
                    await submitShiftChangeBatch({
                      teamId: teamId!,
                      childId: activeChild.id,
                      requestedBy: user!.uid,
                      switchHour: cycle.switchHour,
                      changes,
                      mode: scheduleChangeModeFor(team, otherParentId),
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
                    feedTokens?.[user!.uid] && teamId && activeChild && otherParentId
                      ? buildFeedLinks(teamId, activeChild.id, user!.uid, feedTokens[user!.uid], {
                          onlyParentId: otherParentId,
                          // Aktiviteter ligger redan i det egna flödet —
                          // utan detta dubbleras de när man lägger till båda.
                          includeActivities: false,
                        })
                      : null
                  }
                  otherParentName={parentNames[otherParentId] ?? "Andra föräldern"}
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
                  calendars={children.map((c) => ({
                    id: c.id,
                    name: c.name,
                    // Styr om "ta bort" betyder lämna eller radera.
                    memberCount: calendarParentIds(c, team).filter(
                      (id) => id !== PENDING_PARTNER_ID,
                    ).length,
                  }))}
                  activeCalendarId={activeChild.id}
                  onSelectCalendar={setSelectedChildId}
                  onCreateCalendar={handleCreateCalendar}
                  onRenameCalendar={handleRenameCalendar}
                  onDeleteCalendar={handleDeleteCalendar}
                  onInviteToCalendar={handleInviteToCalendar}
                  scheduleChangeMode={myScheduleChangeMode}
                  onChangeScheduleChangeMode={handleChangeScheduleChangeMode}
                />
              </>
            )}
          </div>
        )}
      </div>

      <div className="mx-auto w-full max-w-md shrink-0">
        <BottomNav active={section} onChange={setSection} />
      </div>
    </div>
  );
}


function Centered({ children }: { children: React.ReactNode }) {
  return <div className="mx-auto flex min-h-screen max-w-sm flex-col justify-center px-6 text-center">{children}</div>;
}
