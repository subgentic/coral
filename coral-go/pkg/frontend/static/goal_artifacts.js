/* A goal's Artifacts tab: the newest files, ordered by task and filename, with
 * per-file decisions and the shared review editor in the goal preview pane.
 * Reads stay source-qualified, owner-protected and paged. Names and task titles
 * are built with textContent. Lazy: the goal view imports this module. */
import { boardFetch, isCloud, pathId, splitKey } from './server_base.js';
import { onArtifactsRev } from './artifacts_feed.js';
import { whenText } from './when_text.js';
import { showToast } from './utils.js';
import { importOnce } from './import_once.js';
const Decisions = await importOnce('./goal_decisions.js');
const { el } = await importOnce('./dom_el.js');
const { itemKey, isUnverified, readableName, sizeText, typeText, createdText, taskText, managedHex, linkOfItem, renderText } = await importOnce('./artifact_item.js');
const { renderArtifact } = await importOnce('./artifact_preview.js');
const { openDetailPane } = await importOnce('./detail_pane.js');

const paneReviews = new WeakMap();
export function disposeGoalArtifactReview(host) { const previous = paneReviews.get(host); paneReviews.delete(host); delete host.dataset.goalArtifactKey; previous?.api?.close(); previous?.api?.destroy(); }

// the first 20 and Load more; on a phone the first 5, so the button is on screen without scrolling (UI/UX, #8616)
const pageSize = () => (matchMedia('(max-width: 760px)').matches ? 5 : 20);

async function read(team, goalId, extra) {
    const resp = await boardFetch(team, `/artifacts?goal=${pathId(goalId)}&${extra}`);
    if (!resp.ok) {
        // Through Coral Hub the list is the owner's alone: the computer answers a View grantee 403 owner_only (as for the team's Artifacts page), which is not a failure to read
        if (resp.status === 403 && await resp.json().then(b => b && (b.code === 'owner_only' || b.error === 'owner_only'), () => false)) throw new Error('owner_only');
        // A View guest of a computer reaches it through Coral Hub, which answers the owner-only list with its own 404 (the bytes of a missing route) and never asks the computer (#11280): through the Hub that is 'not for you' too. A 404 anywhere else is still an error.
        // The computer's own 404 is JSON with code board_not_found (a deleted team): that stays an error an owner should see (Security on #11280); the Hub's is a bare missing route.
        if (resp.status === 404 && isCloud() && await resp.json().then(b => !(b && b.code === 'board_not_found'), () => true)) throw new Error('owner_only');
        throw new Error(`HTTP ${resp.status}`);
    }
    return resp.json();
}

