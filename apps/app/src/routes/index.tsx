import { createFileRoute, Link } from "@tanstack/react-router";

export const Route = createFileRoute("/")({ component: Home });

function Home() {
  return (
    <main>
      <h1>cf-chat</h1>
      <p className="lede">
        AI support widget, help centre and shared inbox, on Cloudflare Workers.
      </p>
      <nav>
        <Link to="/signup">Create a workspace</Link>
        <Link to="/login">Sign in</Link>
      </nav>
    </main>
  );
}
