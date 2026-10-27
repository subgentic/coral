/* The Settings dialog's Storage and cleanup group: the artifact store, the terminal logs, free space and automatic cleanup, the received files limit (moved out of settings_dialog.js, #8374; no behaviour change). */
import { plural } from './format.js';
import { importOnce } from './import_once.js';
import { showToast } from './utils.js';
import { isCloud } from './server_base.js';
import { requestJson } from './api.js';

// ── Artifact store (#3553) ─────────────────────────────────────────────
const GIB = 1024 ** 3;
function _gib(n) {
    n = Number(n) || 0;
    if (n >= GIB / 10) return `${(n / GIB).toFixed(1)} GiB`;
    if (n >= 1024 ** 2) return `${Math.round(n / (1024 ** 2))} MiB`;
    if (n >= 1024) return `${Math.round(n / 1024)} KiB`;
    return `${n} B`;
}

/** Settings: the artifact store's size and the saved diffs' sizes, as separate lines, next to the
 *  store limit (which counts the artifacts only). This computer's dashboard only. */
export async function loadArtifactStoreSize({ fresh = false } = {}) {
    let fileCount = null; // the file counts the breakdown shows (the limit lines say only how much space)
    const out = document.getElementById('settings-artifact-store-size');
    const input = document.getElementById('settings-artifact-store-max');
    if (!out || !input) return;
    const rin = document.getElementById('settings-received-max');
    const rout = document.getElementById('settings-received-size');
    if (fresh) {
        // Each open starts from nothing: the numbers of the last open must not outlive it. A failed or slow load then leaves the fields empty and off (a limit that was not
        // read is never saved back: the flag is gone), and the lines say that it is loading, not what it showed last time (#4469, UX's #4456 SHOULD 9).
        for (const [i, o] of [[input, out], [rin, rout]]) {
            if (!i || !o) continue;
            i.value = ''; delete i.dataset.loaded; i.disabled = true;
            o.textContent = 'Loading…'; delete o.dataset.state;
        }
        const ub = document.getElementById('settings-received-unlisted'); if (ub) ub.hidden = true;
    }
    try {
        const d = await requestJson('GET', '/api/system/artifact-store');
        fileCount = { artifacts: Number(d.objects) || 0, taskDiffs: Number(d.task_diffs?.files) || 0, sessionDiffs: Number(d.session_diffs?.files) || 0 };
        input.value = d.max_bytes > 0 ? String(Math.round(d.max_bytes / GIB)) : '0';
        input.dataset.loaded = '1'; // only a limit read from Coral is saved back
        input.disabled = false;

        // The same three states as the received files' line: below 80%, from 80% with what to do, and at the limit that new uploads are refused, in the warning colour.
        let art = _gib(d.bytes); // the limit field is beside it: "3.0 GiB of 10.0 GiB"; the file count is in the breakdown
        const atLimit = d.max_bytes > 0 && d.bytes >= d.max_bytes;
        if (d.max_bytes > 0) {
            const full = atLimit || d.bytes * 5 >= d.max_bytes * 4;
            art += atLimit ? ` of ${_gib(d.max_bytes)}: new uploads are refused` : full ? ` of ${_gib(d.max_bytes)} (${Math.floor((d.bytes / d.max_bytes) * 100)}% full)` : ` of ${_gib(d.max_bytes)}`;
            if (full) art += '. Delete artifacts in Team Artifacts to make room, or raise the limit.';
            // Coral raised an unset limit by itself when the 20 GiB default arrived (#4602): the Operator should know it, and can change it here.
            if (d.auto_raised > 0 && d.auto_raised === d.max_bytes) art += `${full ? ' ' : '. '}The limit was raised to ${_gib(d.auto_raised)} automatically when the 20 GiB default arrived, because the store already held more than 16 GiB. Change it here.`;
        }
        const artNode = document.createElement('span');
        artNode.textContent = art;
        if (atLimit) artNode.dataset.state = 'warn';
        const rest = [`Diffs: ${_gib((d.task_diffs?.bytes || 0) + (d.session_diffs?.bytes || 0))} in ${plural((d.task_diffs?.files || 0) + (d.session_diffs?.files || 0), 'file', 'files', { localized: true })}`];
        out.replaceChildren(artNode, ...rest.flatMap(l => [document.createElement('br'), l]));
        showReceivedCap(d.received);
    } catch {
        if (fresh) {
            for (const i of [input, rin]) if (i) { i.value = ''; delete i.dataset.loaded; } // nothing typed meanwhile is kept: the field is off and saves nothing
            out.textContent = "Couldn't read the store's size, so the limit is not shown.";
            if (rout) rout.textContent = "Couldn't read the received files' size, so their limit is not shown.";
        } else out.textContent = "Couldn't read the store's size.";
    }
    loadStorageDetail(fileCount);
    importOnce('./received_cap_notice.js').then(m => m.checkReceivedCap({ inSettings: true })).catch(() => {}); // remembered once at 80%; the line says it, no toast over this dialog (#4441)
}

