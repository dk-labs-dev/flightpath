// The event a hook receives on stdin; node builtins only (the hooks load this).
import { readFileSync } from "node:fs";
import { isPlainObject } from "./json.js";
/** The event on stdin, parsed; null when it is empty, unreadable or not an object. */
export function readStdinEvent() {
    let raw;
    try {
        raw = readFileSync(0, "utf8");
    }
    catch {
        return null;
    }
    if (raw.trim().length === 0) {
        return null;
    }
    try {
        const payload = JSON.parse(raw);
        return isPlainObject(payload) ? payload : null;
    }
    catch {
        return null;
    }
}
