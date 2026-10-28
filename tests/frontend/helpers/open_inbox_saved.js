// The Inbox's Saved for later folder, the way a person gets there now that the top bar has no bookmark (#9929): the Inbox tab, then its Saved folder.
// OPEN_INBOX_SAVED is a page expression (a promise): `await ev(OPEN_INBOX_SAVED)`.
const OPEN_INBOX_SAVED = `(async () => { window.switchNavTab('hub-inbox'); for (let i = 0; i < 60 && document.querySelector('.top-nav-tab.active')?.dataset.arg !== 'hub-inbox'; i++) await new Promise(r => setTimeout(r, 50)); /* sleep-ok: the tab is active before its folder is chosen, or the list is read for the page behind it */ const m = await import((window.__coralStatic || '/static/') + 'inbox_tab.js'); await m.selectInboxTab('saved'); return true; })()`;
module.exports = { OPEN_INBOX_SAVED };
