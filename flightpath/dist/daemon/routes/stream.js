// GET /api/stream — the live stream (ADR-0009). The hub owns
// the connections and the replay; this handler only takes the
// session and the reconnect position out of the request and
// hands over the response.
export function getStream(ctx, request, response) {
    const url = new URL(request.url ?? "", "http://127.0.0.1");
    const sessionId = url.searchParams.get("session");
    const lastEventId = request.headers["last-event-id"];
    ctx.stream.serve(response, sessionId === null || sessionId === "" ? null : sessionId, typeof lastEventId === "string" ? lastEventId : null);
}
