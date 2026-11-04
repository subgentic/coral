// #13144 (the operator: 'lets add some icons on the left here to distinguish between the different types of requests in the inbox'): a Needs you row starts with a small icon for its kind, named for a screen reader,
// and the row keeps its height. A: every kind the Inbox shows (needs_filters.js KINDS: permission, question, needs input, file to review, failed run, to approve, goal looks done, skill to approve, welcome) gets its
// own icon with the kind's word as its label, drawn in the icon font in the secondary colour, and no text of its own. B: in the real table, at 1280 and 390, a waiting agent's row has its icon in front of the
// agent's button (on a phone, in the row's own line before the title: the mail row's button holds it; it stays the click target), the row text is unchanged, and the row is exactly as tall with the icon as without it.
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const { INBOX_WORLD } = require('./helpers/inbox_world');
const BASE = require('./test_base').BASE;
const { coralReady, framesJs } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const failures = [], T = '#group-table-view', S = `(window.__coralStatic || '/static/')`;
    const check = (ok, what) => { if (!ok) failures.push(what); };
    const shot = async n => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(`${d}/${n}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    const AGENT = { name: 'be', session_id: '00000001-0000-4000-8000-000000000001', agent_type: 'claude', server: 'local', status: 'idle', display_name: 'Backend Dev', working_directory: '/repo/be', waiting_for_input: true, waiting_kind: 'permission', waiting_summary: 'Do you trust the files in this folder?', waiting_since: new Date(Date.now() - 120000).toISOString() };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, mobile] of [[1280, false], [390, true]]) {
            const at = `${w} px: `;
            await Emulation.setDeviceMetricsOverride({ width: w, height: 844, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
            await ev(INBOX_WORLD);
            await ev(`(async () => { const { state } = await import(${S} + 'state.js'); const m = await import(${S} + 'inbox_tab.js'); state.liveSessions = [${JSON.stringify(AGENT)}]; m.updateInboxTab(); window.switchNavTab('hub-inbox'); await m.selectInboxTab('needs'); return true; })()`);
            await waitFor(`document.querySelectorAll('${T} tbody tr').length >= 1`, at + 'the permission row', 15000); await ev(framesJs(6));

            // A: every kind has its own icon, labelled, in the icon font, with no text of its own
            const kinds = await ev(`(async () => { const NF = await import(${S} + 'needs_filters.js'); const host = document.querySelector('${T}').parentElement; const out = [];
                for (const k of NF.KINDS) { const cell = NF.withKindIcon({ waiting_kind: k }, 'x'); host.append(cell); const i = cell.querySelector('.inbox-kind-icon'), cs = getComputedStyle(i), g = getComputedStyle(i, '::before').content;
                    out.push({ k, label: i.getAttribute('aria-label'), want: NF.KIND_LABEL[k], role: i.getAttribute('role'), text: i.textContent, glyph: g, font: cs.fontFamily, size: Math.round(parseFloat(cs.fontSize)), first: cell.firstChild === i, rest: cell.textContent }); cell.remove(); }
                return out; })()`);
            check(kinds.length === 9, at + 'nine kinds: ' + kinds.length);
            check(kinds.every(x => x.label && x.label === x.want && x.role === 'img' && x.text === '' && x.first && x.rest === 'x'), at + 'each icon is labelled with its kind, has no text, comes first and leaves the cell text alone: ' + JSON.stringify(kinds.filter(x => !(x.label === x.want && x.text === '' && x.first && x.rest === 'x'))));
            check(new Set(kinds.map(x => x.glyph)).size === kinds.length, at + 'every kind has its own glyph: ' + kinds.map(x => x.k + '=' + x.glyph).join(' '));
            check(kinds.every(x => /Material Icons/.test(x.font) && x.size >= 14 && x.size <= 20), at + 'drawn in the icon font at a small size: ' + JSON.stringify(kinds.map(x => [x.k, x.font, x.size])));

            // B: in the real table: the icon leads the agent's button, the click target stays, the row's height is the same without it
            // inCell: the row holds the icon (in the first cell on a computer, in the mail row's button on a phone)
            const measureRow = () => ev(`(() => { const tr = document.querySelector('${T} tbody tr'), td = tr.querySelector('td'), i = tr.querySelector('.inbox-kind-icon'), btn = tr.querySelector('.dt-primary'), h = () => Math.round(tr.getBoundingClientRect().height);
                if (!i) return null; const withIcon = h(), t = tr.textContent; i.style.display = 'none'; const without = h(); i.style.display = '';
                return { label: i.getAttribute('aria-label'), kind: i.dataset.kind, mail: !!btn.contains(i), before: (() => { const t = tr.querySelector('.dt-mail-title'); return t ? (t.contains(i) && t.firstChild === i) : !!(i.compareDocumentPosition(btn) & Node.DOCUMENT_POSITION_FOLLOWING); })(), sameLine: (() => { const t = tr.querySelector('.dt-mail-title'); if (!t) return true; const a = i.getBoundingClientRect(), b = t.getBoundingClientRect(), mid = (a.top + a.bottom) / 2; return mid >= b.top - 1 && mid <= b.bottom + 1; })(), name: btn.getAttribute('aria-label') || '', withIcon, without, hasName: /Backend Dev/.test(t), noLigatureText: !/lock|help_outline|rate_review/.test(t), inCell: tr.contains(i), iconRight: Math.round(i.getBoundingClientRect().right), btnLeft: Math.round(btn.getBoundingClientRect().left), color: getComputedStyle(i).color }; })()`);
            const row = await measureRow();
            check(!!row && row.label === 'Permission' && row.kind === 'permission' && row.inCell, at + 'the permission row has its icon: ' + JSON.stringify(row));
            check(!!row && row.before && (row.mail || row.iconRight <= row.btnLeft + 1), at + 'the icon is in front of the agent (on a phone: before the title in the row\'s line), not over it: ' + JSON.stringify(row));
            check(!!row && row.withIcon === row.without, at + `the row keeps its height (${row && row.withIcon} with the icon, ${row && row.without} without)`);
            check(!!row && row.hasName && row.noLigatureText, at + 'the row text is its words, no icon names: ' + JSON.stringify(row));
            await shot(`needs_kind_icons_${w}`);
            check(await ev(`!!document.querySelector('${T} tbody tr .dt-primary')`), at + 'the agent button is still there');
            if (mobile) { // a phone's open button names itself (aria-label): the kind is in that name, and the focused control says it
                check(/\bPermission\b/.test(row.name), at + "the open button's name says the kind: " + JSON.stringify(row.name));
                const focused = await ev(`(() => { const b = document.querySelector('${T} tbody tr .dt-primary'); b.focus(); return document.activeElement === b ? (b.getAttribute('aria-label') || '') : 'not focused'; })()`);
                check(/Permission/.test(focused), at + 'the focused control is named with the kind: ' + focused);
            }
            // real 200% text (root 32 px): the icon stays on the title's own line and the row is as tall with it as without
            await ev(`document.documentElement.style.fontSize = '200%'; true`); await ev(framesJs(4));
            const big = await measureRow();
            check(!!big && big.before && big.sameLine && big.withIcon === big.without, at + '200% text: the icon leads the title, on its line, and the row keeps its height: ' + JSON.stringify(big));
            await ev(`document.documentElement.style.fontSize = ''; true`);
        }
    } finally { await client.close(); }
    if (failures.length) { console.error(failures.join('\n')); process.exit(1); }
    console.log('needs_kind_icons_browser: ok');
})().catch(e => { console.error(e); process.exit(1); });
