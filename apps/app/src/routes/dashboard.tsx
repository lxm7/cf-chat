import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { ApiError, apiFetch, type MeResponse } from "../api-client.ts";

export const Route = createFileRoute("/dashboard")({ component: Dashboard });

function Dashboard() {
  const navigate = useNavigate();
  const [me, setMe] = useState<MeResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setMe(await apiFetch<MeResponse>("/api/auth/me"));
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 401) {
        await navigate({ to: "/login" });
        return;
      }
      setError(cause instanceof Error ? cause.message : "Could not load the workspace");
    }
  }, [navigate]);

  useEffect(() => {
    void load();
  }, [load]);

  async function switchTenant(tenantId: string) {
    setError(null);
    try {
      await apiFetch("/api/session/tenant", { method: "POST", body: JSON.stringify({ tenantId }) });
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not switch workspace");
    }
  }

  async function logout() {
    await apiFetch("/api/auth/logout", { method: "POST" });
    await navigate({ to: "/login" });
  }

  if (error) {
    return (
      <main>
        <h1>Dashboard</h1>
        <p className="error">{error}</p>
      </main>
    );
  }

  if (!me) {
    return (
      <main>
        <h1>Dashboard</h1>
        <p className="lede">Loading...</p>
      </main>
    );
  }

  return (
    <main>
      <h1>Dashboard</h1>
      <p className="lede">Signed in. The inbox and widget config arrive in later build steps.</p>

      <nav>
        <Link to="/sources">Knowledge sources</Link>
      </nav>

      <h2>Workspaces</h2>
      <ul className="tenants">
        {me.tenants.map((tenant) => (
          <li key={tenant.tenantId}>
            <span>
              {tenant.name} <span className="role">{tenant.role}</span>
            </span>
            {tenant.tenantId === me.activeTenantId ? (
              <span className="role">active</span>
            ) : (
              <button
                type="button"
                className="secondary"
                onClick={() => void switchTenant(tenant.tenantId)}
              >
                Switch
              </button>
            )}
          </li>
        ))}
      </ul>

      <button type="button" className="secondary" onClick={() => void logout()}>
        Sign out
      </button>
    </main>
  );
}
