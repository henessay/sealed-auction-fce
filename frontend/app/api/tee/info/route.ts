import { NextResponse } from "next/server";

import { proxyGet } from "@/lib/server/tee-proxy";

export async function GET() {
  const result = await proxyGet("/info");
  if (!result.ok) {
    return NextResponse.json({ error: result.message }, { status: 502 });
  }
  return NextResponse.json(result.data);
}
