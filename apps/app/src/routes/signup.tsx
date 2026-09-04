import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import { ApiError, apiFetch } from "../api-client.ts";

export const Route = createFileRoute("/signup")({ component: Signup });

function Signup() {
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setPending(true);

    const form = new FormData(event.currentTarget);
    try {
      await apiFetch("/api/auth/signup", {
        method: "POST",
        body: JSON.stringify({
          name: form.get("name"),
          email: form.get("email"),
          password: form.get("password"),
          tenantName: form.get("tenantName"),
        }),
      });
      await navigate({ to: "/dashboard" });
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : "Could not create the account");
    } finally {
      setPending(false);
    }
  }

  return (
    <main>
      <h1>Create a workspace</h1>
      <p className="lede">You will be the owner. Other people can be invited later.</p>
      <form onSubmit={onSubmit}>
        <label>
          Your name
          <input name="name" autoComplete="name" required />
        </label>
        <label>
          Email
          <input name="email" type="email" autoComplete="email" required />
        </label>
        <label>
          Password
          <input
            name="password"
            type="password"
            autoComplete="new-password"
            minLength={12}
            required
          />
        </label>
        <label>
          Workspace name
          <input name="tenantName" required />
        </label>
        {error ? <p className="error">{error}</p> : null}
        <button type="submit" disabled={pending}>
          {pending ? "Creating..." : "Create workspace"}
        </button>
      </form>
      <p>
        <Link to="/login">Already have an account?</Link>
      </p>
    </main>
  );
}
