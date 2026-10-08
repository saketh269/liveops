import type { ReactNode } from "react";
import type { Asset } from "../../api/types";
import { assetName } from "../reducer";

type Props = {
  /** Selected record, if any. */
  asset: Asset | undefined;
  /** The journey itself (map/track/JourneyView). */
  children?: ReactNode;
  /** Small line next to the title, e.g. "History since Oct 7, 19:05". */
  sub?: ReactNode;
};

/**
 * Bottom slot for the patient journey. This card owns the place, size and empty
 * state; the content comes in as children.
 */
export default function JourneyCard({ asset, children, sub }: Props) {
  const name = asset ? assetName(asset) : null;
  return (
    <section className="lm-glass lm-hud-journey" aria-labelledby="lm-journey-h" data-empty={children ? undefined : ""}>
      <div className="lm-hud-journey-head">
        <b id="lm-journey-h">Journey{name ? <> · <span className="mono">{name}</span></> : null}</b>
        {sub && children ? <span className="lm-hud-journey-sub">{sub}</span> : null}
      </div>
      {children ?? (
        <p className="lm-hud-empty">
          {name ? `Loading the journey of ${name}…` : "Select a patient, a staff member or a bed to see its journey here."}
        </p>
      )}
    </section>
  );
}
