// A question that only links a file the Inbox already shows as a file for review is that file, not a second item (#11998). Kept apart from operator_asks.js so inbox_reviews.js (and its node test) need not load the page's state.
let hidden = () => false;
/** inbox_reviews.js says which questions to leave out. */
export const hideAsksWhen = fn => { hidden = fn; };
export const isHiddenAsk = a => hidden(a);

/* The badge can read a view's existing cache without loading the review routes at startup. */
let read = () => [], refresh = () => null;
export const unreadReviewItems = () => read();
export const refreshReviews = () => refresh();
export function setReviewCacheReader(reader, refresher) { read = reader; refresh = refresher; }
