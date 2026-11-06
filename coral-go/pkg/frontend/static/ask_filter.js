// A question that only links a file the Inbox already shows as a file for review is that file, not a second item (#11998). Kept apart from operator_asks.js so inbox_reviews.js (and its node test) need not load the page's state.
let hidden = () => false;
/** inbox_reviews.js says which questions to leave out. */
export const hideAsksWhen = fn => { hidden = fn; };
export const isHiddenAsk = a => hidden(a);

/* The badge can read a view's existing cache without loading the review routes at startup. */
let read = () => [], refresh = () => null, known = () => false, counted = () => null;
export const unreadReviewItems = () => read();
export const refreshReviews = () => refresh();
export function setReviewCacheReader(reader, refresher, isKnown) { read = reader; refresh = refresher; if (isKnown) known = isKnown; }
/** review_counts.js (loaded after the first paint) says how many files wait without reading them (#13172). */
export function setReviewCounter(fn) { counted = fn; }
/** The files waiting for the Operator, for the tab's badge and the Needs you count: what the full read holds once it has run (it knows the page's own rules), else what the computers counted, else 0. */
export const unreadReviewCount = () => (known() ? read().length : (counted() ?? 0));