// ── Terminal logs of ended agents (#4447) ─────────────────────────────
let _endedLogs = null; // { count, bytes } as last shown: what a confirmation is for

/** Settings: the board message search index (#9685): on or off, building or ready, and the disk it takes. This computer's dashboard only. */
export async function loadMessageSearchIndex() {
    const out = document.getElementById('settings-message-search-status');
    if (!out) return;
    try {
        const d = await requestJson('GET', '/api/system/message-search-index');
        if (!d.available) out.textContent = 'Not in this build: a search reads every message.';
        else if (d.setting === 'off') out.textContent = 'Off (CORAL_BOARD_SEARCH_INDEX=off): a search reads every message.';
        else if (d.state === 'ready') out.textContent = `On and ready. It takes ${_gib(d.size_bytes)} of disk.`;
        else if (d.state === 'building') out.textContent = 'On, building in the background: a search reads every message until it is ready.';
        else out.textContent = 'On: it is built when Coral next starts.';
    } catch {
        out.textContent = "Couldn't read the search index.";
    }
}

/** Settings: how many terminal logs there are and how many belong to ended agents. This computer's dashboard only. */
export async function loadTerminalLogs() {
    const out = document.getElementById('settings-terminal-logs-status');
    const button = document.getElementById('settings-terminal-logs-delete');
    if (!out || !button) return;
    try {
        const d = await requestJson('GET', '/api/system/terminal-logs');
        const n = Number(d.ended?.count) || 0;
        _endedLogs = { count: n, bytes: Number(d.ended?.bytes) || 0 };
        const files = `${Number(d.files).toLocaleString()} log${d.files === 1 ? '' : 's'}`;
        out.textContent = n
            ? `${files}, ${_gib(d.bytes)}. ${n.toLocaleString()} from ended agents (${_gib(_endedLogs.bytes)}).`
            : `${files}, ${_gib(d.bytes)}`;
        button.hidden = n === 0;
        if (n) button.textContent = `Delete ${n.toLocaleString()} terminal log${n === 1 ? '' : 's'} of ended agents (${_gib(_endedLogs.bytes)})`;
        if (!button.dataset.wired) { button.dataset.wired = '1'; button.addEventListener('click', confirmDeleteEndedLogs); }
    } catch {
        _endedLogs = null;
        button.hidden = true;
        out.textContent = "Couldn't read the terminal logs.";
    }
}

function confirmDeleteEndedLogs() {
    const shown = _endedLogs;
    if (!shown || !shown.count) return;
    const n = shown.count;
    window.showConfirmModal?.('Delete terminal logs',
        `Delete ${n.toLocaleString()} terminal log${n === 1 ? '' : 's'} of ended agents (${_gib(shown.bytes)})? What ${n === 1 ? 'that agent\'s terminal' : 'those agents\' terminals'} showed can't be recovered. The logs of live, sleeping and archived agents are kept.`,
        async () => {
            try {
                const d = await requestJson('POST', '/api/system/terminal-logs/delete-ended', shown);
                const left = (d.failed || []).length;
                showToast(`Deleted ${Number(d.deleted || 0).toLocaleString()} terminal log${d.deleted === 1 ? '' : 's'}, ${_gib(d.bytes)} freed.${left ? ` ${left} could not be deleted or are not ended any more.` : ''}`, false, 8000);
            } catch (e) {
                if (e.status === 409) showToast('The logs of ended agents changed since you looked, so nothing was deleted. Look at the new numbers and try again.', true, 8000);
                else showToast(`Couldn't delete the terminal logs: ${e.message}`, true);
            }
            loadTerminalLogs();
        }, undefined, { label: 'Delete logs', danger: true });
    requestAnimationFrame(() => document.querySelector('#confirm-modal .modal-actions .btn:not(#confirm-modal-yes)')?.focus());
}

