import assert from 'node:assert/strict';
import test from 'node:test';
import { installDom, importUi } from './helpers/jsdom_env.mjs';

const dom = installDom({ mode: 'local' });
const hex = 'a'.repeat(64);
const base = { id: hex, uri: 'coral://artifacts/' + hex, board_id: 'dev', name: 'Plan.md', series_id: 'read-version-series', version: 3, available: true, tags: ['for review', 'read'], created_at: '2026-11-06T10:00:00Z' };
globalThis.fetch = window.fetch = async (input, opts = {}) => {
    const url = new URL(String(input), location.href);
    if (url.pathname === '/api/board/projects') return Response.json([{ project: 'dev' }]);
    if (url.pathname.endsWith('/opened') && opts.method === 'POST') return Response.json({ series_id: base.series_id, opened_version: 3 });
    return Response.json({ artifacts: url.pathname === '/api/team-artifacts' && url.searchParams.get('team') === 'dev' ? [{ ...base, opened_version: 2 }] : [], has_more: false });
};
const reviews = await importUi('inbox_reviews');

test('isRead treats a read-tagged review with a newer unopened version as unread', () => {
    assert.equal(reviews.isRead({ ...base, opened_version: 2 }), false);
    assert.equal(reviews.isRead({ ...base, opened_version: 3 }), true);
    assert.equal(reviews.isRead({ ...base, opened_version: 0 }), true, 'never opened is not an invented version baseline');
    assert.equal(reviews.isRead(base), true, 'an unknown baseline leaves the read tag authoritative');
});

test('a loaded read-tagged row becomes read only after its actual version is opened', async () => {
    await reviews.refreshReviews(true);
    const row = reviews.reviewItems()[0];
    assert.equal(row.opened_version, 2);
    assert.equal(reviews.isRead(row), false);
    assert.equal(reviews.unreadReviewItems().length, 1);
    assert.equal(await reviews.recordOpenedVersion(hex, { server: 'local', board: 'dev' }), true);
    assert.equal(reviews.isRead(reviews.reviewItems()[0]), true);
    assert.equal(reviews.unreadReviewItems().length, 0);
});

test.after(() => dom.window.close());
