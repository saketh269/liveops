import { NavLink, Navigate, Route, Routes } from "react-router-dom";
import SourcesPage from "./pages/SourcesPage";
import MappingPage from "./pages/MappingPage";
import SitesPage from "./pages/SitesPage";
import LiveMapPage from "./pages/LiveMapPage";
import HealthPage from "./pages/HealthPage";
import "./styles/app.css";
// --- auth-ui --- sign-in and accounts (ADR 0008)
import { AuthProvider, RequireAuth, SignedOutOnly, canEdit, useRole } from "./auth/AuthProvider";
import { AuthGate } from "./auth/AuthLayout";
import UserMenu from "./auth/UserMenu";
import SignInPage from "./auth/pages/SignInPage";
import { SetupPage, SignUpPage } from "./auth/pages/SignUpPage";
import { ForgotPage, InvitePage, ResetPage, VerifyPage } from "./auth/pages/LinkPages";
import AccountPage from "./auth/pages/AccountPage";
import UsersPage from "./auth/pages/UsersPage";
// --- end auth-ui ---

// Order follows how a new customer meets the product: connect, map, design, operate.
const NAV = [
  { to: "/sources", label: "Sources" },
  { to: "/sites", label: "Sites" },
  { to: "/mapping", label: "Mapping studio" },
  { to: "/map", label: "Live map" },
  { to: "/health", label: "Health" },
];

// --- auth-ui --- pages that change things; viewers are sent back to the list
const EDIT_ONLY: [string, string][] = [
  ["/sources/new", "/sources"], ["/sources/:sourceId", "/sources"], ["/mapping/new", "/mapping"],
  ["/mapping/:mappingId/edit", "/mapping"], ["/sites/:siteId/setup", "/sites"],
];

export default function App() {
  return (
    <AuthProvider>
      <AuthGate>
        <Routes>
          <Route path="/signin" element={<SignedOutOnly><SignInPage /></SignedOutOnly>} />
          <Route path="/signup" element={<SignedOutOnly><SignUpPage /></SignedOutOnly>} />
          <Route path="/setup" element={<SignedOutOnly setup><SetupPage /></SignedOutOnly>} />
          <Route path="/forgot" element={<ForgotPage />} />
          <Route path="/reset" element={<ResetPage />} />
          <Route path="/verify" element={<VerifyPage />} />
          <Route path="/invite" element={<InvitePage />} />
          <Route path="*" element={<RequireAuth><Shell /></RequireAuth>} />
        </Routes>
      </AuthGate>
    </AuthProvider>
  );
}
// --- end auth-ui ---

function Shell() {
  const role = useRole(); // --- auth-ui ---
  const nav = role === "wallboard" ? NAV.filter((n) => n.to === "/map") : NAV; // --- auth-ui ---
  return (
    <div className="shell">
      <aside className="nav">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true" />
          <span>Live Ops</span>
        </div>
        <nav>
          {nav.map((n) => (
            <NavLink key={n.to} to={n.to} className={({ isActive }) => (isActive ? "active" : "")}>
              {n.label}
            </NavLink>
          ))}
        </nav>
        <UserMenu />{/* auth-ui */}
      </aside>
      <main className="content">
        <Routes>
          {/* --- auth-ui --- wallboards see the live map only; viewers can't open edit pages */}
          <Route path="/" element={<Navigate to={canEdit(role) ? "/sources" : "/map"} replace />} />
          <Route path="/account" element={<AccountPage />} />
          <Route path="/admin/users" element={<RequireAuth roles={["admin"]}><UsersPage /></RequireAuth>} />
          {!canEdit(role) && EDIT_ONLY.map(([p, to]) => <Route key={p} path={p} element={<Navigate to={to} replace />} />)}
          {role === "wallboard" ? <Route path="*" element={<Navigate to="/map" replace />} /> : <>
          {/* --- end auth-ui --- */}
          <Route path="/sources/*" element={<SourcesPage />} />
          <Route path="/sites/*" element={<SitesPage />} />
          <Route path="/mapping/*" element={<MappingPage />} />
          <Route path="/health" element={<HealthPage />} />
          </>}{/* auth-ui */}
          <Route path="/map/:siteId?" element={<LiveMapPage />} />
        </Routes>
      </main>
    </div>
  );
}
