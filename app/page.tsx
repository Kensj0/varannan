"use client";

import { useMemo, useState } from "react";
import { useAuth } from "../lib/auth/AuthProvider";
import {
  useTeam,
  useChildren,
  useCustodyCycle,
  useDayBalance,
  useApprovedShiftRequests,
  usePendingShiftRequests,
  useAllShiftRequests,
  useEventsForMonth,
  useChatMessages,
  usePackLists,
  useNotes,
  useTodos,
  useChildInfo,
  useChildAccounts,
} from "../lib/hooks/useFirestore";
import { createEvent, proposeShiftRequest, respondToShiftRequest } from "../lib/calendarActions";
import { sendChatMessage } from "../lib/chatActions";
import {
  createPackList,
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
import BalanceCard from "../components/BalanceCard";
import PendingShiftRequests from "../components/PendingShiftRequests";
import ChatView from "../components/ChatView";
import PackListView from "../components/PackListView";
import NotesView from "../components/NotesView";
import TodoView from "../components/TodoView";
import ChildInfoView from "../components/ChildInfoView";
import AccountsView from "../components/AccountsView";
import CycleSetupScreen from "../components/onboarding/CycleSetupScreen";
import WaitingForParentScreen from "../components/onboarding/WaitingForParentScreen";
import AddFirstChildScreen from "../components/onboarding/AddFirstChildScreen";
import { createInvite, addChild, saveCustodyCycle } from "../lib/onboardingClient";
import { PENDING_PARTNER_ID } from "../types/schema";

const PARENT_COLORS = ["bg-rose-500", "bg-sky-500"];

type Tab = "calendar" | "packlist" | "notes" | "todo" | "info" | "accounts" | "chat";

const TAB_LABELS: Record<Tab, string> = {
  calendar: "Kalender",
  packlist: "Packlista",
  notes: "Notes",
  todo: "Todo",
  info: "Barninfo",
  accounts: "Konton",
  chat: "Chatt",
};

export default function HomePage() {
  const { user, userDoc, signOutUser } = useAuth();
  const teamId = userDoc?.teamId ?? null;

  const { data: team } = useTeam(teamId);
  const { data: children, loading: childrenLoading } = useChildren(teamId);

  const [selectedChildId, setSelectedChildId] = useState<string | null>(null);
  const [monthDate, setMonthDate] = useState(() => new Date());
  const [tab, setTab] = useState<Tab>("calendar");

  // Välj första barnet automatiskt så fort listan laddats.
  const activeChildId = selectedChildId ?? children[0]?.id ?? null;
  const activeChild = children.find((c) => c.id === activeChildId) ?? null;

  const { data: cycle } = useCustodyCycle(teamId, activeChildId);
  const { data: balance } = useDayBalance(teamId, activeChildId);
  const { data: approvedShifts } = useApprovedShiftRequests(teamId, activeChildId);
  const { data: pendingShifts } = usePendingShiftRequests(teamId, activeChildId);
  const { data: events } = useEventsForMonth(teamId, monthDate);
  const { data: allShiftRequests } = useAllShiftRequests(teamId);
  const { data: chatMessages } = useChatMessages(teamId);
  const { data: packLists } = usePackLists(teamId, activeChildId);
  const { data: notes } = useNotes(teamId);
  const { data: todos } = useTodos(teamId);
  const { data: childInfo } = useChildInfo(teamId, activeChildId);
  const { data: childAccounts } = useChildAccounts(teamId, activeChildId);

  // Förälder-metadata från teamets cachade profiler (users/{uid} är bara
  // läsbart för ägaren själv, därför ligger namnen i team-dokumentet).
  const parents = useMemo(() => {
    const ids = team?.parentIds ?? [];
    return ids.map((id, i) => ({
      id,
      name:
        team?.parentProfiles?.[id]?.displayName ??
        (id === user?.uid ? user?.displayName ?? "Du" : "Andra föräldern"),
      color: PARENT_COLORS[i % PARENT_COLORS.length],
    }));
  }, [team, user]);

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
  if (!cycle) {
    const self = parents[0] ?? { id: user!.uid, name: user?.displayName ?? "Du" };
    const partner = parents[1] ?? { id: PENDING_PARTNER_ID, name: "Andra föräldern" };
    return (
      <CycleSetupScreen
        childName={activeChild.name}
        parents={[
          { id: self.id, name: self.name },
          { id: partner.id, name: partner.name },
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

  // Schemat finns (ev. med platshållare väntande på partnern), men själva
  // vardagsanvändningen — chatt, byten, ställning — kräver att båda
  // föräldrarna faktiskt finns, så den väntar tills partnern anslutit.
  if (parents.length < 2) {
    return (
      <WaitingForParentScreen
        teamName={team?.name}
        onCreateInvite={() => createInvite(teamId!)}
        onSignOut={signOutUser}
      />
    );
  }

  const otherParentId = parents.find((p) => p.id !== balance?.referenceParentId)?.id ?? parents[1].id;

  return (
    <main className="mx-auto max-w-md px-4 py-6">
      <header className="mb-4 flex items-center justify-between">
        <h1 className="text-xl font-bold text-stone-800">Varannan</h1>
        <button onClick={signOutUser} className="text-sm text-stone-400 hover:text-rose-500">
          Logga ut
        </button>
      </header>

      <nav className="mb-4 flex gap-1 overflow-x-auto rounded-full bg-white p-1">
        {(Object.keys(TAB_LABELS) as Tab[]).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`flex-1 whitespace-nowrap rounded-full px-3 py-2 text-sm font-semibold transition ${
              tab === t ? "bg-rose-500 text-white" : "text-stone-500"
            }`}
          >
            {TAB_LABELS[t]}
          </button>
        ))}
      </nav>

      {children.length > 1 && tab !== "notes" && tab !== "todo" && tab !== "chat" && (
        <div className="mb-4 flex gap-2 overflow-x-auto">
          {children.map((child) => (
            <button
              key={child.id}
              onClick={() => setSelectedChildId(child.id)}
              className={`whitespace-nowrap rounded-full px-4 py-1.5 text-sm font-medium ${
                child.id === activeChildId ? "bg-rose-500 text-white" : "bg-white text-stone-600"
              }`}
            >
              {child.name}
            </button>
          ))}
        </div>
      )}

      {tab === "chat" && (
        <div className="h-[70vh] overflow-hidden rounded-2xl bg-stone-50">
          <ChatView
            messages={chatMessages}
            currentUserId={user!.uid}
            parentNames={parentNames}
            shiftRequestsById={allShiftRequests}
            childName={activeChild.name}
            onSend={async (text) => {
              await sendChatMessage({ teamId: teamId!, senderId: user!.uid, text });
            }}
          />
        </div>
      )}

      {tab === "packlist" && (
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
        />
      )}

      {tab === "notes" && (
        <NotesView
          notes={notes}
          parentNames={parentNames}
          onCreate={async (title, content) => {
            await createNote({ teamId: teamId!, title, content, createdBy: user!.uid });
          }}
          onUpdate={(noteId, patch) => updateNote(teamId!, noteId, patch)}
          onDelete={(noteId) => deleteNote(teamId!, noteId)}
        />
      )}

      {tab === "todo" && (
        <TodoView
          todos={todos}
          currentUserId={user!.uid}
          parentNames={parentNames}
          onCreate={async (title) => {
            await createTodo({ teamId: teamId!, title, createdBy: user!.uid });
          }}
          onToggle={(todo) => toggleTodo(teamId!, todo, user!.uid)}
          onArchive={(todoId) => archiveTodo(teamId!, todoId)}
        />
      )}

      {tab === "info" && (
        <ChildInfoView
          childName={activeChild.name}
          info={childInfo}
          onSave={(patch) => updateChildInfo(teamId!, activeChild.id, patch, user!.uid)}
        />
      )}

      {tab === "accounts" && (
        <AccountsView
          accounts={childAccounts}
          parentNames={parentNames}
          onCreate={async (service, username, pinOrNote) => {
            await createChildAccount({
              teamId: teamId!,
              childId: activeChild.id,
              service,
              username,
              pinOrNote,
              addedBy: user!.uid,
            });
          }}
          onUpdate={(accountId, patch) => updateChildAccount(teamId!, activeChild.id, accountId, patch)}
          onDelete={(accountId) => deleteChildAccount(teamId!, activeChild.id, accountId)}
        />
      )}

      {tab === "calendar" && (
      <>
      {balance && (
        <div className="mb-4">
          <BalanceCard balance={balance} parentNames={parentNames} otherParentId={otherParentId} />
        </div>
      )}

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
          />
        </div>
      )}

      <MonthNav monthDate={monthDate} onChange={setMonthDate} />

      <CalendarView
        monthDate={monthDate}
        childId={activeChild.id}
        childName={activeChild.name}
        cycle={cycle}
        parents={[parents[0], parents[1]]}
        approvedShiftRequests={approvedShifts}
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
          await proposeShiftRequest({
            teamId: teamId!,
            childId: activeChild.id,
            requestedBy: user!.uid,
            takingOverParentId,
            startAt: date,
          });
        }}
      />
      </>
      )}
    </main>
  );
}

function MonthNav({ monthDate, onChange }: { monthDate: Date; onChange: (d: Date) => void }) {
  return (
    <div className="mb-3 flex items-center justify-between">
      <button
        onClick={() => onChange(new Date(monthDate.getFullYear(), monthDate.getMonth() - 1, 1))}
        className="rounded-full px-3 py-1 text-stone-500 hover:bg-white"
        aria-label="Föregående månad"
      >
        ‹
      </button>
      <button onClick={() => onChange(new Date())} className="text-sm text-stone-400 hover:text-rose-500">
        Idag
      </button>
      <button
        onClick={() => onChange(new Date(monthDate.getFullYear(), monthDate.getMonth() + 1, 1))}
        className="rounded-full px-3 py-1 text-stone-500 hover:bg-white"
        aria-label="Nästa månad"
      >
        ›
      </button>
    </div>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return <div className="mx-auto flex min-h-screen max-w-sm flex-col justify-center px-6 text-center">{children}</div>;
}
