/**
 * Server-side TEE extension proxy client (used by Next.js API routes).
 * Tries EXT_PROXY_URL first, then EXT_PROXY_LOCAL_URL (default localhost:6674).
 */

const NGROK_HOST_HINT = "ngrok";

function proxyCandidates(): string[] {
  const urls: string[] = [];
  const add = (raw: string | undefined) => {
    const u = raw?.trim().replace(/\/$/, "");
    if (u && !urls.includes(u)) urls.push(u);
  };

  add(process.env.EXT_PROXY_URL);
  add(process.env.EXT_PROXY_LOCAL_URL ?? "http://127.0.0.1:6674");

  return urls;
}

function proxyHeaders(url: string): HeadersInit {
  const headers: Record<string, string> = {
    Accept: "application/json",
  };
  if (url.includes(NGROK_HOST_HINT)) {
    headers["ngrok-skip-browser-warning"] = "true";
  }
  return headers;
}

export type ProxyFetchResult = {
  ok: true;
  data: unknown;
  baseUrl: string;
};

export type ProxyFetchError = {
  ok: false;
  message: string;
  attempts: { url: string; status?: number; error?: string }[];
};

export async function proxyGet(
  path: string,
): Promise<ProxyFetchResult | ProxyFetchError> {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  const candidates = proxyCandidates();

  if (candidates.length === 0) {
    return {
      ok: false,
      message:
        "No proxy URL configured. Set EXT_PROXY_URL in frontend/.env.local (see .env.local.example).",
      attempts: [],
    };
  }

  const attempts: ProxyFetchError["attempts"] = [];

  for (const base of candidates) {
    const url = `${base}${normalizedPath}`;
    try {
      const res = await fetch(url, {
        cache: "no-store",
        headers: proxyHeaders(base),
      });
      if (res.ok) {
        const data = await res.json();
        return { ok: true, data, baseUrl: base };
      }
      attempts.push({ url, status: res.status });
    } catch (e) {
      attempts.push({
        url,
        error: e instanceof Error ? e.message : "fetch failed",
      });
    }
  }

  const detail = attempts
    .map((a) =>
      a.status !== undefined
        ? `${a.url} → HTTP ${a.status}`
        : `${a.url} → ${a.error}`,
    )
    .join("; ");

  return {
    ok: false,
    message: `Extension proxy unreachable (${normalizedPath}). Tried: ${detail}. For local dev: run \`bash ./scripts/start-services.sh\` and check EXT_PROXY_URL (curl "$EXT_PROXY_URL/info").`,
    attempts,
  };
}
