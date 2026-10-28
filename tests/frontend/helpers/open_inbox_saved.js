// The Inbox's Saved for later folder, the way a person gets there now that the top bar has no bookmark (#9929): the Inbox tab, then its Saved folder.
// OPEN_INBOX_SAVED is a page expression (a promise): `await ev(OPEN_INBOX_SAVED)`.
const OPEN_INBOX_SAVED = `(async () => { window.switchNavTab('hub-inbox'); const m = await import((window.__coralStatic || '/static/') + 'inbox_tab.js'); await m.selectInboxTab('saved'); return true; })()`;
module.exports = { OPEN_INBOX_SAVED };
