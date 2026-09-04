declare module "cloudflare:test" {
  interface ProvidedEnv {
    KV: KVNamespace;
    SESSION_SECRET: string;
  }
}
