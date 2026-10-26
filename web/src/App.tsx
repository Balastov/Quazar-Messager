import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { useAuthStore } from "./store/auth";
import AuthPage from "./pages/AuthPage";
import MessengerPage from "./pages/MessengerPage";
import GuestPage from "./pages/GuestPage";

function PrivateRoute({ children }: { children: React.ReactNode }) {
  const token = useAuthStore((s) => s.token);
  return token ? <>{children}</> : <Navigate to="/auth" replace />;
}

function PublicRoute({ children }: { children: React.ReactNode }) {
  const token = useAuthStore((s) => s.token);
  return token ? <Navigate to="/" replace /> : <>{children}</>;
}

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route
          path="/auth"
          element={
            <PublicRoute>
              <AuthPage />
            </PublicRoute>
          }
        />
        {/* Гость по ссылке в комнату — без входа в аккаунт. */}
        <Route path="/guest/:code" element={<GuestPage />} />
        <Route
          path="/*"
          element={
            <PrivateRoute>
              <MessengerPage />
            </PrivateRoute>
          }
        />
      </Routes>
    </BrowserRouter>
  );
}