// ── Free space and automatic cleanup (#3554) ──────────────────────────
const PRUNE_KINDS = { diffs: ['diffs'], objects: ['objects'], all: ['all'] };

function _lines(el, lines) {
    el.replaceChildren(...lines.flatMap((l, i) => (i ? [document.createElement('br'), l] : [l])));
}

/** The store's breakdown (by age, by board, kept) and automatic cleanup's state. */
async function loadStorageDetail(fileCount = null) {
    const out = document.getElementById('settings-storage-detail');
    const days = document.getElementById('settings-prune-days');
    const kind = document.getElementById('settings-prune-kind');
    const on = document.getElementById('settings-retention-enabled');
    if (!out || !days || !on) return;
    try {
        const d = (await requestJson('GET', '/api/system/artifact-store?detail=1')).detail;
        if (!d) throw new Error('no detail');
        const age = (k) => ['<1d', '1-7d', '7-30d', '>30d'].map(b => `${b} ${_gib(d.by_age?.[k]?.[b]?.bytes || 0)}`).join(' · ');
        const lines = [];
        if (fileCount) lines.push(`Files: ${fileCount.artifacts.toLocaleString()} artifacts, ${(fileCount.taskDiffs + fileCount.sessionDiffs).toLocaleString()} saved diffs`);
        lines.push(
            `Artifacts by age: ${age('objects')}`,
            `Task diffs by age: ${age('task_diffs')}`,
        );
        const boards = (d.by_board || []).slice(0, 5).map(b => `${b.label || b.board} ${_gib(b.bytes)}`);
        if (boards.length) lines.push(`Largest boards: ${boards.join(' · ')}`);
        if (d.kept?.count) lines.push(`Kept: ${d.kept.count} artifact${d.kept.count === 1 ? '' : 's'}, ${_gib(d.kept.bytes)}`);
        _lines(out, lines);
        const ret = d.retention || {};
        const saved = Number(ret.days) || 0;
        on.checked = saved > 0;
        if (saved > 0) days.value = String(saved); // off: the field keeps its default for Prune now
        kind.value = ['diffs', 'objects', 'all'].includes(ret.kinds) ? ret.kinds : 'diffs'; // what the hourly run prunes is what Save keeps, on or off
        on.dataset.loaded = '1';
        showRetentionStatus(ret);
        if (!on.dataset.wired) {
            on.dataset.wired = '1';
            // One pair of fields serves Prune now and the hourly run: the switch says whether the hourly run is on, and the days it uses are the field's.
            const changed = () => {
                const n = on.checked ? Math.max(1, Math.floor(Number(days.value) || 0)) : 0;
                if (!n) showRetentionStatus({ days: 0, last: ret.last });
                else if (n !== saved) _lines(document.getElementById('settings-retention-status'), [`Turns on at ${n} days when you save.`]);
                else showRetentionStatus(ret);
            };
            on.addEventListener('change', changed);
            days.addEventListener('input', () => { if (on.checked) changed(); });
        }
    } catch {
        out.textContent = '';
    }
}

