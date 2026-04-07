const BACKEND_URL = process.env.BACKEND_URL || "http://127.0.0.1:8000";

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const afterId = searchParams.get("afterId") || "0";
  const response = await fetch(`${BACKEND_URL}/results?afterId=${afterId}`, {
    method: "GET",
    cache: "no-store"
  });
  const data = await response.json();
  return Response.json(data, { status: response.status });
}