/** The file in the goal screen's own pane: its name, its facts behind Details, the document, Open and Copy link. `host` is the pane element, `onClose` runs when it is closed. */
export function openArtifactInPane(item, { team, host, opener, onClose, backLabel = '', files = {} }) {
    const link = linkOfItem(item, { server: splitKey(team).server, project: team }), name = readableName(item), un = isUnverified(item);
    const actions = []; let rendered = false, previewContext = null;
    disposeGoalArtifactReview(host);
    // A task's own result file has no link of its own (its text is read from the task): on the Hub an address into the team's server cannot be opened by a click or passed on, so Open and Copy link are not offered
    // for it there, and the pane says so (#11190); a file kept under a digest still has the viewer, which saves its bytes through the Hub.
    const noHubLink = isCloud() && !!link && !link.hex;
    if (link && !noHubLink) {
        if (link.preview) actions.push({ label: 'Open', primary: true, run: () => importOnce('./artifact_viewer.js').then(m => (link.hex ? m.openArtifactViewer(link.hex, { server: link.server, board: splitKey(team).name, filename: name, mediaType: item.media_type, ...files }) : window.open(link.url, '_blank', 'noopener,noreferrer'))) });
        else actions.push({ label: 'Open link', primary: true, href: link.url });
        actions.push({ label: 'Copy link', run: () => { navigator.clipboard?.writeText(link.hex ? `coral://artifacts/${link.hex}` : new URL(link.url, location.href).href).then(() => showToast('Link copied'), () => showToast('The link could not be copied', true)); } });
    }
    host.dataset.goalArtifactKey = itemKey(item);
    for (const row of host.closest('.goal-split')?.querySelectorAll('[data-file-key]') || []) { if (row.dataset.fileKey === itemKey(item)) row.setAttribute('aria-current', 'true'); else row.removeAttribute('aria-current'); }
    const shown = openDetailPane({
        key: itemKey(item), opener, title: name, host, backLabel, onClose: () => { disposeGoalArtifactReview(host); onClose?.(); }, focusClose: true, resizable: true, // the keyboard starts on the pane's Close, as for a task (#8952)
        sub: [un ? '' : typeText(item), un ? '' : sizeText(item.size), whenText(item.created_at)].filter(Boolean).join(' · '), subTitle: createdText(item),
        facts: [['Task', taskText(item)], ['Producer', item.produced_by], ['Team', team], ['Link', noHubLink ? 'Through Coral Hub this file is read here: it has no link to open or copy.' : ''], ['Status', un ? 'Link not verified: this team has not uploaded this file, so Coral shows no size, type or preview' : '']].filter(([, v]) => v),
        body: link && link.preview ? (h, { signal, isStale }) => { previewContext = { signal, isStale }; return renderArtifact(h, link.hex ? `coral://artifacts/${link.hex}` : item.uri || '', { server: link.server, filename: name, mediaType: item.media_type, contentURL: link.contentURL, board: splitKey(team).name }, { signal, isStale, renderContent: renderText, openEntry: () => {}, setMeta: () => {}, opened: () => {
            if (isStale()) return; rendered = true; delete host.dataset.contentPending; host.dispatchEvent(new Event('av-content'));
            if (link.hex && !isCloud()) importOnce('./inbox_reviews.js').then(m => m.recordOpenedVersion(link.hex, { server: link.server, board: splitKey(team).name })).catch(() => {});
        } }); } : null,
        actions,
    });
    if (shown && link?.hex) {
        host.dataset.contentPending = rendered ? '' : '1'; if (rendered) delete host.dataset.contentPending;
        host.dataset.shownVersion = String(item.version || 1); delete host.dataset.newerVersion;
        const toolbar = el('div', 'goal-review-toolbar'), chips = el('div', 'goal-review-status'), menu = el('div'); menu.hidden = true;
        toolbar.append(chips, menu); const main = host.querySelector('.pane-body'); main.before(toolbar);
        const ordered = files.goalItems || [], index = ordered.findIndex(a => itemKey(a) === itemKey(item));
        const nav = el('nav', 'goal-review-nav'); nav.setAttribute('aria-label', 'Files of this goal');
        for (const [label, offset] of [['← Prev', -1], ['Next →', 1]]) { const b = el('button', 'btn btn-small', label); b.type = 'button'; b.disabled = !ordered[index + offset]; b.addEventListener('click', () => { const next = ordered[index + offset]; if (next) openArtifactInPane(next, { team, host, opener, onClose, backLabel, files: Decisions.decisionFiles(ordered, next, team) }); }); nav.append(b); }
        if (index >= 0) nav.append(el('span', null, `${index + 1} of ${ordered.length}`)); toolbar.prepend(nav);
        const author = el('div', 'goal-review-author'), producer = el('span', 'goal-review-producer'); author.append(producer); if (item.produced_by) importOnce('./agent_link.js').then(m => { if (author.isConnected) producer.append(m.agentLink(item.produced_by, { board: team, session: item.session_id || '' })); });
        if (item.task_id) author.append(el('span', 'chip', `Task #${item.task_id}`)); if (item.review_question) author.append(el('span', null, item.review_question)); toolbar.before(author);
        const nextPending = ordered.slice(index + 1).find(a => Decisions.decisionState(a) === 'review');
        const reviewHandle = {}; paneReviews.set(host, reviewHandle);
        importOnce('./artifact_review.js').then(m => {
            if (paneReviews.get(host) !== reviewHandle || previewContext?.isStale()) return;
            reviewHandle.api = m.attachReview(host, { inline: true, approveLabel: nextPending ? 'Approve & Next' : '',
                slots: { '.artifact-viewer-header': toolbar, '.artifact-viewer-actions': toolbar, '.artifact-viewer-chips': chips, '.artifact-viewer-menu': menu, '.artifact-viewer-main': main, '.artifact-viewer-close': host.querySelector('.detail-close') },
                reload: hex => { const found = ordered.find(a => managedHex(a) === hex); if (found) openArtifactInPane(found, { team, host, opener, onClose, backLabel, files: Decisions.decisionFiles(ordered, found, team) }); else importOnce('./artifact_viewer.js').then(v => v.openArtifactViewer(hex || link.hex, { server: link.server, board: splitKey(team).name, filename: name })); },
                onApproved: () => { if (nextPending && paneReviews.get(host) === reviewHandle) openArtifactInPane(nextPending, { team, host, opener, onClose, backLabel, files: Decisions.decisionFiles(ordered, nextPending, team) }); },
            }); reviewHandle.api.open(link.hex, { server: link.server, board: splitKey(team).name, filename: name });
        }).catch(() => { if (paneReviews.get(host) === reviewHandle) toolbar.append(el('span', null, 'Review controls could not be loaded. Open the file to try again.')); });
    }
    return shown;
}

