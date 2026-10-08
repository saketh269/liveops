// Header menu with the signed-in user's name: My account, Users (admins), Sign out.
// Menu-button pattern: arrow keys move between items, Escape closes and returns focus.
import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "./AuthProvider";
import { roleLabel } from "./pages/format";
import "./auth.css";

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "") + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase() || "?";
}

export default function UserMenu() {
  const { user, signOut } = useAuth();
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const id = useId();

  const items = () => [...(menu.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
  useEffect(() => {
    if (!open) return;
    menu.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    const away = (e: MouseEvent) => { if (!wrap.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, [open]);

  if (!user) return null;
  const close = (refocus = true) => { setOpen(false); if (refocus) btn.current?.focus(); };
  const onMenuKey = (e: KeyboardEvent) => {
    const list = items();
    const i = list.indexOf(document.activeElement as HTMLElement);
    if (e.key === "Escape") { e.preventDefault(); close(); }
    else if (e.key === "ArrowDown") { e.preventDefault(); list[(i + 1) % list.length]?.focus(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); list[(i - 1 + list.length) % list.length]?.focus(); }
    else if (e.key === "Home") { e.preventDefault(); list[0]?.focus(); }
    else if (e.key === "End") { e.preventDefault(); list[list.length - 1]?.focus(); }
    else if (e.key === "Tab") setOpen(false);
  };

  return (
    <div className="au-user" ref={wrap}>
      <button
        ref={btn} type="button" className="au-user-btn" aria-haspopup="menu" aria-expanded={open} aria-label={`${user.name}, account menu`} aria-controls={open ? id : undefined}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => { if (e.key === "ArrowDown") { e.preventDefault(); setOpen(true); } }}
      >
        <span className="au-avatar" aria-hidden="true">{initials(user.name)}</span>
        <span className="au-user-name">{user.name}</span>
        <span className="au-caret" aria-hidden="true">▾</span>
      </button>
      {open && (
        <div className="au-menu" role="menu" id={id} ref={menu} aria-label="Account" onKeyDown={onMenuKey}>
          <div className="au-menu-head" role="none"><strong>{user.name}</strong>{user.email} · {roleLabel(user.role)}</div>
          <Link role="menuitem" to="/account" tabIndex={-1} onClick={() => close(false)}>My account</Link>
          {user.role === "admin" && <Link role="menuitem" to="/admin/users" tabIndex={-1} onClick={() => close(false)}>Users</Link>}
          <button role="menuitem" type="button" tabIndex={-1} onClick={() => { setOpen(false); void signOut(); }}>Sign out</button>
        </div>
      )}
    </div>
  );
}
