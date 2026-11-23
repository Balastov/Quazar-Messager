import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { useAuthStore } from "./store/auth";
import AuthPage from "./pages/AuthPage";
import MessengerPage from "./pages/MessengerPage";
import GuestPage from "./pages/GuestPage";
import YandexAuthPage from "./pages/YandexAuthPage";
import DeviceConnectPage from "./pages/DeviceConnectPage";
import OAuthAuthorizePage from "./pages/OAuthAuthorizePage";
import { pathAfterLogin } from "./auth/returnAfterLogin";

function PrivateRoute({ children }: { children: React.ReactNode }) {
  const token = useAuthStore((s) => s.token);
  return token ? <>{children}</> : <Navigate to="/auth" replace />;
}

function PublicRoute({ children }: { children: React.ReactNode }) {
  const token = useAuthStore((s) => s.token);
  return token ? <Navigate to={pathAfterLogin()} replace /> : <>{children}</>;
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
        {/* Возврат из Яндекса: и вход, и привязка к уже открытому аккаунту. */}
        <Route path="/auth/yandex" element={<YandexAuthPage />} />
        <Route path="/connect" element={<DeviceConnectPage />} />
        {/* «Войти в Padma через Квазар»: вход, подтверждение телефона, «Продолжить» (docs/PADMA-SSO.md). */}
        <Route path="/oauth/authorize" element={<OAuthAuthorizePage />} />
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
