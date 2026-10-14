import { useState } from "react";
import { NavLink, Outlet } from "react-router-dom";
import { currentUser, DEMO_USERS, setCurrentUser } from "../lib/user";
import { isDesktop } from "../lib/desktop";

const NAV = [
  { to: "/", label: "Today", end: true },
  { to: "/workers", label: "Workers" },
  { to: "/renewals", label: "Renewals" },
  // Printing without dialogs only exists in the desktop app.
  ...(isDesktop() ? [{ to: "/printers", label: "Printers" }] : []),
];

export function Layout() {
  const [user, setUser] = useState(currentUser());
  return (
    <div className="shell">
      <aside className="sidebar">
        <p className="brand">Workforce</p>
        <nav aria-label="Main">
          {NAV.map((n) => (
            <NavLink key={n.to} to={n.to} end={n.end} className="nav-link">
              {n.label}
            </NavLink>
          ))}
        </nav>
        <label className="user-switch">
          Working as
          <select
            value={user}
            onChange={(e) => {
              setCurrentUser(e.target.value);
              setUser(e.target.value);
            }}
          >
            {DEMO_USERS.map((u) => (
              <option key={u}>{u}</option>
            ))}
          </select>
        </label>
      </aside>
      <main className="main">
        <Outlet />
      </main>
    </div>
  );
}
