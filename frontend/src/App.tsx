import { NavLink, Navigate, Route, Routes } from "react-router-dom";
import SourcesPage from "./pages/SourcesPage";
import MappingPage from "./pages/MappingPage";
import SitesPage from "./pages/SitesPage";
import LiveMapPage from "./pages/LiveMapPage";
import HealthPage from "./pages/HealthPage";
import "./styles/app.css";

// Order follows how a new customer meets the product: connect, map, design, operate.
const NAV = [
  { to: "/sources", label: "Sources" },
  { to: "/sites", label: "Sites" },
  { to: "/mapping", label: "Mapping studio" },
  { to: "/map", label: "Live map" },
  { to: "/health", label: "Health" },
];

export default function App() {
  return (
    <div className="shell">
      <aside className="nav">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true" />
          <span>Live Ops</span>
        </div>
        <nav>
          {NAV.map((n) => (
            <NavLink key={n.to} to={n.to} className={({ isActive }) => (isActive ? "active" : "")}>
              {n.label}
            </NavLink>
          ))}
        </nav>
      </aside>
      <main className="content">
        <Routes>
          <Route path="/" element={<Navigate to="/sources" replace />} />
          <Route path="/sources/*" element={<SourcesPage />} />
          <Route path="/sites/*" element={<SitesPage />} />
          <Route path="/mapping/*" element={<MappingPage />} />
          <Route path="/map/:siteId?" element={<LiveMapPage />} />
          <Route path="/health" element={<HealthPage />} />
        </Routes>
      </main>
    </div>
  );
}
