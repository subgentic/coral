/* Share a file with an agent (#11376): on an agent's Artifacts tab, files dropped on the list, or chosen with its button (a phone has no drag), are stored as the team's artifacts uploaded by the Operator
 * (POST /api/board/{team}/operator-artifacts, one request a file) and ONE message tells the agent (.../operator-artifacts/message, the digests just stored). Everything the person is told is in words:
 * what is happening, what was refused and why. A file is only sent: it is never opened, run or rendered here. Names are the person's files', shown as text (textContent), made visible with visibleName. */
import { importOnce } from './import_once.js';
import { boardFetch } from './server_base.js';
import { showToast } from './utils.js';
import { visibleName } from './artifact_names.js';
import { loadStyles } from './lazy_styles.js';
const { el } = await importOnce('./data_table.js');
await loadStyles('operator_share.css');

const MAX_BYTES = 64 * 1024 * 1024; // the store's limit for one file (the same as an agent's upload)
const NAME_MAX = 160;
const FILES_MAX = 20; // the most one message names
const mib = n => `${Math.round(n / (1024 * 1024))} MiB`;

/** A header value is bytes: a name with letters beyond Latin-1 goes as its UTF-8 bytes, one per character, which is what the server reads. */
const asHeader = s => String.fromCharCode(...new TextEncoder().encode(s));

/** What a refused upload says, in words: the status and the server's code. */
export function refusalWords(status, code) {
    if (code === 'artifact_too_large' || status === 413 && code !== 'artifact_quota') return `it is over ${mib(MAX_BYTES)}`;
    if (code === 'artifact_quota') return 'the artifact store is full: delete old artifacts in Settings, Storage and cleanup';
    if (code === 'board_paused') return 'the team is paused, so nothing reaches its agents: resume it first';
    if (code === 'rate_limited' || status === 429) return 'too many files in a minute: wait a moment and try again';
    if (code === 'owner_only' || status === 403) return 'only the person at this computer can share a file with an agent';
    if (code === 'sign_in_link') return 'its name carries a sign-in link';
    if (status === 404) return 'this agent is no longer on the team';
    if (status === 400) return 'its name or type is not one Coral can keep';
    if (status === 507) return 'this computer\'s disk is almost full';
    return 'something went wrong';
}

/** The problems of a file before a byte is sent: nothing is uploaded that the server would only refuse. */
export function checkFile(file) {
    if (!file || file.size === 0) return 'it is empty';
    if (file.size > MAX_BYTES) return `it is over ${mib(MAX_BYTES)}`;
    if ([...file.name].length > NAME_MAX) return `its name is longer than ${NAME_MAX} characters`;
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f\u007f]/.test(file.name)) return 'its name has characters Coral cannot keep';
    return '';
}

