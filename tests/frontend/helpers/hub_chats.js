// The hub's Chats page, for a suite that tests the history list and filters (history_list.js, history_filters.js): a local Coral's Chats are the Inbox's folders (#7776) and have no sidebar list, so
// the suite shows the list's pane and its empty view the way the hub's Chats tab does, and keeps them when the page asks for the Chats tab again (switchNavTab('history')). `ev` is the suite's page-side evaluate.
async function showHubChats(ev) {
    return ev(`Promise.all([import((window.__coralStatic || '/static/') + 'sidebar.js'), import((window.__coralStatic || '/static/') + 'view_switch.js'), import((window.__coralStatic || '/static/') + 'sidebar_groups.js'), import((window.__coralStatic || '/static/') + 'history_filters.js')]).then(([sb, vs, sg, hf]) => {
        const show = () => { sb.showSidebarPane('history'); vs.showView('chats-empty-view'); document.body.setAttribute('data-nav-tab', 'history'); hf.loadHistoryFiltered(); sg.refreshGroupTable('history'); }; // the hub's tab reads the list when it opens
        if (!window.__hubChats) { window.__hubChats = true; const orig = window.switchNavTab; window.switchNavTab = (tab, opts) => { const r = orig(tab, opts); if (tab === 'history') show(); return r; }; }
        show(); return true; })`);
}
module.exports = { showHubChats };