function showRetentionStatus(ret) {
    const status = document.getElementById('settings-retention-status');
    const review = document.getElementById('settings-retention-review');
    if (!status || !review) return;
    const days = Number(ret.days) || 0;
    const enabled = ret.enabled_at ? new Date(ret.enabled_at) : null;
    const acked = ret.acknowledged_at ? new Date(ret.acknowledged_at) : null;
    const waiting = days > 0 && enabled && !(acked && acked >= enabled) && Date.now() - enabled < 24 * 3600e3;
    review.hidden = !waiting;
    const lines = [];
    if (!days) lines.push('Prunes what is older than the days above, once an hour.');
    else if (waiting) lines.push(`On (${days} days), waiting: review what it would do to start now, or it starts on ${new Date(enabled.getTime() + 24 * 3600e3).toLocaleString()}.`);
    else if (days && !enabled) lines.push(`On (${days} days): its first check is within the hour; it then waits for your review.`);
    else lines.push(`On (${days} days).`);
    if (ret.last?.at) lines.push(`Last run ${new Date(ret.last.at).toLocaleString()}: freed ${_gib(ret.last.freed)}${ret.last.capped ? ' (stopped at the 2 GiB cap)' : ''}.`);
    _lines(status, lines);
}

/** Settings' value for automatic cleanup ({} when not read from Coral). */
export function retentionSettings() {
    const days = document.getElementById('settings-prune-days');
    const kind = document.getElementById('settings-prune-kind');
    const on = document.getElementById('settings-retention-enabled');
    if (!days || !on || isCloud() || on.dataset.loaded !== '1') return {};
    const n = on.checked ? Math.max(1, Math.min(3650, Math.floor(Number(days.value) || 0))) : 0;
    return { artifact_retention_days: String(n), artifact_retention_kinds: kind?.value || 'diffs' };
}

async function pruneRequest(body) {
    return requestJson('POST', '/api/artifacts/prune', body);
}

// The page's own words for what a prune removes, never the server's kind names (#4469, UX's #4456 SHOULD 11).
const PRUNE_NAMES = { diffs: ['saved diff', 'saved diffs'], objects: ['unlinked artifact', 'unlinked artifacts'], 'diff-objects': ['stored diff copy', 'stored diff copies'] };
function pruneSummary(rep) {
    const n = Object.values(rep.kinds || {}).reduce((a, k) => a + (k.count || 0), 0);
    return { n, text: Object.entries(rep.kinds || {}).map(([k, v]) => `${Number(v.count).toLocaleString()} ${(PRUNE_NAMES[k] || [k, k])[v.count === 1 ? 0 : 1]} (${_gib(v.bytes)})`).join(', ') };
}

/** A dry run, a confirmation (focus on Cancel), then the real run. */
async function previewAndRun(body, verb) {
    const result = document.getElementById('settings-storage-result');
    result.removeAttribute('data-state');
    result.textContent = 'Checking…';
    let dry;
    try {
        dry = await pruneRequest({ ...body, dry_run: true });
    } catch (e) {
        result.dataset.state = 'error';
        result.textContent = `Couldn't check: ${e.message}`;
        return;
    }
    const s = pruneSummary(dry);
    if (!s.n) {
        result.textContent = 'Nothing to do.';
        return;
    }
    result.textContent = '';
    const what = verb === 'Shrink' ? `saving about ${_gib(dry.freed)}. The code changes in them stay.` : `freeing about ${_gib(dry.freed)}. This can't be undone.`;
    const asker = document.getElementById(verb === 'Shrink' ? 'settings-storage-shrink' : 'settings-storage-prune');
    window.showConfirmModal?.(`${verb} saved data`, `${verb} ${s.text}, ${what}`, async () => {
        result.textContent = `${verb === 'Shrink' ? 'Shrinking' : 'Pruning'}…`;
        try {
            const done = await pruneRequest({ ...body, dry_run: false });
            result.textContent = `${verb === 'Shrink' ? 'Saved' : 'Freed'} ${_gib(done.freed)} from ${Number(done.removed).toLocaleString()} item${done.removed === 1 ? '' : 's'}${done.skipped ? `; ${done.skipped} left alone because ${done.skipped === 1 ? 'it' : 'they'} changed` : ''}${done.errors ? `; ${done.errors} error${done.errors === 1 ? '' : 's'}` : ''}.`;
            loadArtifactStoreSize();
        } catch (e) {
            result.dataset.state = 'error';
            result.textContent = `Couldn't finish: ${e.message}`;
        }
        asker?.focus(); // Yes closed the confirmation: the focus goes back to the button that asked, not to the page (#4469, UX's #4456 SHOULD 10)
    }, undefined, { label: verb, danger: true }); // the button says what it does: Prune or Shrink, not Yes
    // No default: focus starts on Cancel.
    requestAnimationFrame(() => document.querySelector('#confirm-modal .modal-actions .btn:not(#confirm-modal-yes)')?.focus());
}

