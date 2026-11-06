// Legacy UI fixtures describe board-artifact rows. Let their predicates match
// the same review rows now read through the owner-only cross-team endpoint.
// This changes only the URL object used by an opted-in fixture's predicates;
// it never redirects fetch. A fixture's passthrough retains the ORIGINAL URL.
// Routing/authorization tests should use the original URL and must not opt in.
function reviewFixtureURL(input, base) {
    const url = new URL(input, base);
    const match = /^(\/api\/remote\/[^/]+)?\/api\/team-artifacts$/.exec(url.pathname);
    if (match && url.searchParams.get('starred_first') === 'true' && url.searchParams.get('tag') === 'for review' && url.searchParams.has('team')) {
        if (url.searchParams.get('team') !== '~no-team') url.pathname = (match[1] || '') + '/api/board/' + encodeURIComponent(url.searchParams.get('team')) + '/artifacts';
        url.searchParams.delete('team'); url.searchParams.delete('starred_first');
    }
    return url;
}
module.exports = { reviewFixtureURL };
