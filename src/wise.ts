import { createSign, randomUUID } from "node:crypto";

export const API_VERSION = "2026Q4";
const HOSTS = {
  sandbox: "https://api.wise-sandbox.com",
  production: "https://api.wise.com",
} as const;
export type WiseEnv = keyof typeof HOSTS;

type Query = Record<string, string | number | boolean | undefined>;

export interface WiseClient {
  request(method: string, path: string, opts?: { query?: Query; body?: unknown }): Promise<string>;
}

export function createWiseClient(opts: { token: string; env: WiseEnv; privateKey?: string }): WiseClient {
  const base = `${HOSTS[opts.env]}/${API_VERSION}`;

  return {
    async request(method, path, { query, body } = {}) {
      const url = new URL(base + path);
      for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined) url.searchParams.set(k, String(v));

      const headers: Record<string, string> = {
        Authorization: `Bearer ${opts.token}`,
        Accept: "application/json",
        "X-External-Correlation-Id": randomUUID(),
      };
      if (body !== undefined) headers["Content-Type"] = "application/json";
      const send = (extra: Record<string, string> = {}) =>
        fetch(url, { method, headers: { ...headers, ...extra }, body: body === undefined ? undefined : JSON.stringify(body) });

      let res = await send();

      // SCA: Wise answers 403 with a one-time token that must be signed (SHA256withRSA) and replayed.
      const ott = res.headers.get("x-2fa-approval");
      if (res.status === 403 && ott && res.headers.get("x-2fa-approval-result") === "REJECTED") {
        if (!opts.privateKey) {
          throw new Error(
            "Wise requires Strong Customer Authentication for this call. Set WISE_PRIVATE_KEY_PATH to the RSA private key " +
              "whose public key is uploaded in Wise (Settings > API tokens > Manage public keys).",
          );
        }
        const signature = createSign("SHA256").update(ott).sign(opts.privateKey, "base64");
        res = await send({ "x-2fa-approval": ott, "X-Signature": signature });
      }

      // Returned verbatim: Wise IDs are int64, so avoid a JSON round-trip that could round them.
      const text = await res.text();
      if (!res.ok) {
        const trace = res.headers.get("x-trace-id");
        throw new Error(`Wise API ${method} ${path} failed with HTTP ${res.status}${trace ? ` (x-trace-id ${trace})` : ""}: ${text.slice(0, 4000)}`);
      }
      return text;
    },
  };
}
