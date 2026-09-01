import type { FetchLike } from "../src/http.js";

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

export function mockFetch(
  implementation: (url: URL, init: RequestInit | undefined) => Response | Promise<Response>
): FetchLike {
  return async (input, init) => {
    const raw = input instanceof Request ? input.url : input.toString();
    return implementation(new URL(raw), init);
  };
}

export async function flushPromises(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}