export function wireStorageActions() {
    const shrink = document.getElementById('settings-storage-shrink');
    if (!shrink || shrink.dataset.wired) return;
    shrink.dataset.wired = '1';
    shrink.addEventListener('click', () => previewAndRun({ shrink: true }, 'Shrink'));
    document.getElementById('settings-storage-prune')?.addEventListener('click', () => {
        const days = Math.max(1, Math.floor(Number(document.getElementById('settings-prune-days').value) || 14));
        const kind = document.getElementById('settings-prune-kind').value;
        previewAndRun({ older_than_seconds: days * 86400, kinds: PRUNE_KINDS[kind] || ['diffs'] }, 'Prune');
    });
    document.getElementById('settings-retention-review')?.addEventListener('click', async () => {
        const status = document.getElementById('settings-retention-status');
        const days = Number(document.getElementById('settings-prune-days').value) || 0;
        const kind = document.getElementById('settings-prune-kind').value;
        if (!days) return;
        let dry;
        try {
            dry = await pruneRequest({ older_than_seconds: days * 86400, kinds: PRUNE_KINDS[kind] || ['diffs'], dry_run: true });
        } catch (e) {
            status.dataset.state = 'error';
            status.textContent = `Couldn't check: ${e.message}`;
            return;
        }
        const s = pruneSummary(dry);
        window.showConfirmModal?.('Start automatic cleanup',
            `Its first run would remove ${s.n ? `${s.text}, about ${_gib(dry.freed)}` : 'nothing right now'} (at most 2 GiB a run), then check every hour. Start it?`,
            async () => {
                let acked = true;
                try { await requestJson('POST', '/api/artifacts/retention/ack'); } catch { acked = false; }
                if (!acked) {
                    status.dataset.state = 'error';
                    status.textContent = "Couldn't start it: save the setting first.";
                    return;
                }
                loadStorageDetail();
            }, undefined, { label: 'Start cleanup', danger: true });
        requestAnimationFrame(() => document.querySelector('#confirm-modal .modal-actions .btn:not(#confirm-modal-yes)')?.focus());
    });
}

/** Settings: what other teams and Corals have sent this computer, against the limit on it (#4441). One status line says the total, how full it is (from
 *  80% on, with what to do), that new files are refused at the limit (in the warning colour), and how many received files no board lists. */
function receivedLine(r) {
    let line = _gib(r.bytes);
    let full = false, atLimit = false;
    if (r.max_bytes > 0) {
        const pct = Math.floor((r.bytes / r.max_bytes) * 100);
        atLimit = r.bytes >= r.max_bytes;
        full = atLimit || r.bytes * 5 >= r.max_bytes * 4;
        line += atLimit ? ` of ${_gib(r.max_bytes)}: new received files are refused` : full ? ` of ${_gib(r.max_bytes)} (${pct}% full)` : ` of ${_gib(r.max_bytes)}`;
    }
    if (full) line += '. Delete received files in Team Artifacts to make room, or raise the limit.';
    const u = Number(r.unlisted?.count) || 0;
    if (u) line += `${full ? ' ' : '. '}Not listed on any board: ${u.toLocaleString()} file${u === 1 ? '' : 's'}, ${_gib(r.unlisted.bytes)}. Another Coral sent ${u === 1 ? 'it' : 'them'} but the message that names ${u === 1 ? 'it' : 'them'} never came. ${u === 1 ? 'It counts' : 'They count'} toward the limit.${u > (r.unlisted.items || []).length ? ` Showing the oldest ${(r.unlisted.items || []).length}; delete them, then the rest.` : ''}`;
    return { line, atLimit };
}

