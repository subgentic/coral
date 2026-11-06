// A question that only links a file the Inbox already shows as a file for review is that file, not a second item (#11998). Kept apart from operator_asks.js so inbox_reviews.js (and its node test) need not load the page's state.
let hidden = () => false;
/** inbox_reviews.js says which questions to leave out. */
export const hideAsksWhen = fn => { hidden = fn; };
export const isHiddenAsk = a => hidden(a);

/* The badge can read a view's existing cache without loading the review routes at startup. */
let read = () => [], refresh = () => null, summary = () => null;
export const unreadReviewItems = () => read();
export const refreshReviews = () => refresh();
/** Exact server attention totals are distinct from the loaded page's unread rows. */
export function reviewAttentionCount() {
    const metadata = summary(), n = metadata?.attentionTotal;
    return Number.isSafeInteger(n) && n >= 0 ? { value: n, complete: true }
        : { value: read().length, complete: metadata === null };
}
export function setReviewCacheReader(reader, refresher, summarizer = () => null) { read = reader; refresh = refresher; summary = summarizer; }
