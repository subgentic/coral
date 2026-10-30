// The manifest of a screenshot run: what was photographed, which file each shot is, the Coral link it will have once uploaded, and the text of the release task. Pure (no files, no calls), so its tests
// run anywhere and the upload step only does what this says.
import crypto from 'node:crypto';

export const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*__\d{3,4}(?:__light)?\.png$/;

/** 'v2.0.7', '2.0.7' and '2.0.7-rc1' are all the release "v2.0.7(-rc1)". */
export function versionTag(version) {
    const v = String(version || '').trim().replace(/^v/i, '');
    if (!/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.]+)?$/.test(v)) throw new Error(`not a release version: ${JSON.stringify(version)}`);
    return 'v' + v;
}

export const taskTitle = version => `UI review: ${versionTag(version)}`;

/** The file name a shot is uploaded under: <page>__<width>.png for the dark theme (the default), <page>__<width>__light.png for the light one. */
export function artifactName(page, width, theme = 'dark') {
    const name = `${page}__${width}${theme === 'light' ? '__light' : ''}.png`;
    if (!NAME_RE.test(name)) throw new Error(`not a shot name: ${name}`);
    return name;
}

/** The link an upload of these bytes gets: Coral names an artifact by the SHA-256 of its bytes. */
export const expectedLink = bytes => 'coral://artifacts/' + crypto.createHash('sha256').update(bytes).digest('hex');

/**
 * results: shoot.mjs's results.json rows; changes: diff.mjs's rows (or null: a baseline run).
 * Returns { version, tag, sha, ranAt, widths, themes, pageCount, shotCount, artifacts, failed, counts, title }.
 */
export function buildManifest({ version, sha, ranAt, widths, themes, results, changes }) {
    const status = new Map((changes || []).map(r => [r.file, r]));
    const artifacts = results.filter(r => r.ok).map(r => {
        const name = artifactName(r.id, r.width, r.theme);
        const c = status.get(r.file);
        return { name, page: r.id, width: r.width, theme: r.theme, file: r.file, sha256: r.sha, status: c ? c.status : 'baseline', diffPixels: c?.diffPixels ?? null, diff: c?.diff ?? null, notes: r.notes || '', stub: r.stub || '' };
    });
    const names = new Set();
    for (const a of artifacts) { if (names.has(a.name)) throw new Error('two shots with the name ' + a.name); names.add(a.name); }
    const failed = results.filter(r => !r.ok).map(r => ({ page: r.id, width: r.width, theme: r.theme, error: r.error || 'unknown' }));
    const pages = new Set(results.map(r => r.id));
    const shotPageCount = new Set(artifacts.map(a => a.page)).size;
    const changedPageCount = new Set(artifacts.filter(a => a.status === 'changed').map(a => a.page)).size;
    const count = s => artifacts.filter(a => a.status === s).length;
    return {
        version, tag: versionTag(version), title: taskTitle(version), sha, ranAt, widths, themes, pageCount: pages.size, shotPageCount, changedPageCount, shotCount: artifacts.length, artifacts, failed,
        counts: { changed: count('changed'), unchanged: count('unchanged'), new: count('new'), baseline: count('baseline'), removed: (changes || []).filter(r => r.status === 'removed').length },
    };
}

/** The task's body: the page count, the widths, the build SHA and the run time first, as asked, then what changed and what failed. */
export function taskBody(m, sheetLink) {
    const lines = [
        sheetLink ? `Contact sheet (open this first): ${sheetLink}` : 'Contact sheet: not built (see below).',
        '',
        `1. Pages: ${m.pageCount} (${m.shotCount} shots)`,
        `2. Widths: ${m.widths.join(', ')} px (full, middle, phone)`,
        `3. Themes: ${m.themes.join(', ')}`,
        `4. Build: ${m.tag} at ${String(m.sha || 'unknown').slice(0, 12)}`,
        `5. Run: ${m.ranAt}`,
    ];
    const c = m.counts;
    lines.push(m.counts.baseline === m.shotCount ? '6. Changed since the last release: nothing to compare with (this run is the baseline).'
        : `6. Changed since the last release: ${c.changed} changed, ${c.new} new, ${c.removed} removed, ${c.unchanged} unchanged.`);
    if (m.failed.length) lines.push(`7. Not photographed (${m.failed.length}): ` + m.failed.slice(0, 12).map(f => `${f.page} at ${f.width}`).join('; ') + (m.failed.length > 12 ? '; ...' : ''));
    lines.push('', 'Every shot is a Coral artifact named <page>__<width>.png on this task. The pixel diff decided what changed.');
    return lines.join('\n');
}

/** The tags of the contact sheet's final upload: "for review" is what Coral's Needs you reads (the Inbox lists the board's artifacts with it, for the operator to open), "ui review" groups the run's files. */
export const REVIEW_TAGS = ['ui review', 'for review'];

/** The one line the operator's Needs you row shows (the artifact's name): the version, the pages shot and how many changed against the previous release (pages, not shots: a page at three widths is one). */
export function reviewName(m, prevVersion) {
    const head = `UI review ${m.tag}: ${m.shotPageCount} pages shot`;
    return m.counts.baseline === m.shotCount || !prevVersion ? `${head}, no earlier release to compare with` : `${head}, ${m.changedPageCount} changed vs ${versionTag(prevVersion)}`;
}

/** The contact sheet's artifact name: the one-line summary, then .html. Coral keeps the FIRST upload's name for bytes it has already stored, so the sheet is uploaded under this name from the start and its later "for review"
 *  upload (the same bytes, which adds the tag) shows the same line in Needs you. */
export const sheetArtifactName = (m, prevVersion) => reviewName(m, prevVersion) + '.html';

/** The coral-agent arguments of every upload of a run: the file, its name, the release task and the "ui review" tag, then any extra (what a dry run prints). */
export const uploadArgs = (file, name, taskId, extra = []) => ['artifact', 'upload', file, '--name', name, '--task', String(taskId), '--tag', 'ui review', ...extra];

/** The arguments that put the contact sheet in the operator's Needs you, on the release task. */
export const reviewUploadArgs = (file, name, taskId) => uploadArgs(file, name, taskId, ['--tag', 'for review']);
