/**
 * Simulated Google HTTP server for tests (ADR 0008): routes by method and path, records every request (method, URL,
 * headers, body) and answers with canned JSON. The live adapters are only ever tested against this, never Google.
 */
export interface RecordedRequest {
  method: string;
  url: URL;
  headers: Record<string, string>;
  body: string;
}

export interface SimulatedReply {
  status?: number;
  json?: unknown;
  headers?: Record<string, string>;
}

type Handler = (req: RecordedRequest) => SimulatedReply | Promise<SimulatedReply>;

export class SimulatedGoogle {
  readonly requests: RecordedRequest[] = [];
  private readonly routes: { method: string; path: string | RegExp; handler: Handler }[] = [];

  on(method: string, path: string | RegExp, handler: Handler): this {
    this.routes.unshift({ method, path, handler });
    return this;
  }

  readonly fetch: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>))
      headers[k.toLowerCase()] = v;
    const req: RecordedRequest = {
      method: init?.method ?? "GET",
      url,
      headers,
      body: typeof init?.body === "string" ? init.body : "",
    };
    this.requests.push(req);
    const route = this.routes.find(
      (r) =>
        r.method === req.method &&
        (typeof r.path === "string" ? r.path === url.pathname : r.path.test(url.pathname)),
    );
    const reply: SimulatedReply = route
      ? await route.handler(req)
      : {
          status: 404,
          json: { error: { code: 404, message: `no route for ${req.method} ${url.pathname}` } },
        };
    const status = reply.status ?? 200;
    const body = reply.json === undefined || status === 204 ? null : JSON.stringify(reply.json);
    return new Response(body, { status, headers: { "content-type": "application/json", ...reply.headers } });
  };
}

export const formOf = (req: RecordedRequest): Record<string, string> =>
  Object.fromEntries(new URLSearchParams(req.body));
