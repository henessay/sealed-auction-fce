import { NextResponse } from "next/server";

import { proxyGet } from "@/lib/server/tee-proxy";

const MAX_ATTEMPTS = 15;
const RETRY_MS = 2000;

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  const instructionId = id.startsWith("0x") ? id : `0x${id}`;
  const path = `/action/result/${instructionId}`;

  // ?peek=1 — single shot, used by the per-bid TEE status indicators. It must
  // never block: "no result yet" and "proxy down" are answers, not failures.
  if (new URL(request.url).searchParams.get("peek") === "1") {
    const probe = await proxyGet(path);
    if (probe.ok) {
      const payload = probe.data as { result?: { status?: number } };
      if (payload?.result?.status === 1) return NextResponse.json(probe.data);
      return NextResponse.json({ pending: true }, { status: 404 });
    }
    // No HTTP status on any attempt means we never reached the proxy at all.
    const reachable = probe.attempts.some((a) => a.status !== undefined);
    return NextResponse.json(
      { pending: true, error: probe.message },
      { status: reachable ? 404 : 503 },
    );
  }

  let lastError = "Action result not ready";

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const result = await proxyGet(path);
    if (result.ok) {
      const payload = result.data as {
        result?: { status?: number; log?: string };
      };
      const status = payload?.result?.status;
      if (status === 1) {
        return NextResponse.json(result.data);
      }
      // Status 0 can be a transient tee-node timeout before the result lands.
      lastError = payload?.result?.log ?? `TEE action status ${String(status)}`;
    } else {
      lastError = result.message;
      const retryable = result.attempts.some(
        (a) => a.status === undefined || a.status === 404 || a.status >= 500,
      );
      if (!retryable && attempt === 0) {
        return NextResponse.json({ error: lastError }, { status: 502 });
      }
    }
    await new Promise((r) => setTimeout(r, RETRY_MS));
  }

  return NextResponse.json(
    { error: `${lastError} (polled ${MAX_ATTEMPTS} times)` },
    { status: 504 },
  );
}
