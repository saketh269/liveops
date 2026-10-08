// The sign-in look: a centred glass card over a soft, blurred, slowly drifting hospital-map
// illustration (pure SVG, colours from the design tokens). Decorative only: hidden from screen readers.
import { useEffect, useRef, type ReactNode } from "react";
import { useAuth } from "./AuthProvider";
import { FormAlert } from "./fields";
import "./auth.css";

type Room = { x: number; y: number; w: number; h: number; tone: "free" | "use" | "clean" | "alert" | "none" };

const TONES: Room["tone"][] = ["use", "free", "use", "none", "clean", "use", "free", "use", "alert", "use", "none", "free"];

/** Rooms either side of a corridor, like a ward on the live map. Deterministic, so no layout jitter. */
function ward(x0: number, y0: number, count: number, roomW: number, roomH: number, corridor: number, seed: number): Room[] {
  const rooms: Room[] = [];
  for (let i = 0; i < count; i++) {
    const tone = (k: number) => TONES[(i * 5 + seed + k) % TONES.length];
    rooms.push({ x: x0 + i * roomW, y: y0, w: roomW, h: roomH, tone: tone(0) });
    rooms.push({ x: x0 + i * roomW, y: y0 + roomH + corridor, w: roomW, h: roomH, tone: tone(3) });
  }
  return rooms;
}

const WARDS = [
  { x: 60, y: 60, n: 9, seed: 0 },
  { x: 60, y: 330, n: 9, seed: 4 },
  { x: 760, y: 60, n: 7, seed: 7 },
  { x: 760, y: 330, n: 7, seed: 2 },
  { x: 60, y: 600, n: 6, seed: 9 },
  { x: 700, y: 600, n: 8, seed: 5 },
];
const ROOM_W = 66, ROOM_H = 82, CORRIDOR = 44;
const ROOMS = WARDS.flatMap((w) => ward(w.x, w.y, w.n, ROOM_W, ROOM_H, CORRIDOR, w.seed));
const PEOPLE = WARDS.flatMap((w, wi) =>
  Array.from({ length: 4 }, (_, k) => ({ x: w.x + 30 + ((k * 137 + wi * 61) % (w.n * ROOM_W - 60)), y: w.y + ROOM_H + CORRIDOR / 2, tone: k % 3 })));

export function HospitalBackdrop() {
  return (
    <div className="au-backdrop" aria-hidden="true">
      <svg className="au-map" viewBox="0 0 1400 900" preserveAspectRatio="xMidYMid slice" focusable="false">
        <rect className="au-map-site" x="20" y="20" width="1360" height="860" rx="28" />
        {WARDS.map((w) => (
          <g key={`${w.x}-${w.y}`}>
            <rect className="au-map-wing" x={w.x - 12} y={w.y - 12} width={w.n * ROOM_W + 24} height={ROOM_H * 2 + CORRIDOR + 24} rx="16" />
            <rect className="au-map-corridor" x={w.x} y={w.y + ROOM_H} width={w.n * ROOM_W} height={CORRIDOR} rx="6" />
          </g>
        ))}
        {ROOMS.map((r) => (
          <g key={`${r.x}-${r.y}`}>
            <rect className="au-map-room" x={r.x + 3} y={r.y + 3} width={r.w - 6} height={r.h - 6} rx="7" />
            {r.tone !== "none" && <rect className={`au-map-bed au-tone-${r.tone}`} x={r.x + r.w / 2 - 12} y={r.y + r.h / 2 - 18} width="24" height="36" rx="6" />}
          </g>
        ))}
        <rect className="au-map-station" x="1290" y="160" width="60" height="560" rx="14" />
        {PEOPLE.map((p, i) => <circle key={i} className={`au-map-person au-person-${p.tone}`} cx={p.x} cy={p.y} r="7" />)}
      </svg>
      <div className="au-veil" />
    </div>
  );
}

export function BrandMark() {
  return (
    <span className="au-mark" aria-hidden="true">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg>
    </span>
  );
}

/** Centred glass card. The heading receives focus on mount so screen readers start at the page title. */
export default function AuthLayout({ title, lead, children, footer, focusHeading = false }: {
  title: string; lead?: ReactNode; children: ReactNode; footer?: ReactNode; focusHeading?: boolean;
}) {
  const h1 = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    document.title = `${title} · Live Ops`;
    if (focusHeading) h1.current?.focus();
  }, [title, focusHeading]);
  return (
    <div className="au-page">
      <HospitalBackdrop />
      <main className="au-main">
        <div className="au-card">
          <div className="au-brand"><BrandMark /><span>Live Ops</span></div>
          <h1 ref={h1} tabIndex={-1}>{title}</h1>
          {lead && <p className="au-lead">{lead}</p>}
          {children}
        </div>
        {footer && <div className="au-foot">{footer}</div>}
      </main>
    </div>
  );
}

/** While the auth state loads (or can't be loaded) show the backdrop with a calm status, not a blank page. */
export function AuthGate({ children }: { children: ReactNode }) {
  const { status, error, refresh } = useAuth();
  if (status === "ready") return <>{children}</>;
  if (status === "loading") {
    return (
      <div className="au-page">
        <HospitalBackdrop />
        <main className="au-main">
          <div className="au-card au-card--quiet" role="status" aria-live="polite">
            <div className="au-brand"><BrandMark /><span>Live Ops</span></div>
            <p className="muted">Loading…</p>
          </div>
        </main>
      </div>
    );
  }
  return (
    <AuthLayout title="Can't reach Live Ops">
      <FormAlert error={error} />
      <button type="button" className="btn primary au-submit" onClick={() => void refresh()}>Try again</button>
    </AuthLayout>
  );
}
