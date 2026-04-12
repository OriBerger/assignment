const BACKEND_URL = process.env.BACKEND_URL || "http://127.0.0.1:8000";

/**
 * Proxies RAM usage from FastAPI GET /runtime/memory; on fetch failure returns a 502 JSON error for the HUD.
 */
export async function GET() {
  try {
    const response = await fetch(`${BACKEND_URL}/runtime/memory`, {
      method: "GET",
      cache: "no-store"
    });
    const data = await response.json();
    return Response.json(data, { status: response.status });
  } catch (error) {
    return Response.json(
      {
        ok: false,
        error: "runtime memory unavailable",
        detail: String(error)
      },
      { status: 502 }
    );
  }
}
