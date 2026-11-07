export function yieldToEventLoop() {
    return new Promise((resolvePromise) => setImmediate(resolvePromise));
}
