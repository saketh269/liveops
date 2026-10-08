import { useEffect, useRef } from "react";
import type { Pin } from "./pins";

export type Projector = (assetId: string) => { x: number; y: number } | null;

type Props = {
  pins: Pin[];
  /** From the 3D view; null (2D view, or still loading) hides the pins. */
  project: Projector | null;
  onSelect: (assetId: string) => void;
};

/**
 * HTML pins standing on figures in the 3D scene. Positions are written straight to
 * the DOM every frame (no React render); a pin whose figure is off screen is hidden.
 */
export default function ProblemPins({ pins, project, onSelect }: Props) {
  const layer = useRef<HTMLDivElement>(null);
  const els = useRef(new Map<string, HTMLButtonElement>());
  const list = useRef(pins);
  list.current = pins;

  useEffect(() => {
    if (!project) return;
    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const host = layer.current;
      if (!host) return;
      const r = host.getBoundingClientRect();
      for (const p of list.current) {
        const el = els.current.get(p.key);
        if (!el) continue;
        const at = project(p.assetId);
        const x = at ? at.x - r.left : -1;
        const y = at ? at.y - r.top : -1;
        const inside = at !== null && x >= 0 && y >= 0 && x <= r.width && y <= r.height;
        el.style.visibility = inside ? "" : "hidden";
        if (inside) el.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px) translate(-50%, -100%)`;
      }
    };
    tick();
    return () => cancelAnimationFrame(raf);
  }, [project]);

  if (!project) return null;
  return (
    <div ref={layer} className="lm-hud-pins">
      {pins.map((p) => (
        <button
          key={p.key}
          ref={(el) => { if (el) els.current.set(p.key, el); else els.current.delete(p.key); }}
          type="button"
          className={`lm-hud-pin lm-hud-pin--${p.tone}`}
          style={{ visibility: "hidden" }}
          data-pin={p.key}
          onClick={() => onSelect(p.assetId)}
        >
          <span className="lm-hud-pin-tag">
            <i aria-hidden="true">{p.count > 1 ? p.count : p.tone === "bad" ? "!" : "◷"}</i>
            <span>{p.text}</span>
          </span>
          <span className="lm-hud-pin-stem" aria-hidden="true" />
        </button>
      ))}
    </div>
  );
}
