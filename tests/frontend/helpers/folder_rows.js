// Inbox folder rows carry an icon (#8866), and an icon font's ligature name is text inside the row ("flagGoals5"). A suite that reads a row's words reads them through this, without the icon:
//   ROW_WORDS    the source of an in-page function: row -> its words, icon removed, whitespace collapsed ("Goals 5"); use it as `(${ROW_WORDS})(row)`
//   FOLDER_ROWS  the source of an in-page expression: every .view-list-item's words, in order
const ROW_WORDS = `(b => { const c = b.cloneNode(true); c.querySelectorAll('.view-list-icon').forEach(i => i.remove()); return c.textContent.replace(/\\s+/g, ' ').trim(); })`;
const FOLDER_ROWS = `[...document.querySelectorAll('.view-list-item')].map(${ROW_WORDS})`;
module.exports = { ROW_WORDS, FOLDER_ROWS };
