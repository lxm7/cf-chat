import { createRootRoute, HeadContent, Link, Scripts } from "@tanstack/react-router";
import type { ReactNode } from "react";
import appCss from "../styles.css?url";

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "cf-chat" },
    ],
    links: [
      { rel: "stylesheet", href: appCss },
      // Without an explicit icon the browser asks for /favicon.ico on every
      // page load, which falls through to the SSR handler and renders the
      // router's not-found route.
      { rel: "icon", href: "/favicon.svg", type: "image/svg+xml" },
    ],
  }),
  shellComponent: RootDocument,
  notFoundComponent: NotFound,
});

function NotFound() {
  return (
    <main>
      <h1>Page not found</h1>
      <p className="lede">That address does not match anything here.</p>
      <p>
        <Link to="/">Back to the start</Link>
      </p>
    </main>
  );
}

function RootDocument({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}
