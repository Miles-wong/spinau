/**
 * App.tsx - Root component and authentication/routing orchestrator.
 *
 * Responsibilities:
 * 1. Listen to Firebase auth state changes (onAuthStateChanged).
 * 2. Fetch the user's Firestore role (admin | reporter | "") once logged in.
 * 3. Render the correct page tree based on role:
 *    - admin   → /admin/tickets  (default)
 *    - reporter → /my-tickets    (default)
 *    - unknown  → /unauthorized
 * 4. Pass `user`, `role`, and `onLogout` down to every page component.
 *
 * Role-based access is enforced at the route level by redirecting unauthorized
 * users to their own default path instead of showing a 403 page.
 */
import { Suspense, lazy, useEffect, useState } from "react";
import { onAuthStateChanged, signOut } from "firebase/auth";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { auth } from "./firebase";
import { getUserRole } from "./services/AuthService";
import { checkBackendHealth } from "./services/HealthService";
import type { UserInfo, UserRole } from "./types/auth";
import { ToastProvider } from "./components/ToastProvider";

const Login = lazy(() => import("./pages/Login"));
const AdminTicketsPage = lazy(() => import("./pages/AdminTicketsPage"));
const ReporterTicketsPage = lazy(() => import("./pages/ReporterTicketsPage"));
const AdminTicketDetailPage = lazy(() => import("./pages/AdminTicketDetailPage"));
const ReporterTicketDetailPage = lazy(() => import("./pages/ReporterTicketDetailPage"));
const AdminAuditPage = lazy(() => import("./pages/AdminAuditPage"));
const AdminDashboardPage = lazy(() => import("./pages/AdminDashboardPage"));
const ReportIncidentChat = lazy(() => import("./pages/ReportIncidentChat"));
const UnauthorizedPage = lazy(() => import("./pages/UnauthorizedPage"));
const ServerErrorPage = lazy(() => import("./pages/ServerErrorPage"));

