// What the list renderer census (list_renderer_census.test.mjs) counts, as functions its own checks run on fixtures (#8064, UI/UX's audit #8058): where the dashboard draws a Tasks list or a Board message list,
// and where it reads the routes of those lists. The goal (#38) is ONE module for each: tasks_view.js for tasks, board_table.js for the board's messages; every other module that draws a row of either, or
// reads the list's route to draw its own, is a second renderer. Three signals for tasks, three for the board; each is a regular expression over the module's code (comments and strings that only name them
// in prose are not code: line comments and block comments are removed first).

/** The code of a module: block comments and whole-line and trailing `//` comments removed (a URL's `//` is kept: it follows a colon). */
export function code(src) {
    return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
}

export const SIGNALS = {
    tasks: {
        // the shared task columns (task_columns.js): a module that builds task rows with them is drawing a Tasks list
        columns: /\btaskColumns\b/g,
        // the row's own classes: a module that makes them draws a task row itself
        rowClass: /\bboard-task-(?:item|name|open|id|desc)\b/g,
        // a read of a list of tasks: the global list, a board's list, or a team's (limit and status parameters), for a surface to draw
        listRoute: /\/api\/board\/tasks\?|_boardTasksFetch\(|(?:boardFetch|teamFetch)\([^)]*[`'"]\/tasks\?/g,
    },
    board: {
        // a message row's markup: the class on a made element or in a template string
        row: /class="mb-message[\s"]|className\s*=\s*['"`]mb-message[\s'"`]|classList\.add\(\s*['"]mb-message['"]/g,
        // the row's body and head parts of the table (board_table.js builds them for every surface)
        part: /\bmb-row-(?:toggle|avatar|snippet|who|tags)\b/g,
        // a read of the board's messages: the page, the dock, a search
        listRoute: /\/messages\/(?:all|search)\b/g,
    },
};

/** Counts per signal of one module's source: { tasks: { columns, rowClass, listRoute }, board: { ... } } (only the signals above zero are present). */
export function scan(src) {
    const c = code(src), out = {};
    for (const [kind, signals] of Object.entries(SIGNALS)) {
        for (const [name, re] of Object.entries(signals)) {
            const n = (c.match(re) || []).length;
            if (n) (out[kind] ||= {})[name] = n;
        }
    }
    return out;
}

// The one module of each, and the modules that may name a signal without being a second renderer, each with its reason. A file not listed is counted against the baseline.
export const OWNERS = {
    tasks: { 'task_columns.js': 'defines the columns (the module a tasks_view.js draws with)', 'tasks_view.js': 'the one Tasks list (#8060)' },
    board: { 'board_table.js': 'the one Board message list module (#7921)', 'board_fetch.js': 'the one reader of the board\'s messages for a page, the dock and an export' },
};
