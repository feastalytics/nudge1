import { NextResponse } from "next/server";
import { getFeastConfig, isFeastMode } from "@/lib/feast/config";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const url = isFeastMode() ? getFeastConfig().sourceUrl : "https://github.com/mike1ros-gh/nudge1";
    const response = NextResponse.redirect(url, 307);
    response.headers.set("Cache-Control", "no-store");
    return response;
  } catch {
    return NextResponse.json({ error: "Matching source URL is not configured." }, { status: 503 });
  }
}
