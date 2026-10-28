import { serverFilter } from './inbox_servers.js';
/* The Inbox chat folders' search and Filters (#8603, UI/UX #8589 section 9): what they are, how they are kept in the browser per folder, and how they become the history route's parameters (GET
 * /api/sessions/history: source_types, agent_name, tag_ids, date_from, date_to and q; the folder's own rule, Archived or Starred or a CLI, stays and wins). Pure (no DOM; it imports the model and the browser
 * store) so it is tested on its own; inbox_toolbar.js draws the controls on the shared list bar. Only fields the chats' data already carries: a history row has no team, and the route has no order of its own
 * (newest first), so there is no Team or Sort here. */
import { defineFilters } from './filter_model.js';
import { browserLocal } from './safe_storage.js';

export const CLIS = [['claude', 'Claude'], ['codex', 'Codex'], ['agy', 'Antigravity'], ['pi', 'Pi']];
const CLI_LABEL = Object.fromEntries(CLIS);

/** The tags' names by id, for the tag chip's words (the page sets them from the counts it has read; an id it does not know reads as Tag). */
let tagNames = new Map();
export function setTagNames(map) { tagNames = map instanceof Map ? map : new Map(); }

const model = defineFilters({
    server: serverFilter,
    q: { type: 'text', max: 200 }, // no chip: the search box shows the words, and a chip of them was the same words twice (#10484)
    cli: { type: 'choice', values: CLIS.map(c => c[0]), chip: v => `CLI: ${CLI_LABEL[v]}` },
    agent: { type: 'text', max: 80, chip: v => `Agent: ${v}` },
    tagId: { type: 'custom', empty: '', clean: v => (/^[1-9]\d{0,11}$/.test(String(v)) ? String(v) : ''), filtered: v => !!v, chip: v => `Tag: ${tagNames.get(v) || 'Tag'}`, clear: f => ({ ...f, tagId: '' }) }, // the key is tagId: the icon scanner reads a quoted lower-case word that is an icon's name as an icon
    folder: { type: 'custom', empty: '', clean: v => (/^(\/|[A-Za-z]:[\\/])/.test(v) && v.length <= 500 ? v : ''), filtered: v => !!v, chip: v => `Folder: ${folderName(v)}`, clear: f => ({ ...f, folder: '' }) }, // the folder a chat ran in (#10390)
    dates: { type: 'range', from: 'from', to: 'to', chip: (a, b) => (a && b ? `Dates: ${a} to ${b}` : a ? `From ${a}` : `Until ${b}`) },
});
/** A folder path's last part: the words a row, a chip and the filter's choices show (the whole path is the tooltip). */
export const folderName = path => String(path).split(/[\\/]+/).filter(Boolean).pop() || String(path);

export const { EMPTY, clean, isFiltered, isQuery, chips, without } = model;

/** The fields each folder's Filters panel has (keys of the list bar spec): the folder's own rule is not asked again (a CLI folder has no CLI field, a tag folder no tag field), and a board's history has no CLI, agent or tag. */
export function fieldsFor(key) {
    if (key === 'chats-group') return ['dates'];
    if (/^chats-cli-/.test(key)) return ['agent', 'tagId', 'folder', 'dates'];
    if (/^chats-tag-/.test(key)) return ['cli', 'agent', 'folder', 'dates'];
    return ['cli', 'agent', 'tagId', 'folder', 'dates'];
}

export const storageKey = key => `coral-inbox-chats-filters:${key}`;
const kept = model.persist(storageKey);
/** The filters kept in this browser for a folder (the search words are not kept), or the empty ones. */
export const loadFilters = key => ({ ...kept.load(key, browserLocal), q: '' });
export const saveFilters = (key, f) => kept.save(key, { ...f, q: '' }, browserLocal);

/** The extra parameters of a folder's history read, as an object: only the fields the folder has and the person set. The search is the caller's own (it has always been). */
export function toParams(key, f) {
    const c = clean(f), has = new Set(fieldsFor(key)), p = {};
    if (has.has('cli') && c.cli) p.source_types = c.cli;
    if (has.has('agent') && c.agent) p.agent_name = c.agent;
    if (has.has('tagId') && c.tagId) p.tag_ids = c.tagId;
    if (has.has('folder') && c.folder) p.folder = c.folder;
    if (has.has('dates')) { if (c.from) p.date_from = c.from; if (c.to) p.date_to = c.to; }
    return p;
}
