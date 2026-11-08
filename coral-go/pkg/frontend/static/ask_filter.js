// A question that only links a file the Inbox already shows as a file for review is that file, not a second item (#11998). Kept apart from operator_asks.js so inbox_reviews.js (and its node test) need not load the page's state.
let hidden = () => false, prepare = async () => {};
/** inbox_reviews.js says which questions to leave out. */
export const hideAsksWhen = (fn, prepareRows = async () => {}) => { hidden = fn; prepare = prepareRows; };
export const prepareAskReviews = rows => prepare(rows);
export const isHiddenAsk = a => hidden(a);

/* The badge can read a view's existing cache without loading the review routes at startup. */
let read = () => [], refresh = () => null, summary = () => null, counted = () => null, countMetadata = () => null, counterAttached = false;
export const unreadReviewItems = () => read();
export const refreshReviews = () => refresh();
/** Exact server attention totals are distinct from the loaded page's unread rows. */
export function reviewAttentionCount() {
    const metadata = summary(), n = metadata?.attentionTotal;
    // A complete loaded window applies the current mute/read/comment policy. The
    // startup counter can predate it; recount in memory instead of fetching it twice.
    if (Number.isSafeInteger(n) && n >= 0) return { value: n, complete: true };
    const server = countMetadata(), authoritative = counted();
    if (Number.isSafeInteger(authoritative) && authoritative >= 0 && (!server || server.complete)) return { value: authoritative, complete: true };
    if (server && !server.complete) {
        const fallback = server.sources.filter(s => s.total === null).reduce((total, s) => total + (metadata?.loadedBySource?.[s.server] || 0), 0);
        return { value: server.knownTotal + fallback, complete: false };
    }
    return { value: read().length, complete: metadata === null && !counterAttached };
}
export function setReviewCacheReader(reader, refresher, summarizer = () => null) { read = reader; refresh = refresher; summary = summarizer; }

/** The background counter uses the same per-person attention policy as the list. */
export function setReviewCounter(fn, summarizer = () => null) { counted = fn; countMetadata = summarizer; counterAttached = true; }
export const unreadReviewCount = () => reviewAttentionCount().value;