function showReceivedCap(r) {
    const out = document.getElementById('settings-received-size');
    const input = document.getElementById('settings-received-max');
    if (!out || !input || !r) return;
    input.value = r.max_bytes > 0 ? String(Math.round(r.max_bytes / GIB)) : '0';
    input.dataset.loaded = '1'; // only a limit read from Coral is saved back
    input.disabled = false;
    const { line, atLimit } = receivedLine(r);
    out.textContent = line;
    if (atLimit) out.dataset.state = 'warn'; else delete out.dataset.state; // at the limit new files are refused: the warning colour
    showUnlistedReceived(r.unlisted);
}

// Received files no board lists: their message never came. They count in the limit; the Operator can delete them, by exact digest, after a
// confirmation. Never automatic (#4441, Security's #4440 INFO 2). The count is in the status line above; the button names what it deletes.
let _unlistedItems = [];
let _unlistedBytes = 0;
function showUnlistedReceived(u) {
    const box = document.getElementById('settings-received-unlisted');
    const button = document.getElementById('settings-received-unlisted-delete');
    if (!box || !button) return;
    _unlistedItems = Array.isArray(u?.items) ? u.items.map(i => i.id) : [];
    _unlistedBytes = (u?.items || []).reduce((sum, i) => sum + (Number(i.size) || 0), 0);
    box.hidden = _unlistedItems.length === 0;
    if (!_unlistedItems.length) return;
    const n = _unlistedItems.length;
    button.textContent = `Delete ${n.toLocaleString()} unlisted file${n === 1 ? '' : 's'} (${_gib(_unlistedBytes)})`;
    if (!button.dataset.wired) {
        button.dataset.wired = '1';
        button.addEventListener('click', confirmDeleteUnlisted);
    }
}

function confirmDeleteUnlisted() {
    const ids = _unlistedItems.slice();
    if (!ids.length) return;
    const n = ids.length;
    window.showConfirmModal?.('Delete received files',
        `Delete ${n.toLocaleString()} unlisted file${n === 1 ? '' : 's'} (${_gib(_unlistedBytes)})? Only ${n === 1 ? 'this file is' : 'these files are'} removed from Coral and can't be recovered; nothing else is touched, and a file something now lists or links is left alone.`,
        async () => {
            let d;
            try {
                d = await requestJson('POST', '/api/artifacts/received/unlisted/delete', { ids });
            } catch (e) {
                showToast(`Couldn't delete the received files: ${e.message}`, true);
                return;
            }
            const left = (d.skipped || []).length;
            showToast(`Deleted ${Number(d.deleted || 0).toLocaleString()} received file${d.deleted === 1 ? '' : 's'}, ${_gib(d.bytes)} freed.${left ? ` ${left} left alone: something lists or links ${left === 1 ? 'it' : 'them'}.` : ''}`, false, 8000);
            loadArtifactStoreSize();
        }, undefined, { label: 'Delete files', danger: true });
    requestAnimationFrame(() => document.querySelector('#confirm-modal .modal-actions .btn:not(#confirm-modal-yes)')?.focus());
}

/** The received-files limit to save, in bytes ({} when the field isn't on this page or was never read). */
export function receivedMaxSetting() {
    const input = document.getElementById('settings-received-max');
    if (!input || isCloud() || input.dataset.loaded !== '1') return {};
    if (String(input.value).trim() === '') return {}; // an emptied field is unchanged, never 0 (no limit) saved by accident
    const gib = Math.max(0, Math.floor(Number(input.value) || 0));
    return { received_artifacts_max_bytes: String(gib * GIB) };
}

/** The limit to save, in bytes ({} when the field isn't on this page). */
export function artifactStoreMaxSetting() {
    const input = document.getElementById('settings-artifact-store-max');
    // Not on this page, or never read from Coral (a failed load must not reset a limit to 0).
    if (!input || isCloud() || input.dataset.loaded !== '1') return {};
    if (String(input.value).trim() === '') return {}; // an emptied field is unchanged, never 0 (no limit) saved by accident
    const gib = Math.max(0, Math.floor(Number(input.value) || 0));
    return { artifact_store_max_bytes: String(gib * GIB) };
}
