/* Approve, Request changes and the change-request send through the hub for a computer added by URL (#11378). The hub makes a secret for the computer; the PERSON takes it to that computer and runs
 * `coral hub-owner-secret` there (a human act at the computer: nothing on it can be told to do it over the network). This panel asks first, because a new line stops the old stamps until the computer has
 * it, then shows the line once. Everything from the hub is set as text. */

function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
}

/** Mount into `host` for the computer `id` (its name `label` is for the words). onClose() is called when the person is done. Returns { unmount }. */
export function mountOwnerSecret(host, { id, label = id, onClose = () => {}, onChanged = () => {} } = {}) {
    let dead = false, error = '', line = '', busy = false;

    async function make() {
        busy = true; error = ''; draw();
        let resp, data = {};
        try {
            resp = await fetch(`/api/servers/${encodeURIComponent(id)}/owner-secret`, { method: 'POST' });
            data = await resp.json().catch(() => ({}));
        } catch { resp = null; }
        if (dead) return;
        busy = false;
        if (!resp || !resp.ok) error = (data && (data.error || data.message)) || 'Could not reach the hub. Try again.';
        else { line = data.setup_line || ''; onChanged(); }
        draw();
    }

    async function copy(input, say) {
        try { await navigator.clipboard.writeText(input.value); say.textContent = 'Copied.'; } catch { input.type = 'text'; input.select(); say.textContent = 'Select the line and copy it.'; } // a hidden field cannot be copied from by hand: shown for the fallback
    }

    function button(text, cls, fn, disabled = false) {
        const b = el('button', `btn ${cls || ''}`.trim(), text);
        b.type = 'button'; b.disabled = disabled; b.addEventListener('click', fn);
        return b;
    }

    // The line leaves the page itself when the person is done: it is not left for a redraw of the list to take away.
    function finish() { dead = true; line = ''; host.replaceChildren(); onClose(); }

    function draw() {
        if (dead) return;
        host.replaceChildren();
        const root = el('div', 'servers-form owner-secret');
        root.append(el('h4', '', 'Approve through this hub'));
        if (error) { const e = el('div', 'servers-form-error', error); e.setAttribute('role', 'alert'); root.append(e); }
        if (!line) {
            root.append(el('p', 'ssh-help', `This makes a secret for ${label} so Approve, Request changes and Send to agent can work through this hub. You then run one command at that computer and paste a line: nothing else can install it there.`));
            root.append(el('p', 'ssh-note', 'If this computer already has a secret, a new one stops the old one until you paste the new line.'));
            const bar = el('div', 'servers-form-actions');
            bar.append(button('Cancel', '', finish), button(busy ? 'Working...' : 'Make the line', 'btn-primary', make, busy));
            root.append(bar);
        } else {
            root.append(el('p', 'ssh-help', `Paste it at ${label} now: run this command there and paste the line when it asks. It is not shown again.`));
            const cmd = el('code', 'ssh-key-fp', 'coral hub-owner-secret'); root.append(cmd);
            const l = el('label', 'ssh-label', 'The line to paste'); l.htmlFor = 'owner-secret-line';
            const inp = el('input', 'field ssh-input'); inp.id = 'owner-secret-line'; inp.type = 'password'; inp.readOnly = true; inp.autocomplete = 'off'; inp.value = line; inp.spellcheck = false;
            const say = el('span', 'ssh-help'); say.setAttribute('role', 'status');
            root.append(l, inp, say);
            const bar = el('div', 'servers-form-actions');
            const show = button('Show', '', () => { const hidden = inp.type === 'password'; inp.type = hidden ? 'text' : 'password'; show.textContent = hidden ? 'Hide' : 'Show'; show.setAttribute('aria-pressed', String(hidden)); });
            show.setAttribute('aria-pressed', 'false');
            bar.append(show, button('Copy', '', () => copy(inp, say)), button('Done', 'btn-primary', finish));
            root.append(bar);
            inp.select();
        }
        host.append(root);
    }

    draw();
    return { unmount() { dead = true; line = ''; host.replaceChildren(); } };
}
