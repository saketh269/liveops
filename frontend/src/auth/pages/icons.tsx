export function DoneIcon({ bad = false }: { bad?: boolean }) {
  return (
    <span className={`au-done-icon ${bad ? "bad" : ""}`} aria-hidden="true">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
        {bad ? <path d="M7 7l10 10M17 7L7 17" /> : <path d="M5 12.5l4.5 4.5L19 7.5" />}
      </svg>
    </span>
  );
}
