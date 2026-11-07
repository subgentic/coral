/* Shared static file-type artwork. No file content is loaded or interpreted.
 * Existing language/type illustration colours stay fixed across themes; these
 * decorative SVGs are the same palette formerly owned by file_explorer.js. */
const ICON_SHAPES = {
    // code: angle brackets  < / >
    code: '<path d="M5.5 4 1.5 8l4 4" fill="none" stroke="CCC" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M10.5 4l4 4-4 4" fill="none" stroke="CCC" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>',
    // data: curly braces { }
    data: '<path d="M5 2.5C3.5 2.5 3 3.5 3 4.5v2c0 1-1 1.5-1 1.5s1 .5 1 1.5v2c0 1 .5 2 2 2" fill="none" stroke="CCC" stroke-width="1.3" stroke-linecap="round"/><path d="M11 2.5c1.5 0 2 1 2 2v2c0 1 1 1.5 1 1.5s-1 .5-1 1.5v2c0 1-.5 2-2 2" fill="none" stroke="CCC" stroke-width="1.3" stroke-linecap="round"/>',
    // markup: tag  </>
    markup: '<path d="M4.5 4.5 1.5 8l3 3.5" fill="none" stroke="CCC" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/><path d="M11.5 4.5l3 3.5-3 3.5" fill="none" stroke="CCC" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/><path d="M9 2.5 7 13.5" fill="none" stroke="CCC" stroke-width="1.2" stroke-linecap="round"/>',
    // style: paintbrush / asterisk shape
    style: '<circle cx="8" cy="8" r="3" fill="none" stroke="CCC" stroke-width="1.3"/><path d="M8 1.5v3m0 7v3M1.5 8h3m7 0h3M3.4 3.4l2.1 2.1m5 5 2.1 2.1M12.6 3.4l-2.1 2.1m-5 5-2.1 2.1" stroke="CCC" stroke-width="1" stroke-linecap="round"/>',
    // doc: lines of text
    doc: '<path d="M3 3h10M3 6h8M3 9h10M3 12h6" stroke="CCC" stroke-width="1.3" stroke-linecap="round"/>',
    // markdown: M with hash
    md: '<path d="M2 12V4l3 4 3-4v8" fill="none" stroke="CCC" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/><path d="M11 5v6m-2-4h4" stroke="CCC" stroke-width="1.4" stroke-linecap="round"/>',
    // shell: terminal prompt  >_
    shell: '<path d="M2.5 4.5l4 3.5-4 3.5" fill="none" stroke="CCC" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M8.5 12.5h5" stroke="CCC" stroke-width="1.5" stroke-linecap="round"/>',
    // config: gear
    config: '<circle cx="8" cy="8" r="2.5" fill="none" stroke="CCC" stroke-width="1.2"/><path d="M8 1v2m0 10v2M1 8h2m10 0h2M3.05 3.05l1.4 1.4m7.1 7.1 1.4 1.4M12.95 3.05l-1.4 1.4m-7.1 7.1-1.4 1.4" stroke="CCC" stroke-width="1.1" stroke-linecap="round"/>',
    // image: landscape with sun
    image: '<rect x="1.5" y="2.5" width="13" height="11" rx="1.5" fill="none" stroke="CCC" stroke-width="1.1"/><circle cx="5" cy="6" r="1.5" fill="CCC" opacity=".7"/><path d="M1.5 11l3.5-4 3 3 2-1.5L14.5 12" fill="none" stroke="CCC" stroke-width="1.1" stroke-linejoin="round"/>',
    // video: play button in frame
    video: '<rect x="1.5" y="3" width="13" height="10" rx="1.5" fill="none" stroke="CCC" stroke-width="1.1"/><path d="M6.5 6v4l4-2z" fill="CCC" opacity=".8"/>',
    // audio: music note
    audio: '<circle cx="5" cy="12" r="2" fill="CCC" opacity=".7"/><path d="M7 12V3l6-1.5V4" fill="none" stroke="CCC" stroke-width="1.2"/><circle cx="11" cy="10" r="2" fill="CCC" opacity=".7"/><path d="M13 10V2.5" fill="none" stroke="CCC" stroke-width="1.2"/>',
    // pdf: page with P
    pdf: '<path d="M3 1h7l3 3v11H3z" fill="CCC" fill-opacity=".12" stroke="CCC" stroke-width=".8"/><path d="M7 11V6h1.5a2 2 0 0 1 0 4H7" fill="none" stroke="CCC" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>',
    // git: branch icon
    git: '<circle cx="8" cy="3" r="1.5" fill="none" stroke="CCC" stroke-width="1.2"/><circle cx="5" cy="13" r="1.5" fill="none" stroke="CCC" stroke-width="1.2"/><circle cx="11" cy="10" r="1.5" fill="none" stroke="CCC" stroke-width="1.2"/><path d="M8 4.5v2c0 1.5-1 2.5-3 3V11.5m3-5c0 1.5 1 2.5 3 3" fill="none" stroke="CCC" stroke-width="1.2"/>',
    // docker: container / whale
    docker: '<path d="M1 8h3V5h3V2h3v3h3v3h1.5a2 2 0 0 1 0 3H1a3 3 0 0 1 0-3z" fill="CCC" fill-opacity=".2" stroke="CCC" stroke-width=".9"/><path d="M4 5h2v3M7 2h2v6M10 5h2v3" stroke="CCC" stroke-width=".7"/>',
    // make: hammer
    make: '<path d="M3 13l5.5-5.5" stroke="CCC" stroke-width="2" stroke-linecap="round"/><path d="M8.5 7.5l2-2c1-1 3.5-.5 4-1s.5-2.5-.5-3.5-3-.5-3.5.5-.5 3-1 4l-2 2" fill="CCC" fill-opacity=".3" stroke="CCC" stroke-width=".8"/>',
    // license: shield
    license: '<path d="M8 1L2 3.5v4c0 4 2.5 6 6 7.5 3.5-1.5 6-3.5 6-7.5v-4z" fill="CCC" fill-opacity=".15" stroke="CCC" stroke-width="1"/><path d="M6 8l1.5 2L10.5 6" fill="none" stroke="CCC" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>',
    // generic: plain page
    generic: '<path d="M3.5.5h6L13 4v11H3.5z" fill="CCC" fill-opacity=".1" stroke="CCC" stroke-width=".8"/><path d="M9.5.5V4H13" fill="none" stroke="CCC" stroke-width=".8"/>',
    // env: key
    env: '<circle cx="5" cy="8" r="2.5" fill="none" stroke="CCC" stroke-width="1.2"/><path d="M7.5 8H14m-2 0v2.5m-2.5 0V8" stroke="CCC" stroke-width="1.2" stroke-linecap="round"/>',
    // sql: database cylinder
    sql: '<ellipse cx="8" cy="4" rx="5.5" ry="2.5" fill="CCC" fill-opacity=".15" stroke="CCC" stroke-width="1"/><path d="M2.5 4v8c0 1.4 2.5 2.5 5.5 2.5s5.5-1.1 5.5-2.5V4" fill="none" stroke="CCC" stroke-width="1"/><path d="M2.5 8c0 1.4 2.5 2.5 5.5 2.5s5.5-1.1 5.5-2.5" fill="none" stroke="CCC" stroke-width=".7" opacity=".5"/>',
};

