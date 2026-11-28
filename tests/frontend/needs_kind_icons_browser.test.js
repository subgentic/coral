// #13144 / #13701: every Needs you kind has a named glyph (needs_filters' kind icon, the glyph of every row the approved list of #22094
// does not draw itself). In the approved list (article.nl-row) a permission prompt leads with its lock (span.material-icons.nl-icon) in
// the row's leading column, in front of the title; the row, which is the open control, names its kind, and hiding the glyph leaves the
// row height unchanged, including at 200% text: the icon's own height adds nothing (a spacer of its width and no height in its place gives the
// same row), and without its column the title may at most take one line less (the icon's width can move a title near its wrap point).
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
            await waitFor(`document.querySelectorAll('${T} .nl-row.nl-permission').length >= 1`, at + 'the permission row', 15000); await ev(framesJs(6));

            // A: every kind has its own icon, labelled, in the icon font, with no text of its own
            const kinds = await ev(`(async () => { const NF = await import(${S} + 'needs_filters.js'); const host = document.querySelector('${T}').parentElement; const out = [];
                for (const k of NF.KINDS.filter(k => k !== 'answered_ask' && k !== 'comment_sent')) { const cell = NF.withKindIcon({ waiting_kind: k }, 'x'); host.append(cell); const i = cell.querySelector('.inbox-kind-icon'), cs = getComputedStyle(i), g = getComputedStyle(i, '::before').content;
                    out.push({ k, label: i.getAttribute('aria-label'), want: NF.KIND_LABEL[k], role: i.getAttribute('role'), text: i.textContent, glyph: g, font: cs.fontFamily, size: Math.round(parseFloat(cs.fontSize)), first: cell.firstChild === i, rest: cell.textContent }); cell.remove(); }
                return out; })()`);
            // #20909 adds the access-granted notice to the nine waiting kinds.
            check(kinds.map(x => x.k).join(',') === 'permission,question,other,review,run,proposal,goal_done,skill_review,welcome,access', at + 'all ten kinds: ' + kinds.map(x => x.k));
            check(kinds.find(x => x.k === 'access')?.glyph === '"key"', at + 'access uses its own grant glyph');
            check(kinds.every(x => x.label && x.label === x.want && x.role === 'img' && x.text === '' && x.first && x.rest === 'x'), at + 'each icon is labelled with its kind, has no text, comes first and leaves the cell text alone: ' + JSON.stringify(kinds.filter(x => !(x.label === x.want && x.text === '' && x.first && x.rest === 'x'))));
            check(new Set(kinds.map(x => x.glyph)).size === kinds.length, at + 'every kind has its own glyph: ' + kinds.map(x => x.k + '=' + x.glyph).join(' '));
            check(kinds.every(x => /Material Icons/.test(x.font) && x.size >= 14 && x.size <= 22), at + 'drawn in the icon font at the tile size: ' + JSON.stringify(kinds.map(x => [x.k, x.font, x.size])));

            // B: in the real list: the icon leads the row's title in its leading column, the row (the open control) stays, the row's height is the same without it
            const measureRow = () => ev(`(() => { const tr = document.querySelector('${T} .nl-row.nl-permission'), i = tr && tr.querySelector(':scope > .nl-icon'), title = tr && tr.querySelector('.nl-title'), h = () => Math.round(tr.getBoundingClientRect().height);
                if (!i || !title) return null; const withIcon = h(); i.style.height = '0px'; i.style.overflow = 'hidden'; const spacer = h(); i.style.height = ''; i.style.overflow = ''; i.style.display = 'none'; const without = h(); i.style.display = ''; const line = parseFloat(getComputedStyle(title).lineHeight) || 20;
                const words = [...tr.querySelectorAll('.nl-body')].map(n => n.textContent).join(' ');
                return { label: i.getAttribute('aria-label'), role: i.getAttribute('role'), glyph: i.textContent, font: getComputedStyle(i).fontFamily, before: i.getBoundingClientRect().right <= title.getBoundingClientRect().left + 1, sameLine: (() => { const a = i.getBoundingClientRect(), r = tr.getBoundingClientRect(); return a.top - r.top >= 0 && a.top - r.top <= 24; })(), name: tr.getAttribute('aria-label') || '', withIcon, spacer, without, line, hasName: /Backend Dev/.test(words), noLigatureText: !/lock|help_outline|rate_review/.test(words), inCell: tr.contains(i), iconRight: Math.round(i.getBoundingClientRect().right), titleLeft: Math.round(title.getBoundingClientRect().left), color: getComputedStyle(i).color }; })()`);
            const row = await measureRow();
            check(!!row && row.label === 'Permission prompt' && row.role === 'img' && row.glyph === 'lock' && /Material Icons/.test(row.font) && row.inCell, at + 'the permission row has its lock, named for a screen reader: ' + JSON.stringify(row));
            check(!!row && row.before && row.iconRight <= row.titleLeft + 1, at + 'the icon is in front of the title, not over it: ' + JSON.stringify(row));
            check(!!row && row.withIcon === row.spacer && row.withIcon - row.without >= 0 && row.withIcon - row.without <= row.line + 1, at + `the row keeps its height (${row && row.withIcon} with the icon, ${row && row.spacer} with a spacer of its width, ${row && row.without} without, a line is ${row && row.line})`);
            check(!!row && row.hasName && row.noLigatureText, at + 'the row text is its words, no icon names (the glyph\'s name is only in the icon, read by its label): ' + JSON.stringify(row));
            await shot(`needs_kind_icons_${w}`);
            check(await ev(`(() => { const r = document.querySelector('${T} .nl-row.nl-permission'); return !!r && r.tabIndex === 0; })()`), at + 'the row is still the open control (in the tab order)');
            // the row is the open control and names itself (aria-label): the kind is in that name, and the focused control says it
            check(/\bpermission\b/i.test(row.name), at + "the row's name says the kind: " + JSON.stringify(row.name));
            const focused = await ev(`(() => { const b = document.querySelector('${T} .nl-row.nl-permission'); b.focus(); return document.activeElement === b ? (b.getAttribute('aria-label') || '') : 'not focused'; })()`);
            check(/permission/i.test(focused), at + 'the focused control is named with the kind: ' + focused);
            // real 200% text (root 32 px): the icon stays on the title's own line and the row is as tall with it as without
            await ev(`document.documentElement.style.fontSize = '200%'; true`); await ev(framesJs(4));
            const big = await measureRow();
            check(!!big && big.before && big.sameLine && big.withIcon === big.spacer && big.withIcon - big.without >= 0 && big.withIcon - big.without <= big.line + 1, at + '200% text: the icon leads the title, on its line, and the row keeps its height (its column at most one title line): ' + JSON.stringify(big));
            await ev(`document.documentElement.style.fontSize = ''; true`);
        }
    } finally { await client.close(); }
    if (failures.length) { console.error(failures.join('\n')); process.exit(1); }
    console.log('needs_kind_icons_browser: ok');
})().catch(e => { console.error(e); process.exit(1); });
