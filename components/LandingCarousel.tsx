"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Carousel med påhittade mockup-vyer av appen, i stil med
 * skärmdumparna på en Google Play-listning. Byggd med CSS
 * scroll-snap i stället för ett bibliotek — swipe fungerar nativt på
 * mobilen utan JS, vi lägger bara till punkterna som visar var man är.
 *
 * VIKTIGT: alla namn och data här är påhittade (Mamma/Pappa, "Ines").
 * Det här är en publik sida — riktiga familjers scheman ska aldrig
 * synas här.
 */
export default function LandingCarousel() {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(0);

  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    function onScroll() {
      if (!el) return;
      const slideWidth = el.clientWidth;
      setActive(Math.round(el.scrollLeft / slideWidth));
    }
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  function goTo(i: number) {
    const el = scrollerRef.current;
    if (!el) return;
    el.scrollTo({ left: i * el.clientWidth, behavior: "smooth" });
  }

  return (
    <div className="mb-10">
      <div
        ref={scrollerRef}
        className="flex snap-x snap-mandatory overflow-x-auto scroll-smooth [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        <Slide flush><ScheduleScreenshot /></Slide>
        <Slide><HandoffMock /></Slide>
        <Slide><ActivityMock /></Slide>
        <Slide><AgreementMock /></Slide>
      </div>

      <div className="mt-4 flex justify-center gap-1.5">
        {[0, 1, 2, 3].map((i) => (
          <button
            key={i}
            onClick={() => goTo(i)}
            aria-label={`Visa bild ${i + 1}`}
            className={`h-1.5 rounded-full transition-all ${
              active === i ? "w-5 bg-rose-500" : "w-1.5 bg-stone-300"
            }`}
          />
        ))}
      </div>
    </div>
  );
}

function Slide({ children, flush = false }: { children: React.ReactNode; flush?: boolean }) {
  return (
    <div className="flex w-full shrink-0 snap-center justify-center px-2">
      <PhoneFrame flush={flush}>{children}</PhoneFrame>
    </div>
  );
}

/** Enkel "telefonram" som mockup-vyerna ritas inuti. */
function PhoneFrame({ children, flush = false }: { children: React.ReactNode; flush?: boolean }) {
  return (
    <div className="w-[220px] overflow-hidden rounded-[28px] border-4 border-stone-800 bg-white shadow-lg">
      <div className={`h-full min-h-[380px] bg-stone-50 ${flush ? "" : "p-3"}`}>{children}</div>
    </div>
  );
}

/**
 * Den enda RIKTIGA skärmdumpen i carousellen — tagen från själva
 * appkoden (CalendarView.tsx) med påhittade namn (Mamma/Pappa/Barn),
 * inte en handritad mockup som de andra tre. Ligger i /public/
 * screenshots/schema.png. Se README/kommentarer i den commit som
 * lade till den för hur bilden genererades.
 */
function ScheduleScreenshot() {
  return (
    <img
      src="/screenshots/schema.png"
      alt="Skärmdump av schemat i Varannan, med Mamma och Pappa som exempelnamn"
      className="h-full w-full object-cover"
    />
  );
}

// ---------------------------------------------------------------------------
// Mockup-vyer. Allt innehåll är påhittat.
// ---------------------------------------------------------------------------

function HandoffMock() {
  return (
    <div className="flex h-full flex-col justify-center">
      <div className="rounded-2xl bg-white p-3 shadow-md ring-1 ring-stone-100">
        <p className="text-[10px] font-semibold text-stone-400">Varannan</p>
        <p className="mt-1 text-xs font-bold text-stone-800">Du tar över ansvaret</p>
        <p className="mt-0.5 text-[11px] text-stone-500">Byte kl 17:00 idag · Ines</p>
      </div>
      <p className="mt-4 text-center text-[11px] leading-snug text-stone-400">
        Push- och mailpåminnelser inför varje överlämning
      </p>
    </div>
  );
}

function ActivityMock() {
  const items = ["Fotbollsträning 17:00", "Läxor med mormor", "Tandläkare 09:30"];
  return (
    <div>
      <p className="mb-2 text-xs font-semibold text-stone-600">Onsdag 24 sep</p>
      <div className="space-y-1.5">
        {items.map((t) => (
          <div key={t} className="flex items-center gap-2 rounded-lg bg-amber-50 px-2 py-1.5">
            <span className="text-amber-500">✓</span>
            <span className="text-[10px] text-amber-900">{t}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function AgreementMock() {
  return (
    <div>
      <p className="mb-2 text-xs font-semibold text-stone-600">Avtal</p>
      <div className="space-y-2 text-[9.5px] leading-relaxed text-stone-500">
        <p className="font-semibold text-stone-700">1. Grundschemat</p>
        <p>Kan bara ändras om båda godkänner.</p>
        <p className="font-semibold text-stone-700">2. Lagt kort ligger</p>
        <p>En godkänd ändring gäller precis som grundschemat.</p>
      </div>
    </div>
  );
}