// Map extensions/names → [shape, color]
const FILE_TYPES = {
    go: ['code', '#00ADD8'], mod: ['data', '#00ADD8'], sum: ['doc', '#00ADD8'],
    js: ['code', '#E8D44D'], mjs: ['code', '#E8D44D'], cjs: ['code', '#E8D44D'], jsx: ['markup', '#E8D44D'],
    ts: ['code', '#3178C6'], tsx: ['markup', '#3178C6'], mts: ['code', '#3178C6'],
    py: ['code', '#3572A5'], pyc: ['code', '#3572A5'],
    rb: ['code', '#CC342D'], rs: ['code', '#DEA584'], java: ['code', '#B07219'], swift: ['code', '#F05138'], kt: ['code', '#A97BFF'],
    c: ['code', '#555555'], h: ['code', '#555555'], cpp: ['code', '#F34B7D'], hpp: ['code', '#F34B7D'],
    html: ['markup', '#E44D26'], htm: ['markup', '#E44D26'],
    css: ['style', '#563D7C'], scss: ['style', '#C6538C'], less: ['style', '#1D365D'],
    json: ['data', '#F5C518'], jsonl: ['data', '#F5C518'],
    xml: ['markup', '#0060AC'], plist: ['markup', '#0060AC'],
    yml: ['config', '#CB171E'], yaml: ['config', '#CB171E'],
    toml: ['config', '#9C4221'], ini: ['config', '#9C4221'], cfg: ['config', '#9C4221'], conf: ['config', '#9C4221'],
    csv: ['doc', '#237346'], tsv: ['doc', '#237346'],
    sql: ['sql', '#E38C00'], db: ['sql', '#E38C00'],
    md: ['md', '#519ABA'], markdown: ['md', '#519ABA'], mdx: ['md', '#519ABA'],
    txt: ['doc', '#999999'],
    sh: ['shell', '#89E051'], bash: ['shell', '#89E051'], zsh: ['shell', '#89E051'],
    png: ['image', '#A074C4'], jpg: ['image', '#A074C4'], jpeg: ['image', '#A074C4'], gif: ['image', '#A074C4'], webp: ['image', '#A074C4'], ico: ['image', '#A074C4'],
    svg: ['image', '#FFB13B'],
    mp4: ['video', '#EE4444'], mov: ['video', '#EE4444'], webm: ['video', '#EE4444'],
    mp3: ['audio', '#E91E63'], wav: ['audio', '#E91E63'],
    pdf: ['pdf', '#DB1B1B'],
    env: ['env', '#ECD53F'], log: ['doc', '#999999'],
};
const SPECIAL_NAMES = {
    dockerfile: ['docker', '#384D54'], makefile: ['make', '#427819'], gnumakefile: ['make', '#427819'],
    license: ['license', '#DA5B0B'], licence: ['license', '#DA5B0B'], readme: ['md', '#519ABA'],
};

