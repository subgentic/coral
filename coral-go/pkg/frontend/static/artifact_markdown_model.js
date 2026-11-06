// Rendered text editing. Keep original source bytes; the lexer is used for positions, never serialization.
// Variation selectors stay editable: Mongolian, emoji and CJK glyph selection is legitimate text.
export const HIDDEN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u0085\u00ad\u034f\u061c\u115f\u1160\u180e\u3164\ufff9-\ufffb\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u206f\ufeff\u{E0000}-\u{E007F}]/u;
// Keep visible markers on exactly the same code-point policy as refusal/warnings.
const ALL_HIDDEN = new RegExp(HIDDEN.source, 'gu');
export const MAX_BYTES = 2 * 1024 * 1024;
export function normalizeSource(source) {
    let text = ''; const offsets = []; let i = source.charCodeAt(0) === 0xfeff ? 1 : 0;
    while (i < source.length) { offsets.push(i); if (source[i] === '\r') { text += '\n'; i += source[i + 1] === '\n' ? 2 : 1; } else text += source[i++]; }
    offsets.push(source.length); return { text, offsets };
}
function inlineRuns(tokens, raw, base, out) {
    let cursor = 0;
    for (const token of tokens || []) {
        const at = raw.indexOf(token.raw, cursor); if (at < 0) return false;
        cursor = at + token.raw.length;
        if (token.type === 'image' || token.type === 'br') continue;
        if (token.tokens) { if (!inlineRuns(token.tokens, token.raw, base + at, out)) return false; continue; }
        if (token.type === 'codespan') {
            const m = /^(\x60+)([\s\S]*?)\1$/.exec(token.raw);
            if (!m) return false;
            out.push({ text: token.text, start: base + at + m[1].length, end: base + at + token.raw.length - m[1].length, editable: m[2] === token.text, kind: 'code' });
        } else {
            const text = token.type === 'html' ? token.raw : token.text;
            if (typeof text !== 'string') return false;
            out.push({ text, start: base + at, end: base + at + token.raw.length, editable: token.type === 'text' && token.raw === text, kind: 'text' });
        }
    }
    return true;
}
// Each logical character keeps its verified original position while container prefixes
// are removed. Only leading marker/indent bytes may disappear; prose is never searched past.
function itemView(raw, text, positions) {
    const lines = raw.split('\n'), wanted = text.split('\n'), out = []; let offset = 0;
    if (wanted.length > lines.length) return null;
    for (let i = 0; i < wanted.length; i++) {
        const line = lines[i], content = wanted[i], cut = line.length - content.length;
        if (cut < 0 || line.slice(cut) !== content) return null;
        const prefix = line.slice(0, cut);
        if (i === 0 ? !/^ {0,3}(?:[-+*]|\d{1,9}[.)])[ \t]+(?:\[[ xX]\][ \t]*)?$/.test(prefix) : !/^[ \t]*$/.test(prefix)) return null;
        for (let j = 0; j < content.length; j++) out.push(positions[offset + cut + j]);
        if (i < wanted.length - 1) out.push(positions[offset + line.length]);
        if (i === wanted.length - 1) out.push(positions[offset + line.length]);
        offset += line.length + 1;
    }
    if (lines.slice(wanted.length).some(line => line.trim())) return null;
    return { text, positions: out };
}
function listRuns(token, view, runs, units, source) {
    let cursor = 0;
    for (const item of token.items) {
        const at = view.text.indexOf(item.raw, cursor); if (at < 0 || view.text.slice(cursor, at).trim()) return false;
        cursor = at + item.raw.length;
        const content = itemView(item.raw, item.text, view.positions.slice(at, at + item.raw.length + 1)); if (!content) return false;
        const lineStart = source.lastIndexOf('\n', content.positions[0] - 1) + 1;
        const prefix = source.slice(lineStart, content.positions[0]).replace(/(?:[-+*]|\d{1,9}[.)])[ \t]+(?:\[[ xX]\][ \t]*)?$/, marker => ' '.repeat(marker.replace(/\[[ xX]\][ \t]*$/,'').length));
        const first = runs.length; let inner = 0;
        for (const child of item.tokens) {
            // Marked text.raw can duplicate a continuation newline; text is the verified item-content spelling.
            const childRaw = child.type === 'text' ? child.text : child.raw;
            const where = content.text.indexOf(childRaw, inner); if (where < 0 || content.text.slice(inner, where).trim()) return false;
            inner = where + childRaw.length;
            if (child.type === 'space') continue;
            if (child.type === 'list') {
                if (!listRuns(child, { text: child.raw, positions: content.positions.slice(where, inner + 1) }, runs, units, source)) return false;
            } else if (['text','paragraph'].includes(child.type)) {
                const local = []; if (!inlineRuns(child.tokens, childRaw, where, local)) return false;
                if (!local.length && child.text) return false;
                for (const run of local) {
                    const pos = content.positions.slice(run.start, run.end + 1);
                    runs.push({ ...run, start: pos[0], end: pos[pos.length - 1], sourceOffsets: pos, newlinePrefix: run.kind === 'text' ? prefix : null });
                }
            } else return false;
        }
        units.push({ start: view.positions[at], end: view.positions[cursor], first, count: runs.length - first });
    }
    return true;
}
// GFM table separators are unescaped pipes. The only cell-text transform made
// here is the lexer's escaped-pipe transform, recorded for exact source validation.
function tableRuns(token, view, runs, units) {
    const lines = view.text.split('\n'), rows = [token.header, ...token.rows]; let lineStart = 0;
    for (let lineIndex = 0, rowIndex = 0; lineIndex < lines.length; lineStart += lines[lineIndex++].length + 1) {
        const line = lines[lineIndex]; if (lineIndex === 1) continue;
        if (rowIndex >= rows.length) { if (line.trim()) return false; continue; }
        const boundaries = [-1]; let slashes = 0;
        for (let i = 0; i < line.length; i++) {
            if (line[i] === '|' && slashes % 2 === 0) boundaries.push(i);
            slashes = line[i] === '\\' ? slashes + 1 : 0;
        }
        boundaries.push(line.length);
        let cells = boundaries.slice(0,-1).map((left,i)=>({from:left+1,to:boundaries[i+1]}));
        if (cells.length && !line.slice(cells[0].from,cells[0].to).trim() && boundaries[1] < line.length) cells.shift();
        if (cells.length && !line.slice(cells.at(-1).from,cells.at(-1).to).trim() && boundaries.at(-2) >= 0) cells.pop();
        const expected = rows[rowIndex++]; if (cells.length !== expected.length) return false;
        for (let i = 0; i < cells.length; i++) {
            let {from,to} = cells[i]; while(from<to && /[ \t]/.test(line[from]))from++;while(to>from && /[ \t]/.test(line[to-1]))to--;
            let text = ''; const positions = [], escapes = {};
            for (let j=from;j<to;j++) {
                positions.push(view.positions[lineStart+j]);
                if(line[j] === '\\' && line[j+1] === '|') {escapes[text.length]='\\|';text+='|';j++;} else text+=line[j];
            }
            positions.push(view.positions[lineStart+to]);
            if(text !== expected[i].text) return false;
            const local = []; if(!inlineRuns(expected[i].tokens,text,0,local))return false;
            const first = runs.length;
            for(const run of local) {
                const pos=positions.slice(run.start,run.end+1), sourceEscapes={};
                for(const [where,value] of Object.entries(escapes))if(Number(where)>=run.start&&Number(where)<run.end)sourceEscapes[Number(where)-run.start]=value;
                runs.push({...run,start:pos[0],end:pos.at(-1),sourceOffsets:pos,sourceEscapes,tableCell:true});
            }
            units.push({start:view.positions[lineStart+from],end:view.positions[lineStart+to],first,count:runs.length-first});
        }
    }
    return true;
}
function quoteRuns(token, view, runs, units, source) {
    const lines=view.text.split('\n'), wanted=token.text.split('\n'), positions=[];let offset=0;
    if(wanted.length>lines.length)return false;
    for(let i=0;i<wanted.length;i++) {
        const cut=lines[i].length-wanted[i].length,prefix=lines[i].slice(0,cut);
        if(cut<0 || lines[i].slice(cut)!==wanted[i] || (prefix && !/^ {0,3}>[ \t]?$/.test(prefix)))return false;
        for(let j=0;j<wanted[i].length;j++)positions.push(view.positions[offset+cut+j]);
        positions.push(view.positions[offset+lines[i].length]);offset+=lines[i].length+1;
    }
    if(lines.slice(wanted.length).some(line=>line.trim()))return false;
    const content={text:token.text,positions};let cursor=0;
    for(const child of token.tokens) {
        const at=content.text.indexOf(child.raw,cursor);if(at<0 || content.text.slice(cursor,at).trim())return false;cursor=at+child.raw.length;
        if(child.type==='space')continue;
        if(child.type==='blockquote') {if(!quoteRuns(child,{text:child.raw,positions:positions.slice(at,cursor+1)},runs,units,source))return false;continue;}
        if(!['paragraph','heading'].includes(child.type))return false;
        const local=[];if(!inlineRuns(child.tokens,child.raw,at,local))return false;
        const first=runs.length;
        for(const run of local) {
            const pos=positions.slice(run.start,run.end+1),lineStart=source.lastIndexOf('\n',positions[at]-1)+1;
            const prefix=source.slice(lineStart,positions[at]);
            runs.push({...run,start:pos[0],end:pos.at(-1),sourceOffsets:pos,newlinePrefix:child.type==='paragraph'&&run.kind==='text'?prefix:null});
        }
        units.push({start:positions[at],end:positions[cursor],first,count:runs.length-first});
    }
    return true;
}
// Fences and language metadata remain source-only. Map only an exact body;
// indented or unterminated blocks stay read-only until their bytes can be proven.
function codeRuns(token, raw, start, runs) {
    const open = /^( {0,3})(`{3,}|~{3,})[^\n]*\n/.exec(raw);
    if (!open || open[1]) return false;
    const lines = raw.slice(open[0].length).split('\n');
    let close = lines.length - 1; if (!lines[close]) close--;
    const ending = /^( {0,3})(`+|~+)[ \t]*$/.exec(lines[close] || '');
    if (!ending || ending[2][0] !== open[2][0] || ending[2].length < open[2].length) return false;
    const body = lines.slice(0,close).join('\n');
    if (!body || body !== token.text) return false;
    runs.push({text:body,start:start+open[0].length,end:start+open[0].length+body.length,editable:true,kind:'blockcode',newlinePrefix:''});
    return true;
}
export function analyze(source, marked) {
    if (new TextEncoder().encode(source).length > MAX_BYTES) throw new Error('Markdown editing is limited to 2 MiB.');
    const { text, offsets } = normalizeSource(source); const blocks = []; let offset = 0;
    const front = /^---\n[\s\S]*?\n(?:---|\.\.\.)(?:\n|$)/.exec(text);
    const add = (raw, start, type, tokens = null) => {
        const countItems = t => (t.items || []).reduce((n, item) => n + 1 + (item.tokens || []).filter(x => x.type === 'list').reduce((sum, x) => sum + countItems(x), 0), 0);
        const block = { unitCount: ['paragraph', 'heading'].includes(type) ? 1 : type === 'list' ? countItems(tokens) : 0, type, raw, start: offsets[start], end: offsets[start + raw.length], runs: [], units: [], reason: '' };
        if (HIDDEN.test(raw)) block.reason = 'Hidden or bidirectional characters';
        else if (type === 'paragraph' || type === 'heading') {
            if (!inlineRuns(tokens.tokens, raw, start, block.runs)) block.reason = 'Text does not map exactly';
            block.units.push({ start, end: start + raw.length, first: 0, count: block.runs.length });
        } else if (type === 'blockquote') { if (!quoteRuns(tokens,{text:raw,positions:Array.from({length:raw.length+1},(_,i)=>start+i)},block.runs,block.units,text)) block.reason='Quote text does not map exactly'; }
        else if (type === 'code') { if (!codeRuns(tokens, raw, start, block.runs)) block.reason = 'Code body does not map exactly'; }
        else if (type === 'table') { if (!tableRuns(tokens, {text:raw,positions:Array.from({length:raw.length+1},(_,i)=>start+i)}, block.runs, block.units)) block.reason = 'Table cells do not map exactly'; }
        else if (type === 'list') { if (!listRuns(tokens, { text: raw, positions: Array.from({length:raw.length+1},(_,i)=>start+i) }, block.runs, block.units, text)) block.reason = 'Nested or indented list'; }
        else block.reason = ({ table: 'Table', code: 'Code block', html: 'Raw HTML', frontmatter: 'Front matter', definition: 'Reference definition', blockquote: 'Quoted block', hr: 'Divider' })[type] || 'Unsupported block';
        if (block.reason) block.runs = [];
        block.runs = block.runs.map(run => ({ ...run, start: offsets[run.start], end: offsets[run.end], ...(run.sourceOffsets ? {sourceOffsets:run.sourceOffsets.map(i=>offsets[i])} : {}) }));
        blocks.push(block);
    };
    if (front) { add(front[0], 0, 'frontmatter'); offset = front[0].length; }
    const lexer = new marked.Lexer({ gfm: true }), tokens = lexer.lex(text.slice(offset)); let cursor = offset;
    for (const token of tokens) {
        if (token.type === 'space') continue;
        // Marked omits reference definitions from its token array. Consume their exact
        // raw ranges before searching: a URL may repeat the next paragraph's words.
        for (;;) {
            const remaining = text.slice(cursor), blank = /^(?:[ \t]*\n)*/.exec(remaining)[0];
            const definition = lexer.tokenizer.def(remaining.slice(blank.length));
            if (!definition) break;
            const raw = blank + definition.raw; add(raw, cursor, 'definition'); cursor += raw.length;
        }
        const at = text.indexOf(token.raw, cursor);
        if (at < 0 || text.slice(cursor, at).trim()) throw new Error('Lexer source positions could not be verified; this document stays read-only.');
        add(token.raw, at, token.type, token); cursor = at + token.raw.length;
    }
    if (cursor < text.length && text.slice(cursor).trim()) add(text.slice(cursor), cursor, 'definition');
    // Definitions only affect rendering context; source is never rebuilt from this context.
    const references = Object.entries(tokens.links || {}).map(([key, link]) => `[${key}]: <${String(link.href).replace(/>/g, '%3E')}>${link.title ? ' '+ JSON.stringify(link.title) : ''}`).join('\n');
    return { source, blocks, references, bom: source.charCodeAt(0) === 0xfeff };
}
export function mapRenderedBlock(block, element) {
    const nodes = []; const walker = document.createTreeWalker(element, 4);
    while (walker.nextNode()) {
        const node = walker.currentNode;
        if (block.type === 'code' ? node.parentElement.closest('pre code') : node.parentElement.closest('p,h1,h2,h3,h4,h5,h6,li,td,th') && !node.parentElement.closest('pre')) nodes.push(node);
    }
    const planned = new Map(); let index = 0, at = 0;
    for (const run of block.runs) {
        if (!run.text) return {exact:false,entries:[]};
        for (;;) {
            const node = nodes[index]; if (!node) return {exact:false,entries:[]};
            let rest = node.data.slice(at);
            if (!rest.startsWith(run.text)) { const leading = /^\s*/.exec(rest)[0]; if (leading && rest.slice(leading.length).startsWith(run.text)) { at += leading.length; rest = node.data.slice(at); } }
            if (rest.startsWith(run.text)) { if (!planned.has(node)) planned.set(node,[]); planned.get(node).push({node,start:at,end:at+run.text.length,run}); at += run.text.length; break; }
            if (!rest.trim()) { index++; at = 0; continue; }
            return {exact:false,entries:[]};
        }
    }
    if (nodes.slice(index).some((node,i)=>node.data.slice(i===0?at:0).trim())) return {exact:false,entries:[]};
    // Split only after the complete mapping is verified, leaving renderer whitespace intact.
    const entries = [];
    for (const node of nodes) {
        const parts = planned.get(node) || []; if (!parts.length) continue;
        const fragment = document.createDocumentFragment(); let cursor = 0;
        for (const part of parts) {
            if (part.start > cursor) fragment.append(document.createTextNode(node.data.slice(cursor,part.start)));
            const text = document.createTextNode(node.data.slice(part.start,part.end)); fragment.append(text); entries.push({node:text,run:part.run}); cursor = part.end;
        }
        if (cursor < node.data.length) fragment.append(document.createTextNode(node.data.slice(cursor)));
        node.replaceWith(fragment);
    }
    return {exact:true,entries};
}
const escapeInserted = s => s.replace(/[\\\x60*_[\]<>~!|#()+.\-]/g, '\\$&');
export function editRun(source, run, text) {
    const original = normalizeSource(source.slice(run.start, run.end));
    const mapped = run.sourceOffsets ? run.text.split('').every((c,i)=>(run.sourceEscapes?.[i] ? source.slice(run.sourceOffsets[i],run.sourceOffsets[i]+run.sourceEscapes[i].length)===run.sourceEscapes[i] : (source[run.sourceOffsets[i]]==='\r'?'\n':source[run.sourceOffsets[i]])===c)) : original.text === run.text;
    if (!run.editable || !mapped) throw new Error('This text cannot be changed without affecting its Markdown.');
    if (HIDDEN.test(text)) throw new Error('Hidden and bidirectional characters cannot be inserted here.');
    // Work in Unicode code points so an emoji is never split between surrogate halves.
    const before = Array.from(run.text), after = Array.from(text); let a = 0, b = 0;
    while (a < before.length && a < after.length && before[a] === after[a]) a++;
    while (b < before.length - a && b < after.length - a && before[before.length - 1 - b] === after[after.length - 1 - b]) b++;
    const removed = before.slice(a, before.length - b).join(''), inserted = after.slice(a, after.length - b).join('');
    if (/[\r\n]/.test(removed + inserted) && run.newlinePrefix == null) throw new Error('Edit words within one text run; changing line breaks is not supported.');
    if (run.kind === 'code' && /\x60/.test(inserted)) throw new Error('A code-span delimiter cannot be edited.');
    if (run.kind === 'blockcode' && text.split(/\r?\n/).some(line => { const fence = /^ {0,3}(`+|~+)/.exec(line); return fence && fence[1].length >= 3; })) throw new Error('A closing code fence cannot be inserted.');
    if (run.kind === 'code' && run.tableCell && /\\\|/.test(text)) throw new Error('A backslash before a pipe cannot be inserted into a table code span.');
    const positions = run.sourceOffsets || original.offsets.map(i=>run.start+i);
    const start = positions[before.slice(0, a).join('').length], end = positions[run.text.length - before.slice(before.length - b).join('').length];
    let replacement = run.kind === 'blockcode' ? inserted : run.kind === 'code' ? (run.tableCell ? inserted.replace(/\|/g,'\\|') : inserted) : escapeInserted(inserted);
    if (run.newlinePrefix != null) replacement = replacement.replace(/\r?\n/g, (source.includes('\r\n')?'\r\n':'\n') + run.newlinePrefix);
    return { source: source.slice(0, start) + replacement + source.slice(end), patch: { start, end, removed: source.slice(start, end), inserted: replacement } };
}

/** Visible names for invisible characters; the source itself is never changed. */
export function visibleSpecials(text) {
    return String(text).replace(ALL_HIDDEN, c => `⟦U+${c.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}⟧`);
}

// A textarea normalizes line endings. Splice only its changed logical range back
// into the original bytes, keeping the BOM and all untouched mixed endings.
export function editRaw(source, value) {
    const {text,offsets}=normalizeSource(source), before=Array.from(text), after=Array.from(value.replace(/\r\n?/g,'\n'));let a=0,b=0;
    while(a<before.length&&a<after.length&&before[a]===after[a])a++;
    while(b<before.length-a&&b<after.length-a&&before.at(-1-b)===after.at(-1-b))b++;
    const start=offsets[before.slice(0,a).join('').length],end=offsets[text.length-before.slice(before.length-b).join('').length];
    const inserted=after.slice(a,after.length-b).join('').replace(/\n/g,source.includes('\r\n')?'\r\n':'\n');
    return source.slice(0,start)+inserted+source.slice(end);
}
