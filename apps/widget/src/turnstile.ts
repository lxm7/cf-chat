/**
 * The Turnstile seam.
 *
 * An interface with a fixture, following the rule that tests use fixture
 * implementations and never live bindings, the same way `Retriever`,
 * `Generator` and `Indexer` are treated. Without it every test of the gate
 * would have to reach `challenges.cloudflare.com`, which would make the gate
 * effectively untested.
 */
export interface TurnstileVerifier {
  /** True when the token is a genuine, unspent solve for this site. */
  verify(token: string, remoteIp: string | null): Promise<boolean>;
}

const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

/** The real one. */
export class CloudflareTurnstile implements TurnstileVerifier {
  readonly #secret: string;

  constructor(secret: string) {
    this.#secret = secret;
  }

  async verify(token: string, remoteIp: string | null): Promise<boolean> {
    const body = new FormData();
    body.append("secret", this.#secret);
    body.append("response", token);
    if (remoteIp) {
      body.append("remoteip", remoteIp);
    }

    try {
      const response = await fetch(SITEVERIFY_URL, { method: "POST", body });
      if (!response.ok) {
        return false;
      }
      const outcome: unknown = await response.json();
      return (
        typeof outcome === "object" &&
        outcome !== null &&
        (outcome as { success?: unknown }).success === true
      );
    } catch (cause) {
      // Fail closed. An unreachable siteverify is indistinguishable from one
      // that would have refused, and this gate is the reason the visitor token
      // means anything (ADR-016).
      console.error("Turnstile siteverify failed", cause);
      return false;
    }
  }
}

/** Answers however it was told to, so a test can assert both sides of the gate. */
export class FixtureTurnstile implements TurnstileVerifier {
  readonly seen: { token: string; remoteIp: string | null }[] = [];
  #result: boolean;

  constructor(result = true) {
    this.#result = result;
  }

  async verify(token: string, remoteIp: string | null): Promise<boolean> {
    this.seen.push({ token, remoteIp });
    return this.#result;
  }
}
