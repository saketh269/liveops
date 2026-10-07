import type { ReactNode } from "react";
import type { Asset } from "../../api/types";
import { assetName } from "../reducer";

type Props = {
  /** Selected record, if any. */
  asset: Asset | undefined;
  /** The journey itself (steps, timers); filled in by the journey work (ADR 0007 Phase 2). */
  children?: ReactNode;
};

/**
 * Bottom slot for the patient journey. This card owns the place, size and empty
 * state; the content comes in as children.
 */
export default function JourneyCard({ asset, children }: Props) {
  const name = asset ? assetName(asset) : null;
  return (
    <section className="lm-glass lm-hud-journey" aria-labelledby="lm-journey-h" data-empty={children ? undefined : ""}>
      <div className="lm-hud-journey-head">
        <b id="lm-journey-h">Journey{name ? <> · <span className="mono">{name}</span></> : null}</b>
      </div>
      {children ?? (
        <p className="lm-hud-empty">
          {name ? `No journey to show for ${name} yet.` : "Select a patient or a bed to see its journey here."}
        </p>
      )}
    </section>
  );
}
