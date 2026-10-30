/* Set a Coral server up on another computer over SSH, and upgrade, stop or remove one set up that way (#11370).
 *
 * The self-hosted hub does the work (internal/server/routes/hub_provision*.go); this page only walks the person through the three presses and shows each step:
 *   1. plan: the host and the steps, nothing connects;  2. connect: the host key, shown as fingerprints;  3. run: the terms, and the press that accepts them.
 * Everything it shows from the hub is set as text, never as markup. The hub keeps the scanned host keys itself: what is sent back is only "I accept these" and the digest of the terms text that was
 * shown, never a key. Nothing here is a secret: the remote's API key is read and kept by the hub and never reaches this page. */

const POLL_MS = 1000;

const STEP_WORDS = { pending: 'Waiting', running: 'Working', ok: 'Done', failed: 'Failed', skipped: 'Skipped' };
const STEP_GLYPH = { pending: 'radio_button_unchecked', running: 'hourglass_top', ok: 'check_circle', failed: 'error', skipped: 'block' };

function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
}

async function api(method, path, body) {
    const resp = await fetch(path, { method, headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
    let data = {};
    try { data = await resp.json(); } catch { /* an empty body */ }
    return { ok: resp.ok, status: resp.status, data };
}

const sayError = (r, fallback) => (r.data && (r.data.error || r.data.message)) || fallback;

/** What each kind of plan is called and does, in the words the person confirms. */
const KINDS = {
    setup: { title: 'Set up a server over SSH', go: 'Set up', intro: 'This hub will connect to that computer with your SSH access, install the Coral release this hub runs under your home folder, and start it in tmux, listening on that computer only. Nothing is opened to the network.' },
    upgrade: { title: 'Upgrade the server', go: 'Upgrade', intro: 'This hub will install the Coral release it runs on that computer and restart Coral there. A Coral that already runs this release is left alone.' },
    stop: { title: 'Stop Coral on that computer', go: 'Stop Coral', intro: 'This stops Coral on that computer. Its files stay, and the server stays in this hub\'s list.' },
    remove: { title: 'Remove Coral from that computer', go: 'Remove', intro: 'This stops Coral on that computer, deletes what was installed there, and removes the server from this hub.' },
};

// The kinds, by their KINDS keys in this order (the names the hub's plan uses). They are taken from the keys so no quoted word here is read as an icon's name (the icon census counts any whole string that is one).
const [SETUP, UPGRADE, STOP, REMOVE] = Object.keys(KINDS);

/**
 * Mount the flow into `host`. mode 'setup' starts from a host; mode 'manage' acts on `server` (a registered server set up over SSH) with `action` (upgrade, stop or remove).
 * onClose() is called when the person leaves it; onChanged() when the server list changed (a server was added or removed, or upgraded). Returns { unmount }.
 */
export function mountSshSetup(host, { mode = 'setup', server = null, action = null, deleteData = false, pollMs = POLL_MS, onClose = () => {}, onChanged = () => {} } = {}) {
    const st = { step: 'loading', options: null, plan: null, error: '', busy: false, keysOk: false, typed: '', timer: null, dead: false, form: { host: '', picked: '', label: '' } };

    const kind = () => (st.plan ? st.plan.kind : mode === 'manage' ? action : 'setup');
    const words = () => KINDS[kind()] || KINDS.setup;
    const needsTerms = () => kind() === SETUP || kind() === UPGRADE;

    function stop() { st.dead = true; if (st.timer) clearTimeout(st.timer); st.timer = null; }

    function close() { stop(); onClose(); }

    async function cancelPlan() {
        const p = st.plan;
        stop();
        if (p && p.phase !== 'running' && p.phase !== 'done') { try { await api('DELETE', `/api/servers/provision/${encodeURIComponent(p.plan)}`); } catch { /* it expires */ } }
        onClose();
    }

    function apply(r, fallback) {
        if (!r.ok) { st.error = sayError(r, fallback); st.busy = false; return false; }
        st.plan = r.data; st.error = ''; st.busy = false;
        return true;
    }

    async function begin() {
        const o = await api('GET', '/api/servers/provision/options');
        if (st.dead) return;
        if (!o.ok) { st.error = sayError(o, 'Could not read the setup options.'); st.step = 'failed'; return draw(); }
        st.options = o.data;
        if (mode === 'manage') {
            const body = { server_id: server.id, action };
            if (action === REMOVE) body.delete_data = !!deleteData;
            const r = await api('POST', '/api/servers/provision/plan', body);
            if (st.dead) return;
            if (!apply(r, 'Could not plan that.')) { st.step = 'failed'; return draw(); }
            st.step = 'plan';
        } else st.step = 'target';
        draw();
    }

    async function makePlan() {
        const f = st.form;
        const typed = f.host.trim();
        if (!f.picked && !typed) { st.error = 'Choose a host from your SSH config, or type user@host.'; return draw(); }
        st.busy = true; st.error = ''; draw();
        const body = f.picked ? { alias: f.picked } : { target: typed };
        if (f.label.trim()) body.label = f.label.trim();
        const r = await api('POST', '/api/servers/provision/plan', body);
        if (st.dead) return;
        if (apply(r, 'Could not plan that.')) st.step = 'plan';
        draw();
    }

    async function connect() {
        st.busy = true; st.error = ''; draw();
        const r = await api('POST', `/api/servers/provision/${encodeURIComponent(st.plan.plan)}/connect`);
        if (st.dead) return;
        if (!apply(r, 'Could not connect.')) return draw();
        st.step = st.plan.phase === 'failed' ? 'failed' : 'ready';
        draw();
    }

    async function run() {
        st.busy = true; st.error = ''; draw();
        const body = {};
        if (needsTerms()) { body.accept_terms = true; body.terms_sha256 = st.options.terms.sha256; }
        if (st.plan.host_keys && st.plan.host_keys.length) body.accept_keys = true;
        if (kind() === REMOVE) body.confirm = st.typed.trim();
        const r = await api('POST', `/api/servers/provision/${encodeURIComponent(st.plan.plan)}/run`, body);
        if (st.dead) return;
        if (!apply(r, 'Could not start.')) return draw();
        st.step = 'running';
        draw();
        poll();
    }

    function poll() {
        if (st.dead) return;
        st.timer = setTimeout(async () => {
            const r = await api('GET', `/api/servers/provision/${encodeURIComponent(st.plan.plan)}`);
            if (st.dead) return;
            if (r.ok) {
                st.plan = r.data;
                if (r.data.phase === 'done' || r.data.phase === 'failed') {
                    st.step = r.data.phase === 'done' ? 'done' : 'failed';
                    onChanged();
                    return draw();
                }
            } else if (r.status === 404) { st.error = 'This setup is no longer on the hub.'; st.step = 'failed'; return draw(); }
            draw();
            poll();
        }, pollMs);
    }

    // ── drawing ────────────────────────────────────────────────────────────

    function stepList(steps) {
        const ol = el('ol', 'ssh-steps');
        for (const s of steps || []) {
            const li = el('li', `ssh-step ssh-step-${s.state}`);
            const g = el('span', 'material-icons ssh-step-glyph', STEP_GLYPH[s.state] || STEP_GLYPH.pending);
            g.setAttribute('aria-hidden', 'true');
            const body = el('span', 'ssh-step-body');
            body.append(el('span', 'ssh-step-title', s.title), el('span', 'ssh-step-state', ` ${STEP_WORDS[s.state] || ''}`));
            if (s.detail) body.append(el('span', 'ssh-step-detail', s.detail));
            li.append(g, body);
            ol.append(li);
        }
        return ol;
    }

    function button(label, cls, onClick, disabled = false) {
        const b = el('button', `btn ${cls || ''}`.trim(), label);
        b.type = 'button';
        b.disabled = disabled;
        b.addEventListener('click', onClick);
        return b;
    }

    function errorLine() {
        if (!st.error) return null;
        const e = el('div', 'servers-form-error', st.error);
        e.setAttribute('role', 'alert');
        return e;
    }

    function drawTarget(root) {
        const f = st.form;
        const form = el('form', 'ssh-form');
        form.addEventListener('submit', e => { e.preventDefault(); makePlan(); });
        const hosts = (st.options && st.options.hosts) || [];
        if (hosts.length) {
            const l = el('label', 'ssh-label', 'A host from your SSH config'); l.htmlFor = 'ssh-picked';
            const sel = el('select', 'field ssh-input'); sel.id = 'ssh-picked';
            sel.append(new Option('Type a host instead', ''));
            for (const h of hosts) sel.append(new Option(h, h));
            sel.value = f.picked;
            sel.addEventListener('change', () => { f.picked = sel.value; draw(); });
            form.append(l, sel);
        }
        const l2 = el('label', 'ssh-label', 'Or type user@host[:port]'); l2.htmlFor = 'ssh-host';
        const inp = el('input', 'field ssh-input'); inp.id = 'ssh-host'; inp.type = 'text'; inp.value = f.host; inp.placeholder = 'rich@build.example.com'; inp.disabled = !!f.picked;
        inp.autocomplete = 'off'; inp.spellcheck = false; inp.maxLength = 300;
        inp.addEventListener('input', () => { f.host = inp.value; });
        const l3 = el('label', 'ssh-label', 'Display name (optional)'); l3.htmlFor = 'ssh-label';
        const lab = el('input', 'field ssh-input'); lab.id = 'ssh-label'; lab.type = 'text'; lab.value = f.label; lab.maxLength = 64;
        lab.addEventListener('input', () => { f.label = lab.value; });
        const help = el('p', 'ssh-help', 'This hub uses your own SSH access (your agent and your known hosts). A host key it has not seen is shown to you to confirm. No password is asked for here.');
        const bar = el('div', 'servers-form-actions');
        const go = el('button', 'btn btn-primary', st.busy ? 'Checking...' : 'Review the plan'); go.type = 'submit'; go.disabled = st.busy;
        bar.append(button('Cancel', '', close), go);
        form.append(l2, inp, l3, lab, help, bar);
        root.append(form);
        (f.picked ? form.querySelector('#ssh-picked') : inp).focus?.();
    }

    function drawPlan(root) {
        const p = st.plan;
        const dl = el('dl', 'facts servers-facts');
        const fact = (k, v) => { const d = el('div', 'servers-fact'); d.append(el('dt', '', k), el('dd', '', v)); dl.append(d); };
        fact('Computer', p.target);
        fact('Server name in this hub', `${p.label} (${p.server_id})`);
        if (kind() === REMOVE) fact('Data', p.delete_data ? 'Deleted too: the key, the history and the install folder.' : 'Kept: the data, the key and the instance id stay on that computer.');
        root.append(el('p', 'ssh-intro', words().intro), dl, el('h5', 'ssh-subhead', 'What will happen'), stepList(p.steps));
        root.append(el('p', 'ssh-help', 'Nothing has connected yet. The next press connects, and checks the host key.'));
        const bar = el('div', 'servers-form-actions');
        bar.append(button('Cancel', '', cancelPlan), button(st.busy ? 'Connecting...' : 'Connect', 'btn-primary', connect, st.busy));
        root.append(bar);
    }

    function drawReady(root) {
        const p = st.plan;
        const tm = st.options.terms;
        root.append(el('p', 'ssh-intro', `Connected to ${p.target}. ${p.system ? p.system + '.' : ''}`.trim()));
        const keys = p.host_keys || [];
        if (keys.length) {
            root.append(el('h5', 'ssh-subhead', 'Check the host key'));
            root.append(el('p', 'ssh-help', 'This computer has not been connected to from here before. Compare these fingerprints with the ones the computer shows (ssh-keygen -lf on its host key). If you cannot tell, stop here.'));
            const ul = el('ul', 'ssh-keys');
            for (const k of keys) {
                const li = el('li', 'ssh-key');
                li.append(el('span', 'ssh-key-host', k.host), el('span', 'ssh-key-type', ` ${k.type}`), el('code', 'ssh-key-fp', k.fingerprint));
                ul.append(li);
            }
            root.append(ul);
            const row = el('label', 'ssh-check');
            const cb = el('input', 'check'); cb.type = 'checkbox'; cb.id = 'ssh-keys-ok'; cb.checked = st.keysOk;
            cb.addEventListener('change', () => { st.keysOk = cb.checked; draw(); });
            row.append(cb, el('span', '', ' These fingerprints are the computer I mean to set up.'));
            root.append(row);
        }
        if (kind() === UPGRADE) {
            root.append(el('p', 'ssh-note', 'An upgrade installs the version this hub runs, even over a newer one on that computer (that is a downgrade). If it fails after Coral was stopped, Coral on that computer stays stopped.'));
        }
        if (kind() === REMOVE || kind() === STOP) {
            root.append(el('p', 'ssh-note', kind() === REMOVE
                ? 'If it fails after Coral was stopped, Coral on that computer stays stopped, and the server stays in this hub\'s list.'
                : 'Agents running in that Coral end when it stops.'));
        }
        if (needsTerms()) {
            root.append(el('h5', 'ssh-subhead', `Terms of Service (version ${tm.version})`));
            const pre = el('pre', 'ssh-terms'); pre.textContent = tm.text; pre.tabIndex = 0; pre.setAttribute('aria-label', 'The Terms of Service');
            root.append(pre);
            // TODO(operator): the wording of the next two lines is a placeholder until the operator answers: (1) that the terms also cover the other Coral installs of the account used on that computer,
            // (2) how the hub's computer name appears in the record (it is the label the hub sends: hub-owner@<this computer's name>).
            root.append(el('p', 'ssh-consent', `By pressing ${words().go} you accept these Terms of Service for Coral on ${p.target}, and for the other Coral installs of the account you use there.`));
            root.append(el('p', 'ssh-consent', `That computer records who accepted (${st.options.acceptance_label}), when, and which version of the terms.`));
        }
        let typedOk = true;
        if (kind() === REMOVE) {
            const l = el('label', 'ssh-label', `Type the server name (${p.server_id}) to confirm`); l.htmlFor = 'ssh-typed';
            const t = el('input', 'field ssh-input'); t.id = 'ssh-typed'; t.type = 'text'; t.value = st.typed; t.autocomplete = 'off'; t.spellcheck = false;
            t.addEventListener('input', () => { st.typed = t.value; const go = root.querySelector('[data-ssh-go]'); if (go) go.disabled = st.busy || (keys.length > 0 && !st.keysOk) || st.typed.trim() !== p.server_id; });
            root.append(l, t);
            typedOk = st.typed.trim() === p.server_id;
        }
        const bar = el('div', 'servers-form-actions');
        const go = button(st.busy ? 'Working...' : words().go, kind() === REMOVE ? 'btn-danger' : 'btn-primary', run, st.busy || (keys.length > 0 && !st.keysOk) || !typedOk);
        go.dataset.sshGo = '1';
        bar.append(button('Cancel', '', cancelPlan), go);
        root.append(bar);
    }

    function drawRunning(root, done) {
        const p = st.plan;
        const live = el('div', 'ssh-progress');
        live.setAttribute('role', 'status'); live.setAttribute('aria-live', 'polite');
        live.append(stepList(p.steps));
        root.append(live);
        if (done) {
            root.append(el('p', 'ssh-done', kind() === 'setup' ? 'Done. The server is in your list.' : 'Done.'));
            const bar = el('div', 'servers-form-actions');
            bar.append(button('Close', 'btn-primary', close));
            root.append(bar);
        }
    }

    function drawFailed(root) {
        const p = st.plan;
        if (p && p.steps) root.append(stepList(p.steps));
        const msg = (p && p.error) || st.error || 'It did not finish.';
        const e = el('div', 'servers-form-error', msg); e.setAttribute('role', 'alert');
        root.append(e);
        root.append(el('p', 'ssh-help', 'Nothing more was done. You can start again; a setup that already finished its earlier steps skips them.'));
        const bar = el('div', 'servers-form-actions');
        bar.append(button('Close', 'btn-primary', close));
        root.append(bar);
    }

    function draw() {
        if (st.dead) return;
        const keepFocus = document.activeElement && host.contains(document.activeElement) ? document.activeElement.id : '';
        host.replaceChildren();
        const root = el('div', 'servers-form ssh-setup');
        root.append(el('h4', '', words().title));
        const err = st.step === 'failed' ? null : errorLine();
        if (err) root.append(err);
        if (st.step === 'loading') root.append(el('p', 'ssh-help', 'Loading...'));
        else if (st.step === 'target') drawTarget(root);
        else if (st.step === 'plan') drawPlan(root);
        else if (st.step === 'ready') drawReady(root);
        else if (st.step === 'running') drawRunning(root, false);
        else if (st.step === 'done') drawRunning(root, true);
        else if (st.step === 'failed') drawFailed(root);
        host.append(root);
        if (keepFocus) { const f = host.querySelector(`#${CSS.escape(keepFocus)}`); if (f && f.focus) f.focus(); }
    }

    draw();
    begin();
    return { unmount: stop };
}
