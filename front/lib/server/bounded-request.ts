import "server-only";
import { SiwsError } from "@/lib/server/siws";
/** Enforce the byte cap for streamed and chunked bodies as well as Content-Length. */
export async function boundedRequest(request: Request, maximumBytes: number) {
  if (Number(request.headers.get("content-length")) > maximumBytes) throw new SiwsError(413, "Request is too large");
  if (!request.body) throw new SiwsError(400, "Missing request body");
  const reader = request.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      request.signal.throwIfAborted();
      const { done, value } = await reader.read(); if (done) break;
      size += value.length; if (size > maximumBytes) throw new SiwsError(413, "Request is too large");
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return new Request(request.url, { method: request.method, headers: request.headers, body: bytes, signal: request.signal });
}
