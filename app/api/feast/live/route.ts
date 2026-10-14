import { NextResponse } from "next/server";
import { getFeastConfig, isFeastMode } from "@/lib/feast/config";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    if (isFeastMode()) getFeastConfig();
    return NextResponse.json({ status: "ok" }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ status: "unavailable" }, { status: 503 });
  }
}
