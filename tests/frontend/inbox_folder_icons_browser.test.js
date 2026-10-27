// #8866: the actual Inbox folder column uses UI/UX's existing icons and shared provider marks.
// Checks decoration/accessibility, wrapping/count geometry at 200% text, and the phone's compact select; captures both themes at1280/390.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { connect } = require('./agent_view_harness');
const { setTheme } = require('./helpers/contrast');
const BASE = require('./test_base').BASE;
const ICONS = { needs: 'notifications', tasks: 'checklist', goals: 'flag', saved: 'saved-bookmark', artifacts: 'inventory_2', chats: 'chat_bubble_outline', 'chats-group': 'forum', 'chats-notes': 'edit_note', 'chats-starred': 'star', 'chats-active': 'bolt', 'chats-archived': 'folder' };
(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const width of [1280, 390]) for (const font of [16, 32]) for (const theme of ['dark', 'light']) {
            const label = `${width}-${font}-${theme}`;
            await Emulation.setDeviceMetricsOverride({ width, height: width === 390 ? 844 : 1400, deviceScaleFactor: 1, mobile: width === 390 });
            await Emulation.setTouchEmulationEnabled({ enabled: width === 390 });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
            await ev(`window.__coralReady.startup('liveList', 'liveListLoaded', 'settings')`);
            await setTheme(ev, theme);
            await ev(`document.documentElement.style.fontSize = '${font}px'; window.switchNavTab('hub-inbox'); true`);
            await waitFor(`document.querySelector('.sidebar-pane[data-pane="hub-inbox"] .view-list-item[data-key="chats-cli-pi"]')`, `${label}: all Inbox folders`, 10000);
            const probe = await ev(`(() => {
                const nav = document.querySelector('.sidebar-pane[data-pane="hub-inbox"] .view-list-nav');
                return { visible: !!nav.getClientRects().length, overflow: document.documentElement.scrollWidth > innerWidth,
                    rows: [...nav.querySelectorAll('.view-list-item')].map(b => {
                        const name = b.querySelector('.view-list-name'), icon = b.querySelector('.view-list-icon'), count = b.querySelector('.view-list-count');
                        const r = b.getBoundingClientRect(), n = name.getBoundingClientRect(), i = icon?.getBoundingClientRect(), c = count?.getBoundingClientRect();
                        return { key: b.dataset.key, name: name.textContent, aria: b.getAttribute('aria-label'), icon: icon?.dataset.icon, hidden: icon?.getAttribute('aria-hidden'), svg: !!icon?.querySelector('path'),
                            mark: icon?.dataset.agentType, letter: icon?.dataset.agentType ? getComputedStyle(icon, '::before').content.replace(/"/g, '') : '',
                            iconColor: icon ? getComputedStyle(icon).color : '', textColor: getComputedStyle(name).color, size: icon ? parseFloat(getComputedStyle(icon).fontSize) : 0,
                            row: { left:r.left, right:r.right, top:r.top, bottom:r.bottom }, text: { left:n.left, right:n.right, top:n.top, bottom:n.bottom }, gap: i ? n.left - i.right : null, countLeft: c?.left,
                            cut: name.scrollWidth > name.clientWidth + 1 };
                    }) };
            })()`);
            for (const [key, expected] of Object.entries(ICONS)) {
                const row = probe.rows.find(r => r.key === key);
                assert.ok(row, `${label}: ${key} exists`);
                assert.equal(row.icon, expected, `${label}: ${key} uses the selected icon`);
                assert.equal(row.hidden, 'true', `${label}: ${key} icon is decorative`);
                assert.ok(row.aria.startsWith(row.name), `${label}: name precedes count, with no icon word`);
                if (key === 'saved') assert.ok(row.svg, `${label}: Saved reuses the bookmark shape`);
                if (probe.visible) {
                    assert.equal(row.iconColor, row.textColor, `${label}: ${key} follows its text colour`);
                    assert.equal(row.size, font * 1.125, `${label}: ${key} follows top-bar icon size`);
                    assert.ok(Math.abs(row.gap - 10) < 1, `${label}: ${key} gap is10px`);
                    assert.ok(!row.cut && row.text.bottom <= row.row.bottom + 1 && row.text.left >= row.row.left, `${label}: ${key} label stays inside its row`);
                    if (row.countLeft != null) assert.ok(row.text.right <= row.countLeft + 1, `${label}: ${key} count stays at right`);
                }
            }
            for (const [type, letter] of [['claude', 'C'], ['codex', 'X'], ['agy', 'A'], ['pi', 'P']]) {
                const row = probe.rows.find(r => r.key === 'chats-cli-' + type);
                assert.equal(row?.mark, type, `${label}: ${type} uses shared provider mark`);
                assert.equal(row.hidden, 'true'); assert.equal(row.letter, letter);
            }
            assert.equal(probe.overflow, false, `${label}: no page overflow`);
            if (width === 390) assert.ok(await ev(`!!document.querySelector('#group-table-view .view-list-select')?.getClientRects().length`), `${label}: phone folder select remains usable`);
            const shots = process.env.CORAL_SCREENSHOT_DIR;
            if (shots) { fs.mkdirSync(shots, { recursive: true }); fs.writeFileSync(path.join(shots, 'inbox-folder-icons-' + label + '.png'), Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); }
            console.log('PASS ' + label + ': folder icons, provider marks, labels and counts');
        }
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
