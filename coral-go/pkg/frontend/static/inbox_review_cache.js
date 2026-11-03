/* The badge can read a view's existing cache without loading the review routes at startup. */
let read = () => [], refresh = () => null;
export const unreadReviewItems = () => read();
export const refreshReviews = () => refresh();
export function setReviewCacheReader(reader, refresher) { read = reader; refresh = refresher; }
