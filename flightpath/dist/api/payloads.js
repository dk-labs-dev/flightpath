// The read API's payload shapes, and the recorder's error shape the stream's
// health carries: plain types, importing nothing that runs, so a reader that
// runs without Node — the browser view — can name exactly what the daemon sends.
/** An item's tokens with the files a skill attached counted in.
 * Null when neither the item nor its files have a known size. */
export function itemTokens(item) {
    const filesTokens = item.files?.tokens;
    if (filesTokens === undefined)
        return item.tokens;
    return (item.tokens ?? 0) + filesTokens;
}
/** The rise floor: the smallest rise the history names, flat at any limit. */
export const RISE_FLOOR = 2_000;
