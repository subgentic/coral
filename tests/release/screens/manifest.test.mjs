import test from 'node:test';
import assert from 'node:assert/strict';
import { versionTag, taskTitle, artifactName, expectedLink, buildManifest, taskBody, NAME_RE, reviewName, reviewUploadArgs, REVIEW_TAGS, sheetArtifactName, pickGoal } from './manifest.mjs';

const results = [
    { id: 'home', width: '1440', theme: 'dark', file: 'dark/home__1440.png', ok: true, sha: 'a'.repeat(64), notes: '' },
    { id: 'home', width: '390', theme: 'dark', file: 'dark/home__390.png', ok: true, sha: 'b'.repeat(64), notes: '' },
    { id: 'team-board', width: '900', theme: 'dark', file: 'dark/team-board__900.png', ok: true, sha: 'c'.repeat(64), notes: 'n', stub: '' },
    { id: 'dialog-jump', width: '390', theme: 'dark', file: 'dark/dialog-jump__390.png', ok: false, error: 'no visible thing' },
];

test('the task title is "UI review: vX.Y.Z" whatever way the version is written', () => {
    for (const v of ['2.0.7', 'v2.0.7', ' v2.0.7 ']) assert.equal(taskTitle(v), 'UI review: v2.0.7');
    assert.equal(versionTag('2.0.7-rc1'), 'v2.0.7-rc1');
    for (const bad of ['', 'latest', '2.0', 'v2.0.x', '../2.0.7']) assert.throws(() => versionTag(bad), /not a release version/, bad);
});

test('a shot is named <page>__<width>.png, with __light for the light theme, and nothing else is a name', () => {
    assert.equal(artifactName('home', '1440'), 'home__1440.png');
    assert.equal(artifactName('team-board', 900, 'dark'), 'team-board__900.png');
    assert.equal(artifactName('home', '390', 'light'), 'home__390__light.png');
    for (const bad of [['Home', '1440'], ['home page', '1440'], ['../x', '1440'], ['home', '14']]) assert.throws(() => artifactName(...bad), /not a shot name/);
    assert.match('analytics-per-commit__1440.png', NAME_RE);
});

test('the link of an upload is the SHA-256 of its bytes', () => {
    assert.equal(expectedLink(Buffer.from('hello digest probe\n')), 'coral://artifacts/bcdf7e3cb6d0bd6c6759694314ae57d5f7bb8cc1950431e109c6048de0b633b3');
});

test('the manifest lists every shot that was taken, names the ones that were not, and counts the pages', () => {
    const m = buildManifest({ version: '2.0.7', sha: '8b6f2d4b0aaaaaaa', ranAt: '2026-10-30T12:00:00Z', widths: ['1440', '900', '390'], themes: ['dark'], results, changes: null });
    assert.equal(m.title, 'UI review: v2.0.7');
    assert.equal(m.pageCount, 3); // home, team-board, dialog-jump (a page that failed is still a page)
    assert.equal(m.shotCount, 3);
    assert.deepEqual(m.artifacts.map(a => a.name), ['home__1440.png', 'home__390.png', 'team-board__900.png']);
    assert.deepEqual(m.failed, [{ page: 'dialog-jump', width: '390', theme: 'dark', error: 'no visible thing' }]);
    assert.equal(m.counts.baseline, 3);
});

test('with an earlier run the shots carry their status, changed first in the counts', () => {
    const changes = [{ file: 'dark/home__1440.png', status: 'changed', diffPixels: 5000, diff: 'diff/dark/home__1440.png' }, { file: 'dark/home__390.png', status: 'unchanged', diffPixels: 3 }, { file: 'dark/old__1440.png', status: 'removed' }];
    const m = buildManifest({ version: 'v2.0.7', sha: 'x', ranAt: 't', widths: ['1440'], themes: ['dark'], results, changes });
    assert.deepEqual(m.counts, { changed: 1, unchanged: 1, new: 0, baseline: 1, removed: 1 });
    assert.equal(m.artifacts[0].diff, 'diff/dark/home__1440.png');
});

test('a name used twice is refused: two uploads would be one artifact', () => {
    const twice = [results[0], { ...results[0], file: 'dark/other.png' }];
    assert.throws(() => buildManifest({ version: '2.0.7', sha: 'x', ranAt: 't', widths: [], themes: [], results: twice, changes: null }), /two shots with the name/);
});

