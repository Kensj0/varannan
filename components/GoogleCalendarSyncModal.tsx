import { useEffect, useState } from "react";
import { EventDoc } from "../types/schema";

interface GoogleCalendarSyncModalProps {
  isOpen: boolean;
  onClose: () => void;
  events: EventDoc[];
  childName: string;
}

const STORAGE_KEY = "google_calendar_synced_events";

export function GoogleCalendarSyncModal({
  isOpen,
  onClose,
  events,
  childName,
}: GoogleCalendarSyncModalProps) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [synced, setSynced] = useState<string[]>([]);
  const [syncedCount, setSyncedCount] = useState(0);
  const [showFeedback, setShowFeedback] = useState(false);
  const [feedbackType, setFeedbackType] = useState<"sync" | "update" | "delete" | null>(null);

  useEffect(() => {
    if (isOpen) {
      const stored = localStorage.getItem(STORAGE_KEY);
      setSynced(stored ? JSON.parse(stored) : []);
      setSelected(new Set());
      setShowFeedback(false);
    }
  }, [isOpen]);

  const handleSelectEvent = (eventId: string) => {
    const newSelected = new Set(selected);
    if (newSelected.has(eventId)) {
      newSelected.delete(eventId);
    } else {
      newSelected.add(eventId);
    }
    setSelected(newSelected);
  };

  const handleSync = () => {
    const newSynced = Array.from(new Set([...synced, ...selected]));
    setSynced(newSynced);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(newSynced));
    setSyncedCount(selected.size);
    setFeedbackType("sync");
    setShowFeedback(true);
    setSelected(new Set());
    setTimeout(() => setShowFeedback(false), 2000);
  };

  const handleDeleteSynced = (eventId: string) => {
    const newSynced = synced.filter((id) => id !== eventId);
    setSynced(newSynced);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(newSynced));
    setFeedbackType("delete");
    setShowFeedback(true);
    setTimeout(() => setShowFeedback(false), 2000);
  };

  if (!isOpen) return null;

  const syncableEvents = events.filter((e) => !synced.includes(e.id));
  const syncedEvents = events.filter((e) => synced.includes(e.id));

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-lg shadow-xl max-w-2xl w-full max-h-[80vh] flex flex-col">
        {/* Header */}
        <div className="border-b px-6 py-4 flex justify-between items-center">
          <h2 className="text-lg font-semibold">Synka till Google Calendar</h2>
          <button
            onClick={onClose}
            className="text-gray-500 hover:text-gray-700 text-2xl leading-none"
          >
            ×
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-6">
          {/* Feedback Messages */}
          {showFeedback && (
            <div className="mb-4 p-3 rounded-md bg-green-50 border border-green-200 flex items-center gap-2">
              <span className="text-green-600">✓</span>
              <span className="text-green-800">
                {feedbackType === "sync" && syncedCount > 0
                  ? `${syncedCount} aktivitet${syncedCount !== 1 ? "er" : ""} synkad${syncedCount !== 1 ? "e" : ""} till Google Calendar`
                  : feedbackType === "delete"
                    ? "Aktiviteten borttagen från Google Calendar"
                    : "Uppdaterad i Google Calendar"}
              </span>
            </div>
          )}

          {/* Syncable Events */}
          <div className="mb-6">
            <h3 className="font-medium text-gray-700 mb-3">Aktiviteter att synka</h3>
            {syncableEvents.length === 0 ? (
              <p className="text-gray-500 text-sm">Alla aktiviteter är redan synkade.</p>
            ) : (
              <div className="space-y-2">
                {syncableEvents.map((event) => (
                  <label
                    key={event.id}
                    className="flex items-center p-3 border rounded-md cursor-pointer hover:bg-gray-50"
                  >
                    <input
                      type="checkbox"
                      checked={selected.has(event.id)}
                      onChange={() => handleSelectEvent(event.id)}
                      className="w-4 h-4"
                    />
                    <div className="ml-3 flex-1">
                      <div className="font-medium text-gray-800">{event.title}</div>
                      <div className="text-sm text-gray-500">
                        {event.startAt && new Date(event.startAt.seconds * 1000).toLocaleDateString("sv-SE")}
                      </div>
                    </div>
                  </label>
                ))}
              </div>
            )}
          </div>

          {/* Already Synced */}
          {syncedEvents.length > 0 && (
            <div className="mb-6 p-4 bg-blue-50 border border-blue-200 rounded-md">
              <h3 className="font-medium text-blue-900 mb-3">Redan synkade ({syncedEvents.length})</h3>
              <div className="space-y-2">
                {syncedEvents.map((event) => (
                  <div
                    key={event.id}
                    className="flex items-center justify-between p-2 bg-white border border-blue-100 rounded"
                  >
                    <div>
                      <div className="font-medium text-gray-800 text-sm">{event.title}</div>
                      <div className="text-xs text-gray-500">
                        {event.startAt && new Date(event.startAt.seconds * 1000).toLocaleDateString("sv-SE")}
                      </div>
                    </div>
                    <button
                      onClick={() => handleDeleteSynced(event.id)}
                      className="text-xs text-red-600 hover:text-red-800 px-2 py-1 hover:bg-red-50 rounded"
                    >
                      Ta bort
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="border-t px-6 py-4 flex justify-end gap-3">
          <button
            onClick={onClose}
            className="px-4 py-2 text-gray-700 border border-gray-300 rounded-md hover:bg-gray-50"
          >
            Stäng
          </button>
          {selected.size > 0 && (
            <button
              onClick={handleSync}
              className="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 font-medium"
            >
              Synka ({selected.size})
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
