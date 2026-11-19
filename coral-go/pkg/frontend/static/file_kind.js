/* What kind of file a name and a media type say it is, for a tile (#19828, shared with the Inbox list's kind icon, #19824). One place, so the Activity ledger and Needs you draw the same file the same way. It reads only the
 * name and the type the record holds; it never opens the file. The icons are ones the font subset already holds (a new icon needs the subset rebuilt); a kind with no icon of its own has a short text glyph instead. */
const BY_EXT = {
    html: 'html', htm: 'html',
    md: 'markdown', markdown: 'markdown', mdx: 'markdown',
    js: 'code', mjs: 'code', ts: 'code', tsx: 'code', jsx: 'code', go: 'code', py: 'code', rs: 'code', java: 'code', c: 'code', h: 'code', cpp: 'code', css: 'code', json: 'code', yaml: 'code', yml: 'code', toml: 'code', sh: 'code', sql: 'code', xml: 'code', diff: 'code', patch: 'code',
    mp4: 'video', mov: 'video', webm: 'video', mkv: 'video', avi: 'video', m4v: 'video',
    png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image', svg: 'image', bmp: 'image', heic: 'image', avif: 'image',
    mp3: 'audio', wav: 'audio', m4a: 'audio', ogg: 'audio', flac: 'audio',
    pdf: 'pdf', doc: 'pdf', docx: 'pdf', rtf: 'pdf', odt: 'pdf',
    csv: 'sheet', tsv: 'sheet', xls: 'sheet', xlsx: 'sheet', ods: 'sheet',
    zip: 'archive', tar: 'archive', gz: 'archive', tgz: 'archive', '7z': 'archive', rar: 'archive',
};
export const FILE_KINDS = {
    html: { icon: 'html' },
    markdown: { glyph: 'M↓' },
    code: { icon: 'code' },
    video: { icon: 'play_arrow' },
    image: { icon: 'image' },
    audio: { icon: 'play_arrow' },
    pdf: { icon: 'description' },
    sheet: { icon: 'dataset' },
    archive: { icon: 'archive' },
    file: { icon: 'description' },
};
/** {kind, icon?, glyph?} of a file: by its extension first (a name says more than a generic type), then by its media type, else a plain file. */
export function fileKindOf(name, mediaType) {
    const ext = /\.([a-z0-9]+)$/i.exec(String(name || ''))?.[1]?.toLowerCase();
    let kind = ext && Object.hasOwn(BY_EXT, ext) ? BY_EXT[ext] : null;
    if (!kind) {
        const t = String(mediaType || '').toLowerCase();
        kind = t.startsWith('video/') ? 'video' : t.startsWith('image/') ? 'image' : t.startsWith('audio/') ? 'audio' : t === 'application/pdf' ? 'pdf' : t === 'text/html' ? 'html' : t === 'text/markdown' ? 'markdown' : /json|xml|javascript|x-sh/.test(t) ? 'code' : /zip|tar|gzip/.test(t) ? 'archive' : 'file';
    }
    return { kind, ...FILE_KINDS[kind] };
}