export function mountGoalArtifactsList(host, { team, goalId, onOpen = () => {}, onCount = () => {} }) {
    host.replaceChildren();
    let disposed = false, firstPaint = true;
    const st = { items: [], cursor: '', total: 0, filter: 'all', busy: false, seq: 0, loadedOnce: false, failed: false };

    function draw() {
        host.replaceChildren();
        if (st.ownerOnly) { host.append(el('p', 'goals-note', 'Artifacts are for the account this computer is linked to.')); return; }
        if (!st.loadedOnce) { host.append(el('p', 'goals-note', st.failed ? 'The artifacts could not be read.' : 'Loading…')); return; }
        if (!st.items.length) {
            const p = el('p', 'goals-note', 'No artifacts yet. An agent shares a file when it finishes a task with one.'); host.append(p);
            if (st.teamTotal > 0) { // the team has files, none on a task of this goal (an upload made with no task, or another goal's): say so and where they are (#15244, walk 12 M7)
                p.classList.add('goal-artifacts-elsewhere'); p.append(` This team has ${st.teamTotal} ${st.teamTotal === 1 ? 'file' : 'files'} in all. `);
                const b = el('button', 'btn btn-quiet btn-small', 'Open all Artifacts'); b.type = 'button';
                b.addEventListener('click', async () => { window.switchNavTab?.('hub-inbox'); await (await importOnce('./inbox_tab.js')).selectInboxTab('artifacts'); });
                p.append(b);
            }
            return;
        }
        const approved = st.items.filter(a => Decisions.decisionState(a) === 'approved').length, review = st.items.filter(a => Decisions.decisionState(a) === 'review').length, sentback = st.items.filter(a => Decisions.decisionState(a) === 'sentback').length;
        const summary = el('div', 'goal-file-summary'), text = el('div', 'goal-file-summary-counts', `${approved} of ${st.items.length} approved · ${review} to review · ${sentback} sent back${st.cursor ? ' (loaded files)' : ''}`);
        const progress = el('div', 'goal-decision-segments'); progress.setAttribute('role', 'img'); progress.setAttribute('aria-label', text.textContent);
        for (const [cls, n] of [['is-approved', approved], ['is-review', review], ['is-sentback', sentback]]) if (n) { const part = el('span', cls); part.style.flexGrow = String(n); progress.append(part); }
        const filters = el('div', 'goal-file-filters'); filters.setAttribute('role', 'group'); filters.setAttribute('aria-label', 'Filter goal decisions');
        for (const [key, label, n] of [['all', 'All', st.items.length], ['review', 'To review', review], ['sentback', 'Sent back', sentback]]) { const b = el('button', 'btn btn-small', `${label} (${n})`); b.type = 'button'; b.setAttribute('aria-pressed', String(st.filter === key)); b.addEventListener('click', () => { st.filter = key; draw(); [...host.querySelectorAll('.goal-file-filters button')].find(x => x.textContent === b.textContent)?.focus({ preventScroll: true }); }); filters.append(b); }
        summary.append(text, progress, filters); host.append(summary);
        host.append(Decisions.decisionList(st.items.filter(a => st.filter === 'all' || Decisions.decisionState(a) === st.filter), { team, onOpen: (item, opener) => onOpen(item, opener, Decisions.decisionFiles(Decisions.decisionOrder(st.items), item, team)) }));
        const selected = host.closest('.goal-split')?.querySelector('.goal-detail-pane:not([hidden])')?.dataset.goalArtifactKey;
        for (const row of host.querySelectorAll('[data-file-key]')) if (selected && row.dataset.fileKey === selected) row.setAttribute('aria-current', 'true');
        if (firstPaint && selected && host.closest('.goal-review-desk') && matchMedia('(max-width: 900px)').matches) { firstPaint = false; requestAnimationFrame(() => { if (!disposed) host.closest('.goal-split')?.querySelector('.goal-detail-pane:not([hidden])')?.scrollIntoView({ block: 'start' }); }); }
        if (st.cursor) { const more = el('button', 'btn btn-small', st.busy ? 'Loading…' : 'Load more'); more.type = 'button'; more.disabled = st.busy; more.addEventListener('click', () => load(true)); host.append(more); }
    }

    async function load(more) {
        if (st.busy) { if (!more) st.again = true; return; } // a refresh asked while a read is going is run when it ends: that read may have been answered before what the refresh is for (#20945)
        st.busy = true;
        try {
            const data = await read(team, goalId, `versions=newest&sort=name&limit=${pageSize()}${more && st.cursor ? `&cursor=${encodeURIComponent(st.cursor)}` : ''}`);
            if (disposed) return;
            const have = new Set(more ? st.items.map(itemKey) : []);
            st.items = (more ? st.items : []).concat((Array.isArray(data.artifacts) ? data.artifacts : []).filter(a => a && !have.has(itemKey(a))));
            st.cursor = typeof data.next_cursor === 'string' ? data.next_cursor : '';
            if (Number.isFinite(Number(data.total))) st.total = Number(data.total);
            st.loadedOnce = true; st.failed = false;
            if (!more && !st.items.length && st.teamTotal === undefined) { // nothing on this goal: does the team hold files at all?
                st.teamTotal = 0;
                try { const r = await boardFetch(team, '/artifacts?limit=1'); if (r.ok) { const d = await r.json(); st.teamTotal = Number.isFinite(Number(d.total)) ? Number(d.total) : (d.artifacts || []).length; } } catch { /* the plain line stays */ }
            }
            onCount(st.total);
        } catch (e) {
            if (e && e.message === 'owner_only') { st.ownerOnly = true; st.items = []; st.cursor = ''; st.total = 0; onCount(0); } else if (!st.loadedOnce) st.failed = true;
        }
        st.busy = false;
        if (disposed) return;
        draw();
        if (st.again) { st.again = false; load(false); }
    }

    const refreshVisible = () => { if (!disposed && host.isConnected && host.getClientRects().length) load(false); };
    const stop = onArtifactsRev(refreshVisible), onApproved = e => { if (e.detail?.team === team) refreshVisible(); };
    document.addEventListener('coral:review-approved', onApproved);
    draw();
    load(false);
    return { refresh() { st.loadedOnce = false; load(false); }, destroy() { disposed = true; stop(); document.removeEventListener('coral:review-approved', onApproved); st.seq++; host.replaceChildren(); } };
}

/** How many files a goal's tasks hold (the Artifacts tab's count before the tab is opened); 0 when the read fails. */
export async function countGoalArtifacts(team, goalId) {
    try { const data = await read(team, goalId, 'versions=newest&limit=1'); return Number.isFinite(Number(data.total)) ? Number(data.total) : (data.artifacts || []).length; } catch { return 0; }
}
