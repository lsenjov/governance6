import { Routes, Route, Link, Navigate } from "react-router-dom";
import { Authenticated, Unauthenticated, AuthLoading, useQuery } from "convex/react";
import { useAuthActions } from "@convex-dev/auth/react";
import { api } from "../convex/_generated/api";
import { SignInPage } from "./pages/SignInPage";
import { ProfilePage } from "./pages/ProfilePage";
import { SyndicatesListPage } from "./pages/SyndicatesListPage";
import { SyndicateEditorPage } from "./pages/SyndicateEditorPage";
import { SharedSyndicatesPage } from "./pages/SharedSyndicatesPage";
import { GamesListPage } from "./pages/GamesListPage";
import { GameDetailPage } from "./pages/GameDetailPage";
import { AdminPage } from "./pages/AdminPage";

function TopNav() {
  const { signOut } = useAuthActions();
  const me = useQuery(api.users.getMe);
  return (
    <nav className="top-nav">
      <div className="nav-links">
        <Link to="/games">Games</Link>
        <Link to="/syndicates">My Syndicates</Link>
        <Link to="/syndicates/shared">Shared Syndicates</Link>
        <Link to="/profile">Profile</Link>
        {me?.isSiteAdmin && <Link to="/admin">Admin</Link>}
      </div>
      <button type="button" onClick={() => void signOut()}>
        Sign out
      </button>
    </nav>
  );
}

export default function App() {
  return (
    <>
      <AuthLoading>
        <div className="centered-loader">Loading…</div>
      </AuthLoading>
      <Unauthenticated>
        <SignInPage />
      </Unauthenticated>
      <Authenticated>
        <div className="app-shell">
          <TopNav />
          <main className="main-content">
            <Routes>
              <Route path="/" element={<Navigate to="/games" replace />} />
              <Route path="/profile" element={<ProfilePage />} />
              <Route path="/syndicates" element={<SyndicatesListPage />} />
              <Route
                path="/syndicates/shared"
                element={<SharedSyndicatesPage />}
              />
              <Route
                path="/syndicates/:syndicateId"
                element={<SyndicateEditorPage />}
              />
              <Route path="/games" element={<GamesListPage />} />
              <Route path="/games/:gameId" element={<GameDetailPage />} />
              <Route path="/admin" element={<AdminPage />} />
              <Route path="*" element={<Navigate to="/games" replace />} />
            </Routes>
          </main>
        </div>
      </Authenticated>
    </>
  );
}
