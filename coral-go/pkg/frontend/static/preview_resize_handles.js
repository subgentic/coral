/* Drag and keyboard resize controls, loaded when a preview is first shown. */
import { makeDraggable } from './draggable.js';
import { fitTerminal } from './xterm_renderer.js';
export function initResizeHandles({ saveHeight, saveWidth, minWidth, maxWidth, clampWidth, syncHandle, applyWidth }) {
    const handle = document.getElementById('preview-pane-resize-handle');
    if (!handle) return;
    makeDraggable(handle, {
        cursor: 'row-resize',
        onMove: (e) => {
            const container = document.getElementById('agentic-state');
            if (!container) return null;
            const rect = container.getBoundingClientRect();
            const newHeight = rect.bottom - e.clientY;
            const min = 100;
            const max = rect.height * 0.7;
            return Math.min(Math.max(newHeight, min), max);
        },
        onFlush: (v) => {
            const pane = document.getElementById('preview-pane');
            if (pane) pane.style.height = v + 'px';
        },
        onEnd: (v) => {
            if (v != null) {
                saveHeight(Math.round(v));
            }
        },
    });

    const colHandle = document.getElementById('preview-column-resize-handle');
    const column = document.getElementById('preview-column');
    const liveBody = document.querySelector('.live-body');
    if (colHandle && column && liveBody) {
        makeDraggable(colHandle, {
            cursor: 'col-resize',
            onMove: (e) => {
                // The room is .live-body's: the side panel is outside it (it was taken off again here, so the limit fell to the minimum and the pane could only be dragged narrower, #4931).
                return Math.min(Math.max(column.getBoundingClientRect().right - e.clientX, minWidth), maxWidth());
            },
            onFlush: (v) => { column.style.width = v + 'px'; syncHandle(v); },
            onEnd: (v) => {
                if (v != null) saveWidth(Math.round(v));
            },
        });
        // The handle by keyboard (a separator with a value): Left widens, Right narrows, Home and End go to the ends; kept where the window has room.
        colHandle.addEventListener('keydown', (e) => {
            const step = e.shiftKey ? 96 : 24;
            const now = column.getBoundingClientRect().width;
            const next = e.key === 'ArrowLeft' ? now + step : e.key === 'ArrowRight' ? now - step : e.key === 'Home' ? minWidth : e.key === 'End' ? maxWidth() : null;
            if (next === null) return;
            e.preventDefault();
            saveWidth(clampWidth(next));
            applyWidth();
            fitTerminal();
        });
    }
}
