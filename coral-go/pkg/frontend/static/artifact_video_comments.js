// Loaded only when the comment subject contains a video. All times stay numeric.
import { el } from './dom_el.js';
import { loadStyles } from './lazy_styles.js';
await loadStyles('artifact-video-comments.css');

export function videoTime(value) {
    const n = Math.round(Math.max(0, Number(value) || 0));
    return `${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`;
}

export function attachVideoComments(video, { onComment, onActivate }) {
    const root = video.parentElement;
    const abort = new AbortController(), signal = abort.signal;
    const box = el('section', 'avc-controls'); box.setAttribute('aria-label', 'Video review');
    const row = el('div', 'avc-row');
    const play = el('button', 'btn avc-play', 'Play'); play.type = 'button';
    const clock = el('span', 'avc-clock');
    const comment = el('button', 'btn btn-primary avc-comment', 'Comment here'); comment.type = 'button';
    row.append(play, clock, comment);
    const track = el('div', 'avc-track'); track.tabIndex = 0; track.setAttribute('role', 'slider'); track.setAttribute('aria-label', 'Video timeline'); track.setAttribute('aria-valuemin', '0');
    const selected = el('div', 'avc-selection'), head = el('div', 'avc-head');
    const marks = el('div', 'avc-marks');
    track.append(selected, head); // dot buttons are siblings of the slider, not nested inside its accessible role
    const rail = el('div', 'avc-rail'); rail.append(track, marks);
    const hint = el('p', 'avc-hint', 'Drag to select a stretch. Space: play/pause · C: comment · arrows: seek 5 seconds.');
    const status = el('p', 'avc-status'); status.setAttribute('role', 'status');
    box.append(row, rail, hint, status); video.after(box);
    let range = null, drag = null, comments = [], writable = false, playError = '';
    const duration = () => Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 0;
    const clamp = n => Math.min(duration(), Math.max(0, n));
    const seek = n => { if (duration()) video.currentTime = clamp(n); sync(); };
    function sync() {
        const dur = duration(), now = Math.max(0, video.currentTime || 0);
        play.textContent = video.paused ? 'Play' : 'Pause';
        play.setAttribute('aria-label', video.paused ? 'Play video' : 'Pause video');
        clock.textContent = `${videoTime(now)} / ${dur ? videoTime(dur) : '—'}`;
        track.setAttribute('aria-valuemax', String(dur)); track.setAttribute('aria-valuenow', String(now)); track.setAttribute('aria-valuetext', videoTime(now)); track.setAttribute('aria-disabled', String(!dur));
        head.style.left = `${dur ? now / dur * 100 : 0}%`;
        selected.hidden = !range;
        if (range && dur) { selected.style.left = `${range.atS / dur * 100}%`; selected.style.width = `${(range.endS - range.atS) / dur * 100}%`; }
        comment.hidden = !writable; comment.disabled = !dur;
        hint.textContent = writable ? 'Drag to select a stretch. Space: play/pause · C: comment · arrows: seek 5 seconds.' : 'Space: play/pause · arrows: seek 5 seconds. Select a comment marker to seek.';
        comment.textContent = range ? `Comment ${videoTime(range.atS)}–${videoTime(range.endS)}` : `Comment at ${videoTime(now)}`;
        status.textContent = playError || (range ? `Selected ${videoTime(range.atS)} to ${videoTime(range.endS)}. Use Comment to review this stretch.` : '');
    }
    async function togglePlay() {
        playError = '';
        try { if (video.paused) await video.play(); else video.pause(); }
        catch (error) { if (error?.name !== 'AbortError') playError = 'This video could not be played. Try its Download link.'; }
        sync();
    }
    const compose = () => { if (!writable || !duration()) return; video.pause(); onComment(range || { atS: Math.min(604800, video.currentTime || 0) }); };
    play.addEventListener('click', togglePlay, { signal });
    comment.addEventListener('click', compose, { signal });
    const point = e => { const r = track.getBoundingClientRect(); return clamp((e.clientX - r.left) / r.width * duration()); };
    track.addEventListener('pointerdown', e => { if (e.button !== 0 || !duration()) return; e.preventDefault(); track.focus(); drag = { at: point(e), x: e.clientX }; range = null; track.setPointerCapture(e.pointerId); seek(drag.at); }, { signal });
    track.addEventListener('pointermove', e => { if (!drag) return; const end = point(e); if (Math.abs(e.clientX - drag.x) > 4 && writable) { const atS = Math.min(drag.at, end), endS = Math.max(drag.at, end); range = endS > atS && endS <= 604800 ? { atS, endS } : null; sync(); } }, { signal });
    track.addEventListener('pointerup', e => { if (!drag) return; if (!range) seek(point(e)); drag = null; if (track.hasPointerCapture(e.pointerId)) track.releasePointerCapture(e.pointerId); sync(); }, { signal });
    track.addEventListener('pointercancel', () => { drag = null; range = null; sync(); }, { signal });
    root.addEventListener('keydown', e => {
        if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || e.target.closest('input, textarea, button, a, [contenteditable="true"]')) return;
        if (e.key === ' ') { e.preventDefault(); togglePlay(); }
        else if (e.key.toLowerCase() === 'c' && writable) { e.preventDefault(); compose(); }
        else if (e.target === track && ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) { e.preventDefault(); range = null; seek(e.key === 'Home' ? 0 : e.key === 'End' ? duration() : video.currentTime + (e.key === 'ArrowRight' ? 5 : -5)); }
        else if (e.key === 'Escape' && range) { e.preventDefault(); e.stopPropagation(); range = null; sync(); }
    }, { signal });
    for (const name of ['timeupdate', 'play', 'pause', 'loadedmetadata', 'durationchange', 'seeked']) video.addEventListener(name, sync, { signal });
    const draw = active => {
        const focused = marks.contains(document.activeElement) ? document.activeElement.dataset.id : null;
        marks.replaceChildren();
        for (const c of comments) {
            const dot = el('button', `avc-dot${c.resolved ? ' avc-resolved' : ''}${c.id === active ? ' avc-active' : ''}`);
            dot.type = 'button'; dot.dataset.id = String(c.id);
            const label = `${videoTime(c.atS)}${c.endS != null ? '–' + videoTime(c.endS) : ''}: ${c.body}${c.resolved ? ' (resolved)' : ''}${c.fromVersion != null ? ' (earlier version)' : ''}`;
            dot.setAttribute('aria-label', label); dot.title = label;
            dot.style.left = `${duration() ? Math.min(100, c.atS / duration() * 100) : 0}%`;
            dot.addEventListener('click', () => { range = null; seek(c.atS); onActivate(c.id); });
            marks.append(dot);
            if (focused === String(c.id)) dot.focus({ preventScroll: true });
        }
    };
    let active = null;
    video.addEventListener('loadedmetadata', () => draw(active), { signal });
    video.addEventListener('durationchange', () => draw(active), { signal });
    sync();
    return {
        update(list, id, canWrite) { comments = list.filter(c => !c.deleted && c.parentId == null && Number.isFinite(c.atS)); active = id; writable = canWrite; draw(active); sync(); },
        seek,
        current: () => range || { atS: Math.min(604800, video.currentTime || 0) },
        close() { abort.abort(); video.pause(); box.remove(); },
    };
}