/** Mounts the drop target and the button on the agent's Artifacts page `root`. ctx: { project, session, server, name, reload }. Called again with the same root, it only updates ctx. */
export function mountOperatorShare(root, ctx) {
    if (root._share) { const S = root._share; S.ctx = ctx; S.attach(); S.sync(); return; }
    const S = root._share = { ctx, busy: false, live: true };
    const row = el('div', 'share-drop');
    const pick = el('button', 'btn btn-small share-drop-pick', 'Upload a file'); pick.type = 'button';
    const input = el('input'); input.type = 'file'; input.multiple = true; input.hidden = true; input.tabIndex = -1; input.setAttribute('aria-hidden', 'true');
    const hint = el('span', 'share-drop-hint');
    const status = el('p', 'share-drop-status'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
    const target = el('div', 'share-drop-target'); target.setAttribute('aria-hidden', 'true');
    row.append(pick, hint, input, status);
    S.attach = () => { // the row above the list and the target over it (again, for an agent that has a team after one that had none)
        S.live = true;
        if (!row.isConnected) { const body = root.querySelector('.team-artifacts-body'); if (body) root.insertBefore(row, body); else root.prepend(row); }
        if (!target.isConnected) root.append(target);
    };
    S.detach = () => { S.live = false; depth = 0; root.classList.remove('share-drop-on'); row.remove(); target.remove(); };
    let depth = 0;
    S.attach();
    S.sync = () => {
        const n = visibleName(S.ctx.name || 'this agent');
        pick.setAttribute('aria-label', `Upload a file for ${n}`);
        hint.textContent = `Drop files here or press the button. Every agent on this team can read them; only ${n} is told.`;
        target.textContent = `Drop to share with ${n}`;
    };
    S.sync();
    const say = (text, bad = false) => { status.textContent = text; status.classList.toggle('share-drop-bad', bad); };

    async function send(files) {
        const c = S.ctx;
        if (S.busy) { say('An upload is still running: wait for it to finish.', true); return; }
        const list = [...files];
        if (!list.length) return;
        if (list.length > FILES_MAX) { say(`Choose at most ${FILES_MAX} files at a time.`, true); return; }
        S.busy = true; pick.disabled = true; root.setAttribute('aria-busy', 'true');
        const stored = [], problems = [];
        try {
            for (const [i, f] of list.entries()) {
                const shown = visibleName(f.name);
                const why = checkFile(f);
                if (why) { problems.push(`${shown}: ${why}`); continue; }
                say(`Uploading ${i + 1} of ${list.length}: ${shown} (${f.size < 1024 * 1024 ? `${Math.max(1, Math.round(f.size / 1024))} KiB` : mib(f.size)})`);
                try {
                    const r = await boardFetch(c.project, `/operator-artifacts?session_id=${encodeURIComponent(c.session)}`, {
                        method: 'POST', body: f,
                        headers: { 'Content-Type': 'application/octet-stream', 'X-Artifact-Name': asHeader(f.name), 'X-Artifact-Media-Type': f.type && f.type.length <= 127 ? asHeader(f.type) : '' },
                    });
                    const out = await r.json().catch(() => ({}));
                    if (r.ok && out.id) stored.push(out.id);
                    else problems.push(`${shown}: ${refusalWords(r.status, out.code)}`);
                } catch { problems.push(`${shown}: it could not be sent (the connection failed)`); }
            }
            let told = '';
            if (stored.length) {
                say(`Telling ${visibleName(c.name || 'the agent')}…`);
                try {
                    const r = await boardFetch(c.project, '/operator-artifacts/message', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ session_id: c.session, digests: stored }) });
                    const out = await r.json().catch(() => ({}));
                    if (r.ok && out.delivered) told = out.asleep ? ' The agent is asleep: it will find the message when it wakes.' : '';
                    else told = r.status === 409 ? ` ${visibleName(c.name || 'The agent')} was not told: ${refusalWords(r.status, out.code)}.` : out.reason === 'no_agent' ? ' Nobody on the team was told: the agent has left.' : ' The files are saved, but the agent could not be told. Try again, or tell it yourself.';
                } catch { told = ' The files are saved, but the agent could not be told (the connection failed).'; }
            }
            const done = stored.length ? `Shared ${stored.length === 1 ? 'a file' : `${stored.length} files`} with ${visibleName(c.name || 'the agent')}.` : 'Nothing was shared.';
            say([done + told, ...problems.map(p => `Not shared, ${p}.`)].join(' '), problems.length > 0 || told.includes('could not') || told.includes('not told'));
            if (stored.length) showToast(done, false, 4000);
        } finally {
            S.busy = false; pick.disabled = false; root.removeAttribute('aria-busy'); input.value = '';
        }
        if (stored.length) { try { await S.ctx.reload(); } catch { /* the list reads itself again */ } }
    }

    pick.addEventListener('click', () => input.click());
    input.addEventListener('change', () => send(input.files));
    const hasFiles = e => S.live && e.dataTransfer && [...(e.dataTransfer.types || [])].includes('Files');
    root.addEventListener('dragenter', e => { if (!hasFiles(e)) return; e.preventDefault(); depth++; root.classList.add('share-drop-on'); });
    root.addEventListener('dragover', e => { if (!hasFiles(e)) return; e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
    root.addEventListener('dragleave', e => { if (!hasFiles(e)) return; depth = Math.max(0, depth - 1); if (!depth) root.classList.remove('share-drop-on'); });
    root.addEventListener('drop', e => {
        if (!hasFiles(e)) return;
        e.preventDefault(); depth = 0; root.classList.remove('share-drop-on');
        const items = [...(e.dataTransfer.items || [])];
        if (items.some(it => it.kind === 'file' && it.webkitGetAsEntry && it.webkitGetAsEntry()?.isDirectory)) { say('A folder cannot be shared: choose its files.', true); return; }
        send(e.dataTransfer.files);
    });
}

/** An agent with no team (or none any more) shares nothing from here: the row and the target go, and a drop is not taken. */
export function unmountOperatorShare(root) { if (root._share) root._share.detach(); }
