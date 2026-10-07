import type { PlanView } from "./floors";

/** A floor plan image in an SVG floor view. Blending and dark-mode inversion come from the --plan-* tokens. */
export function FloorPlanImage({ plan }: { plan: PlanView }) {
  return (
    <image
      className="lm-plan"
      href={plan.url}
      x={plan.x}
      y={plan.y}
      width={plan.w}
      height={plan.h}
      opacity={plan.opacity}
      preserveAspectRatio="none"
      aria-hidden="true"
    />
  );
}
