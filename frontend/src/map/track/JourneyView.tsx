import type { Asset, AssetHistory } from "../../api/types";
import { isBed, isPatient, isStaff } from "../hud/model";
import { clock, fmtDur, sayDur } from "../hud/time";
import { sinceText } from "./HistoryPanel";
import { journeyFor, type BedJourney, type PatientJourney, type StaffJourney, type Step } from "./journey";

type Props = { asset: Asset; history: AssetHistory; now: number };

export function journeyModel(a: Asset): "patient" | "staff" | "bed" | "other" {
  return isPatient(a) ? "patient" : isBed(a) ? "bed" : isStaff(a) ? "staff" : "other";
}

/** The journey card's content for the selected record. */
export default function JourneyView({ asset, history, now }: Props) {
  const j = journeyFor(journeyModel(asset), history, now);
  if (j.kind === "patient") return <PatientSteps j={j} />;
  if (j.kind === "staff") return <StaffRooms j={j} history={history} />;
  if (j.kind === "bed") return <BedStates j={j} now={now} />;
  if (j.entries.length === 0) return <p className="lm-hud-empty">No changes recorded yet. {sinceText(history)}.</p>;
  return (
    <ol className="lm-track-strip" aria-label="Latest changes">
      {j.entries.map((e) => <li key={`${e.ts}${e.kind}`}><time className="mono">{clock(e.ts)}</time> {e.text}</li>)}
    </ol>
  );
}

function stepWhen(s: Step): string {
  if (s.state === "stuck") return `${s.key === "boarding" ? "boarding" : "waiting"} ${fmtDur(s.elapsed ?? 0)}`;
  if (s.state === "now") return s.elapsed !== undefined ? `${fmtDur(s.elapsed)} so far` : "now";
  if (s.state === "skipped") return "skipped";
  if (s.at !== null) return `${s.atLeast ? "by " : ""}${clock(s.at)}`;
  if (s.state === "done") return "earlier";
  return "";
}

function PatientSteps({ j }: { j: PatientJourney }) {
  const n = j.steps.length;
  const fill = j.current <= 0 ? 0 : (84 * Math.min(j.current, n - 1)) / (n - 1);
  return (
    <>
      <div className="lm-track-steps-wrap">
      <span className="lm-track-steps-fill" style={{ width: `${fill}%` }} aria-hidden="true" />
      <ol className="lm-track-steps" style={{ gridTemplateColumns: `repeat(${n}, 1fr)` }} aria-label="Care steps">
        {j.steps.map((s, i) => (
          <li key={s.key} className={`lm-track-jstep lm-track-jstep--${s.state}`} aria-current={s.state === "now" || s.state === "stuck" ? "step" : undefined}>
            <span className="lm-track-dot" aria-hidden="true">{s.state === "done" ? "✓" : i + 1}</span>
            <span className="lm-track-jlabel">{s.label}</span>
            <span className="lm-track-jwhen mono">{stepWhen(s)}</span>
            <span className="lm-sr">{s.state === "stuck" ? `, stuck for ${sayDur(s.elapsed ?? 0)}` : s.state === "done" ? ", done" : s.state === "now" ? ", current step" : ""}</span>
          </li>
        ))}
      </ol>
      </div>
      {j.left && <p className="lm-hud-empty lm-track-note">No longer on the map: the source stopped listing this patient (discharged or left).</p>}
    </>
  );
}

function StaffRooms({ j, history }: { j: StaffJourney; history: AssetHistory }) {
  if (j.visits.length === 0) return <p className="lm-hud-empty">No room changes today. {sinceText(history)}.</p>;
  return (
    <ol className="lm-track-strip" aria-label="Rooms today, oldest first">
      {j.visits.map((v) => (
        <li key={v.from} className={v.ongoing ? "lm-track-strip-now" : undefined}>
          <time className="mono">{clock(v.from)}</time> <b>{v.place}</b>
          <small>{v.to !== null ? fmtDur(v.to - v.from) : v.ongoing ? "now" : ""}</small>
        </li>
      ))}
    </ol>
  );
}

function BedStates({ j, now }: { j: BedJourney; now: number }) {
  const spans = j.spans.slice(-6);
  if (spans.length === 0) return <p className="lm-hud-empty">No state changes recorded yet.</p>;
  const t = j.turnaround;
  return (
    <>
      <ol className="lm-track-strip" aria-label="Bed states, oldest first">
        {spans.map((s) => (
          <li key={s.from} className={s.to === null ? "lm-track-strip-now" : undefined}>
            <time className="mono">{clock(s.from)}</time> <b>{s.status}</b>
            <small>{fmtDur((s.to ?? now) - s.from)}{s.to === null ? " so far" : ""}</small>
          </li>
        ))}
      </ol>
      {t && (
        <p className="lm-track-note">
          Dirty to clean: <b className="mono">{fmtDur(t.seconds)}</b>
          {t.cleanAt === null ? " so far (not clean yet)" : ` (${clock(t.dirtyAt)} to ${clock(t.cleanAt)})`}
        </p>
      )}
    </>
  );
}
