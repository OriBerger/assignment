const BACKEND_URL = process.env.BACKEND_URL || "http://127.0.0.1:8000";

/**
 * Proxies session reset to FastAPI POST /session/clear so the UI can clear queue and history server-side.
 */
export async function POST() {
  const response = await fetch(`${BACKEND_URL}/session/clear`, {
    method: "POST",
    cache: "no-store"
  });
  const data = await response.json();
  return Response.json(data, { status: response.status });
}