// A file named without an extension (an artifact saved without a suffix) takes its icon from its media type (#5314).
const MEDIA_EXT = { 'application/pdf': 'pdf', 'application/json': 'json', 'application/xml': 'xml', 'application/yaml': 'yml', 'application/x-yaml': 'yml', 'application/x-sh': 'sh', 'application/sql': 'sql',
    'application/javascript': 'js', 'text/javascript': 'js', 'text/markdown': 'md', 'text/x-markdown': 'md', 'text/html': 'html', 'text/css': 'css', 'text/csv': 'csv', 'text/plain': 'txt', 'text/xml': 'xml', 'image/svg+xml': 'svg' };
function mediaExt(mediaType) {
    const t = String(mediaType || '').split(';')[0].trim().toLowerCase();
    return MEDIA_EXT[t] || (t.startsWith('image/') ? 'png' : t.startsWith('video/') ? 'mp4' : t.startsWith('audio/') ? 'mp3' : t.startsWith('text/') ? 'txt' : '');
}

function getFileType(name, mediaType) {
    const lower = name.toLowerCase();
    const base = lower.replace(/\.[^.]*$/, '');
    if (SPECIAL_NAMES[base]) return SPECIAL_NAMES[base];
    if (lower.startsWith('.git')) return ['git', '#F05033'];
    if (lower.startsWith('.docker') || lower.startsWith('.compose')) return ['docker', '#384D54'];
    if (lower.startsWith('.eslint') || lower.startsWith('.prettier') || lower.startsWith('.editorconfig')) return ['config', '#4B32C3'];
    const ext = lower.includes('.') ? lower.split('.').pop() : '';
    if (FILE_TYPES[ext]) return FILE_TYPES[ext];
    return (!ext && FILE_TYPES[mediaExt(mediaType)]) || ['generic', '#8B8B8B'];
}

export function createFileIcon(name, isDir, isExpanded, mediaType) {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('width', '16');
    svg.setAttribute('height', '16');
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.classList.add('explorer-file-icon');
    svg.setAttribute('aria-hidden', 'true');
    if (isDir) {
        svg.innerHTML = isExpanded
            ? '<path d="M.5 3h5l1 1H14v1.5H6.5l-2.5 7H.5zm6 2.5H15l-2.5 7H4z" fill="#888"/>'
            : '<path d="M.5 3h5l1 1H14v9.5H.5z" fill="#888"/>';
    } else {
        const [shape, color] = getFileType(name, mediaType);
        svg.innerHTML = (ICON_SHAPES[shape] || ICON_SHAPES.generic).replace(/CCC/g, color);
    }
    return svg;
}

/** Markup for a file's type icon, shared with the changed-files list. */
export function fileIconHtml(name, mediaType) {
    return createFileIcon(name, false, false, mediaType).outerHTML;
}

