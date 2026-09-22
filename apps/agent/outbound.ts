// This executes in Workers, never inside the Linux container.
export async function forwardOpenAI(
  request: Request,
  env: { CODEX_API_KEY: unknown },
  send: typeof fetch = fetch,
): Promise<Response> {
  const url = new URL(request.url);
  if (
    url.origin !== "https://api.openai.com" ||
    request.method !== "POST" ||
    !["/v1/responses", "/v1/responses/compact"].includes(url.pathname)
  ) {
    return new Response("Forbidden", { status: 403 });
  }
  if (typeof env.CODEX_API_KEY !== "string" || !env.CODEX_API_KEY)
    return new Response("Model credentials unavailable", { status: 503 });
  const upstream = new Request(request, { redirect: "error" });
  upstream.headers.set("Authorization", `Bearer ${env.CODEX_API_KEY}`);
  // Do not let sandbox code select an unrelated billing project/organization.
  upstream.headers.delete("OpenAI-Organization");
  upstream.headers.delete("OpenAI-Project");
  try {
    return await send(upstream);
  } catch {
    return new Response("Model request failed", { status: 502 });
  }
}