export default function App() {
  const [user, setUser] = useState<UserInfo | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [role, setRole] = useState<UserRole>("");
  const [roleReady, setRoleReady] = useState(false);
  const [backendHealthy, setBackendHealthy] = useState<boolean | null>(null);
  const [showServerError, setShowServerError] = useState(false);

  const handleLoginSuccess = (userData: UserInfo) => {
    setUser(userData);
  };

  const handleLogout = async () => {
    try {
      await signOut(auth);
    } finally {
      setUser(null);
      setRole("");
      setRoleReady(false);
    }
  };

  // Check backend health on app load
  useEffect(() => {
    const checkHealth = async () => {
      const result = await checkBackendHealth();
      // Only show error if there are actual errors, not just warnings
      if (result.status?.config?.errors && result.status.config.errors.length > 0) {
        setShowServerError(true);
      } else if (!result.healthy && !result.status) {
        setShowServerError(true);
      }
      setBackendHealthy(result.healthy);
    };

    checkHealth();
    // Check every 30 seconds to detect if backend comes back online
    const interval = setInterval(checkHealth, 30000);

    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (firebaseUser) => {
      if (firebaseUser) {
        setUser({
          email: firebaseUser.email,
          name: firebaseUser.displayName || firebaseUser.email?.split("@")[0] || "",
          uid: firebaseUser.uid,
        });
      } else {
        setUser(null);
      }
      setAuthReady(true);
    });

    return () => unsubscribe();
  }, []);

  useEffect(() => {
    const loadRole = async () => {
      if (!user) {
        setRole("");
        setRoleReady(false);
        return;
      }

      setRoleReady(false);
      try {
        const nextRole = await getUserRole(user.uid);
        if (nextRole === "admin" || nextRole === "reporter") {
          setRole(nextRole);
        } else {
          setRole("");
        }
      } catch {
        setRole("");
      } finally {
        setRoleReady(true);
      }
    };

    loadRole();
  }, [user]);

  const defaultPath = role === "admin" ? "/admin/dashboard" : role === "reporter" ? "/my-tickets" : "/unauthorized";

  // Show loading while checking backend health
  if (backendHealthy === null) {
    return (
      <div className="flex items-center justify-center h-screen bg-gray-50">
        <div className="text-center">
          <div className="inline-block animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600"></div>
          <p className="mt-4 text-gray-600">Loading...</p>
        </div>
      </div>
    );
  }

  // Show server error if backend is not healthy
  if (showServerError || !backendHealthy) {
    return (
      <ServerErrorPage
        onRetry={() => {
          setShowServerError(false);
          window.location.reload();
        }}
      />
    );
  }

  return (
    <ToastProvider>
      <BrowserRouter>
        <Suspense
          fallback={
            <div className="flex min-h-screen items-center justify-center bg-[#dde3ea] text-slate-600">
              Loading...
            </div>
          }
        >
          {!authReady ? (
            <div className="flex min-h-screen items-center justify-center bg-[#dde3ea] text-slate-600">
              Loading...
            </div>
          ) : !user ? (
            <Routes>
              <Route path="/login" element={<Login onLoginSuccess={handleLoginSuccess} />} />
              <Route path="*" element={<Navigate to="/login" replace />} />
            </Routes>
          ) : !roleReady ? (
            <div className="flex min-h-screen items-center justify-center bg-[#dde3ea] text-slate-600">
              Loading role...
            </div>
          ) : (
            <Routes>
              <Route path="/" element={<Navigate to={defaultPath} replace />} />
              <Route path="/login" element={<Navigate to={defaultPath} replace />} />

              {/* Admin Routes */}
              <Route
                path="/admin/dashboard"
                element={
                  role === "admin" ? (
                    <AdminDashboardPage user={user} role="admin" onLogout={handleLogout} />
                  ) : (
                    <Navigate to={defaultPath} replace />
                  )
                }
              />

              <Route
                path="/admin/tickets"
                element={
                  role === "admin" ? (
                    <AdminTicketsPage user={user} role="admin" onLogout={handleLogout} />
                  ) : (
                    <Navigate to={defaultPath} replace />
                  )
                }
              />

              <Route
                path="/admin/tickets/:id"
                element={
                  role === "admin" ? (
                    <AdminTicketDetailPage user={user} role="admin" onLogout={handleLogout} />
                  ) : (
                    <Navigate to={defaultPath} replace />
                  )
                }
              />

              <Route
                path="/admin/audit"
                element={
                  role === "admin" ? (
                    <AdminAuditPage user={user} role="admin" onLogout={handleLogout} />
                  ) : (
                    <Navigate to={defaultPath} replace />
                  )
                }
              />

              {/* Reporter pages Routes */}
              <Route
                path="/report-chat"
                element={
                  role === "reporter" || role === "admin" ? (
                    <ReportIncidentChat user={user} role={role} onLogout={handleLogout} />
                  ) : (
                    <Navigate to={defaultPath} replace />
                  )
                }
              />
              <Route
                path="/my-tickets"
                element={
                  role === "reporter" ? (
                    <ReporterTicketsPage user={user} role="reporter" onLogout={handleLogout} />
                  ) : (
                    <Navigate to={defaultPath} replace />
                  )
                }
              />
              <Route
                path="/tickets/:id"
                element={
                  role === "reporter" ? (
                    <ReporterTicketDetailPage user={user} role="reporter" onLogout={handleLogout} />
                  ) : (
                    <Navigate to={defaultPath} replace />
                  )
                }
              />

              {/* Reporter legacy path redirects */}
              <Route path="/reporter/tickets" element={<Navigate to="/my-tickets" replace />} />
              <Route
                path="/reporter/tickets/:id"
                element={
                  role === "reporter" ? (
                    <ReporterTicketDetailPage user={user} role="reporter" onLogout={handleLogout} />
                  ) : (
                    <Navigate to={defaultPath} replace />
                  )
                }
              />

              <Route
                path="/unauthorized"
                element={<UnauthorizedPage onLogout={handleLogout} />}
              />

              <Route path="*" element={<Navigate to={defaultPath} replace />} />
            </Routes>
          )}
        </Suspense>
      </BrowserRouter>
    </ToastProvider>
  );
}