test('the task body leads with the contact sheet and states the page count, widths, SHA and time', () => {
    const m = buildManifest({ version: '2.0.7', sha: '8b6f2d4b0aaaaaaa', ranAt: '2026-10-30T12:00:00Z', widths: ['1440', '900', '390'], themes: ['dark'], results, changes: null });
    const body = taskBody(m, 'coral://artifacts/' + 'd'.repeat(64));
    const lines = body.split('\n');
    assert.match(lines[0], /^Contact sheet \(open this first\): coral:\/\/artifacts\/d{64}$/);
    assert.match(body, /1\. Pages: 3 \(3 shots\)/);
    assert.match(body, /2\. Widths: 1440, 900, 390 px/);
    assert.match(body, /4\. Build: v2\.0\.7 at 8b6f2d4b0aaa\n/);
    assert.match(body, /5\. Run: 2026-10-30T12:00:00Z/);
    assert.match(body, /baseline/);
    assert.match(body, /Not photographed \(1\): dialog-jump at 390/);
});

// The operator's ask (#11216): the run puts its contact sheet in front of the operator as needing review. Coral's Needs-you list reads the board's artifacts tagged "for review" (inbox_reviews.js), and the
// row's title is the artifact's name, so the name is the one-line summary.
const withChanges = () => buildManifest({ version: 'v2.0.8', sha: 'abc', ranAt: 't', widths: [1440, 900, 390], themes: ['dark'],
    results: [{ id: 'a', width: 1440, ok: true, file: 'a__1440.png', sha: 'x' }, { id: 'a', width: 390, ok: true, file: 'a__390.png', sha: 'x' }, { id: 'b', width: 1440, ok: true, file: 'b__1440.png', sha: 'x' }, { id: 'c', width: 1440, ok: false, error: 'e' }],
    changes: [{ file: 'a__1440.png', status: 'changed' }, { file: 'a__390.png', status: 'changed' }, { file: 'b__1440.png', status: 'unchanged' }] });

test('the review name is one line: the version, the pages shot and the pages changed against the previous release', () => {
    const m = withChanges();
    assert.equal(m.changedPageCount, 1, 'a page changed at two widths is one page');
    assert.equal(reviewName(m, 'v2.0.7'), 'UI review v2.0.8: 2 pages shot, 1 changed vs v2.0.7');
    assert.equal(reviewName(m, ''), 'UI review v2.0.8: 2 pages shot, no earlier release to compare with', 'a baseline says so');
    assert.ok(reviewName(m, 'v2.0.7').length <= 100 && !/\n/.test(reviewName(m, 'v2.0.7')));
});

test('the review upload carries the "for review" tag and the contact sheet, on the release task, and nothing from the environment', () => {
    assert.deepEqual(REVIEW_TAGS, ['ui review', 'for review']);
    assert.deepEqual(reviewUploadArgs('/o/contact-sheet.html', 'UI review v2.0.8: 2 pages shot, 1 changed vs v2.0.7', 11400),
        ['artifact', 'upload', '/o/contact-sheet.html', '--name', 'UI review v2.0.8: 2 pages shot, 1 changed vs v2.0.7', '--task', '11400', '--tag', 'ui review', '--tag', 'for review']);
});

test('the sheet is uploaded under the review line from the start: Coral keeps the first upload\'s name for bytes it already has', () => {
    assert.equal(sheetArtifactName(withChanges(), 'v2.0.7'), 'UI review v2.0.8: 2 pages shot, 1 changed vs v2.0.7.html');
});

test('the goal is one that is open: the asked one, else the lowest open "UI review" goal, else none with the reason', () => {
    const goals = [{ id: 129, state: 'active', title: 'New User Onboarding Experience' }, { id: 163, state: 'done', title: 'UI review of every release' }, { id: 170, state: 'active', title: 'UI review of every release' }, { id: 171, state: 'blocked', title: 'The UI review backlog' }];
    assert.equal(pickGoal(goals, '129').id, 129, 'an open goal that was asked for');
    assert.equal(pickGoal(goals, '163').id, 170, 'a closed one is not used: the open UI review goal is');
    assert.equal(pickGoal(goals, undefined).id, 170);
    assert.match(pickGoal(goals, '163').why, /#163 is not open/);
    const none = pickGoal([{ id: 129, state: 'active', title: 'Onboarding' }], '163');
    assert.equal(none.id, null);
    assert.match(none.why, /orchestrator/);
    assert.equal(pickGoal(null, undefined).id, null);
});
