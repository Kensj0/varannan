"use client";

import { Profiler, ProfilerOnRenderCallback, ReactNode, useRef } from "react";

/**
 * Mäter faktisk React-renderingstid i webbläsaren.
 *
 * Användning: linda in en vy tillfälligt under utveckling —
 *
 *   <RenderProfiler id="CalendarView">
 *     <CalendarView ... />
 *   </RenderProfiler>
 *
 * Resultatet loggas till konsolen och samlas i window.__renderStats,
 * så du kan köra `copy(window.__renderStats)` i DevTools.
 *
 * Profiler-API:t är inbyggt i React och lägger till en liten overhead
 * (~10%) i development. I produktionsbygget är komponenten en no-op
 * via NODE_ENV-kontrollen, så den kan lämnas kvar utan kostnad.
 */

interface RenderStat {
  id: string;
  phase: "mount" | "update" | "nested-update";
  actualDuration: number;
  baseDuration: number;
  timestamp: number;
}

declare global {
  interface Window {
    __renderStats?: RenderStat[];
    __renderSummary?: () => void;
  }
}

export default function RenderProfiler({ id, children }: { id: string; children: ReactNode }) {
  const countRef = useRef(0);

  if (process.env.NODE_ENV === "production") {
    return <>{children}</>;
  }

  const onRender: ProfilerOnRenderCallback = (profilerId, phase, actualDuration, baseDuration) => {
    countRef.current++;

    if (typeof window !== "undefined") {
      window.__renderStats = window.__renderStats ?? [];
      window.__renderStats.push({
        id: profilerId,
        phase: phase as RenderStat["phase"],
        actualDuration,
        baseDuration,
        timestamp: Date.now(),
      });

      // Hjälpare att köra i DevTools-konsolen.
      window.__renderSummary = () => {
        const stats = window.__renderStats ?? [];
        const byId = new Map<string, number[]>();
        for (const s of stats) {
          const list = byId.get(s.id) ?? [];
          list.push(s.actualDuration);
          byId.set(s.id, list);
        }
        console.table(
          Array.from(byId.entries()).map(([key, durations]) => ({
            komponent: key,
            renderingar: durations.length,
            "median (ms)": median(durations).toFixed(2),
            "värsta (ms)": Math.max(...durations).toFixed(2),
            "totalt (ms)": durations.reduce((a, b) => a + b, 0).toFixed(1),
          }))
        );
      };
    }

    // Varna för renderingar som riskerar att tappa frames.
    if (actualDuration > 16) {
      console.warn(
        `[render] ${profilerId} ${phase} tog ${actualDuration.toFixed(1)} ms — över 16 ms budget (rendering #${countRef.current})`
      );
    }
  };

  return (
    <Profiler id={id} onRender={onRender}>
      {children}
    </Profiler>
  );
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}
