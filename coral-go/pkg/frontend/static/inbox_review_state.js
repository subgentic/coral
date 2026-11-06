/* Review attention and change labels use server facts, never a guessed age or
 * browser-global read tag as a per-person version baseline (#13916). */
export const waitingOnAgent = row => !!row?.tags?.includes('changes requested');
export const hasNewVersion = row => Number.isSafeInteger(row?.version) && Number.isSafeInteger(row?.opened_version) && row.opened_version > 0 && row.version > row.opened_version;
export const needsReviewAttention = row => (row?.new_comments > 0) || (!waitingOnAgent(row) && (!row?.tags?.includes('read') || hasNewVersion(row)));
export function reviewChangeLabels(row) {
    const labels = [];
    const version = row?.version;
    if (hasNewVersion(row)) labels.push(`New version v${version}`);
    const comments = row?.new_comments;
    if (Number.isSafeInteger(comments) && comments > 0) labels.push(`${comments} new comment${comments === 1 ? '' : 's'}`);
    return labels;
}
