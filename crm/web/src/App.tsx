import { useEffect, useState, useCallback } from "react";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { api } from "./api";
import { AppProvider, type Me, type Settings } from "./lib/app";
import { ToastProvider, ConfirmProvider, Spinner } from "./components/ui";
import { Layout } from "./components/Layout";
import { Login } from "./pages/Login";
import { Dashboard } from "./pages/Dashboard";
import { MyDayPage } from "./pages/MyDay";
import { TasksPage } from "./pages/Tasks";
import { ContactsPage, DuplicatesPage } from "./pages/Contacts";
import { ContactDetailPage } from "./pages/ContactDetail";
import { CompaniesPage, CompanyDetailPage } from "./pages/Companies";
import { DealsPage } from "./pages/Deals";
import { DealDetailPage } from "./pages/DealDetail";
import { TicketsPage, TicketDetailPage } from "./pages/Tickets";
import { ListsPage, ListDetailPage } from "./pages/Lists";
import { ProductsPage, QuotesPage } from "./pages/Products";
import { ReportsPage } from "./pages/Reports";
import { SettingsPage } from "./pages/Settings";

type MeResp = { user: Me | null; settings?: Settings; requires_2fa?: boolean };

export default function App() {
  const [state, setState] = useState<{ loading: boolean; me: Me | null; settings: Settings | null }>({ loading: true, me: null, settings: null });
  const load = useCallback(async () => {
    try { const r = await api.get<MeResp>("auth/me"); setState({ loading: false, me: r.user, settings: r.settings ?? null }); }
    catch { setState({ loading: false, me: null, settings: null }); }
  }, []);
  useEffect(() => { load(); }, [load]);
  const logout = useCallback(() => setState({ loading: false, me: null, settings: null }), []);
  if (state.loading) return <div className="login"><Spinner /></div>;
  return (
    <ToastProvider>
      <ConfirmProvider>
        <BrowserRouter>
          {!state.me || !state.settings ? (
            <Routes><Route path="*" element={<Login onLogin={load} />} /></Routes>
          ) : (
            <AppProvider me={state.me} settings={state.settings} onLogout={logout}>
              <Layout onLogout={logout}>
                <Routes>
                  <Route path="/" element={<Dashboard />} />
                  <Route path="/mi-dia" element={<MyDayPage />} />
                  <Route path="/contactos" element={<ContactsPage />} />
                  <Route path="/contactos/duplicados" element={<DuplicatesPage />} />
                  <Route path="/contactos/:id" element={<ContactDetailPage />} />
                  <Route path="/empresas" element={<CompaniesPage />} />
                  <Route path="/empresas/:id" element={<CompanyDetailPage />} />
                  <Route path="/negocios" element={<DealsPage />} />
                  <Route path="/negocios/:id" element={<DealDetailPage />} />
                  <Route path="/tareas" element={<TasksPage />} />
                  <Route path="/tickets" element={<TicketsPage />} />
                  <Route path="/tickets/:id" element={<TicketDetailPage />} />
                  <Route path="/listas" element={<ListsPage />} />
                  <Route path="/listas/:id" element={<ListDetailPage />} />
                  <Route path="/productos" element={<ProductsPage />} />
                  <Route path="/presupuestos" element={<QuotesPage />} />
                  <Route path="/informes" element={<ReportsPage />} />
                  <Route path="/ajustes/*" element={<SettingsPage />} />
                  <Route path="*" element={<Navigate to="/" replace />} />
                </Routes>
              </Layout>
            </AppProvider>
          )}
        </BrowserRouter>
      </ConfirmProvider>
    </ToastProvider>
  );
}
