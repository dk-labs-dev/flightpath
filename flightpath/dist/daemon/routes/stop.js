// POST /api/stop: the stop that works on Windows, where a signal
// ends the daemon without running its handler.
export function postStop(ctx, _request, response) {
    // Stop only once the 204 is out, so the caller gets its answer.
    response.writeHead(204).end(() => void ctx.stop());
}
