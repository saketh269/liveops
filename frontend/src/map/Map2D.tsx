import { useMemo } from "react";
import type { Asset, SiteLayout } from "../api/types";
import { FloorPlanImage } from "./FloorPlanImage";
import type { PlanView } from "./floors";
import { floorSize, PlacementCache, polygonCentroid } from "./placement";
import { stateKey } from "./stateColors";

type Props = {
  layout: SiteLayout;
  assets: ReadonlyMap<string, Asset>;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onHover: (id: string | null, x: number, y: number) => void;
  reason?: string;
  /** Floor plan image drawn over the zone fills, under assets. */
  plan?: PlanView | null;
};

/** Top-down SVG view used when WebGL is unavailable. Same zones, positions and colors as the 3D map. */
export default function Map2D({ layout, assets, selectedId, onSelect, onHover, reason, plan }: Props) {
  const cache = useMemo(() => new PlacementCache(), []);
  const placement = cache.get(layout, assets.values());
  const { width, depth } = floorSize(layout);
  const u = placement.unassigned;
  const totalH = u ? u.y + u.h + 1 : depth;

  return (
    <div className="lm-viewport lm-viewport--2d">
      {reason && <p className="lm-fallback-note muted">2D view: {reason}</p>}
      <svg
        className="lm-svg"
        viewBox={`-2 -2 ${width + 4} ${totalH + 4}`}
        role="img"
        aria-label={`Top view of the site floor, ${width} by ${depth}, with ${assets.size} assets`}
        onClick={(e) => { if (e.target === e.currentTarget) onSelect(null); }}
      >
        <rect className="lm-floor" x={0} y={0} width={width} height={depth} />
        {(layout.zones ?? []).map((z, i) =>
          z.polygon?.length >= 3 ? (
            <polygon
              key={z.id}
              className={`lm-zone ${i % 2 ? "lm-zone--alt" : ""}`}
              points={z.polygon.map((p) => p.join(",")).join(" ")}
              style={z.color ? { fill: z.color } : undefined}
            />
          ) : null,
        )}
        {plan && <FloorPlanImage plan={plan} />}
        {u && (
          <g>
            <rect className="lm-unassigned" x={u.x} y={u.y} width={u.w} height={u.h} />
            <text className="lm-zone-text lm-zone-text--start" x={u.x + 0.5} y={u.y - 1}>Unassigned (zone not in layout)</text>
          </g>
        )}
        {[...assets.values()].map((a) => {
          const p = placement.positions.get(a.asset_id);
          if (!p) return null;
          const s = p.size;
          return (
            <rect
              key={a.asset_id}
              data-asset={a.asset_id}
              className={`lm-asset lm-s-${stateKey(a.state)} ${a.asset_id === selectedId ? "lm-asset--sel" : ""}`}
              x={p.x - s / 2 + p.level * 0.15}
              y={p.y - s / 2 - p.level * 0.15}
              width={s}
              height={s}
              rx={s * 0.2}
              onClick={(e) => { e.stopPropagation(); onSelect(a.asset_id); }}
              onPointerEnter={(e) => onHover(a.asset_id, e.clientX, e.clientY)}
              onPointerLeave={(e) => onHover(null, e.clientX, e.clientY)}
            />
          );
        })}
        {/* Labels last so assets never hide them. */}
        {(layout.zones ?? []).map((z) =>
          z.polygon?.length >= 3 ? (
            <text key={z.id} className="lm-zone-text" x={polygonCentroid(z.polygon)[0]} y={polygonCentroid(z.polygon)[1]}>{z.name || z.id}</text>
          ) : null,
        )}
      </svg>
    </div>
  );
}
