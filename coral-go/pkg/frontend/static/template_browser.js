/* Template Browser — browse and import agent/command templates from aitmpl.com */

import { escapeHtml, escapeAttr, showToast } from './utils.js';
import { registerActions } from './actions.js';
import { registerDialog, closeDialog } from './modal_chrome.js';
import { importOnce } from './import_once.js';

let _categoriesCache = {};

async function fetchCategories(type) {
    if (_categoriesCache[type]) return _categoriesCache[type];
    try {
        const resp = await fetch(`/api/templates/${type}`);
        const data = await resp.json();
        _categoriesCache[type] = data;
        return data;
    } catch (e) {
        showToast('Failed to load template categories', true);
        return [];
    }
}

async function fetchTemplatesInCategory(type, category) {
    try {
        const resp = await fetch(`/api/templates/${type}/${encodeURIComponent(category)}`);
        return await resp.json();
    } catch (e) {
        showToast('Failed to load templates', true);
        return [];
    }
}

async function fetchTemplate(type, category, name) {
    try {
        const resp = await fetch(`/api/templates/${type}/${encodeURIComponent(category)}/${encodeURIComponent(name)}`);
        return await resp.json();
    } catch (e) {
        showToast('Failed to load template', true);
        return null;
    }
}

/**
 * Show the template browser modal.
 * @param {'agents'|'commands'} type
 * @param {function} onSelect — called with the full template object when user clicks Use/Add
 */
export async function showTemplateBrowser(type, onSelect) {
    // Loaded here, not at the top of the file: a top-level await would hold this module (and whatever imports it) until the data module has answered.
    const { categoriesOf, templatesOf, categoryName, filterCategories, filterTemplates, templateName, displayName, previewParts } = await importOnce('./template_browser_data.js');
    const existing = document.getElementById('template-browser-modal');
    if (existing) existing.remove();

    const modal = document.createElement('div');
    modal.id = 'template-browser-modal';
    modal.className = 'modal';
    modal.style.display = 'flex';
    modal.innerHTML = `
        <div class="modal-content template-browser">
            <div class="template-browser-header">
                <h3>${type === 'agents' ? 'Agent Templates' : 'Command Templates'}</h3>
                <input type="text" class="template-browser-search" placeholder="Filter templates...">
                <button class="btn template-browser-close" data-on-click="template-browser-close">&times;</button>
            </div>
            <div style="font-size:var(--fs-sm);color:var(--text-muted);padding:4px 0 8px">
                Templates from <a href="https://www.aitmpl.com/${type === 'agents' ? 'agents' : 'commands'}" target="_blank" rel="noopener" style="color:var(--accent)">aitmpl.com</a>
            </div>
            <div class="template-browser-body">
                <div class="template-browser-categories">
                    <div class="template-browser-loading">Loading...</div>
                </div>
                <div class="template-browser-list">
                    <div class="template-browser-empty">Select a category</div>
                </div>
                <div class="template-browser-preview">
                    <div class="template-browser-empty">Select a template to preview</div>
                </div>
            </div>
        </div>
    `;
    document.body.appendChild(modal);
    const close = registerDialog(modal); // Escape and a click on the backdrop close it, and focus goes back to the opener

    const catPanel = modal.querySelector('.template-browser-categories');
    const listPanel = modal.querySelector('.template-browser-list');
    const previewPanel = modal.querySelector('.template-browser-preview');
    const searchInput = modal.querySelector('.template-browser-search');

    // Load categories
    const rawData = await fetchCategories(type);
    const categories = categoriesOf(rawData);
    if (!categories.length) {
        catPanel.innerHTML = '<div class="template-browser-empty">No categories found</div>';
        return;
    }

    let allTemplates = []; // flat list for search
    let activeCategory = null;

    function renderCategories(filter) {
        const filtered = filterCategories(categories, filter);
        catPanel.innerHTML = filtered.map(c => {
            const name = categoryName(c);
            const display = displayName(name);
            const active = activeCategory === name ? ' active' : '';
            return `<button class="template-cat-btn${active}" data-cat="${escapeAttr(name)}">${escapeHtml(display)}</button>`;
        }).join('') || '<div class="template-browser-empty">No matches</div>';

        catPanel.querySelectorAll('.template-cat-btn').forEach(btn => {
            btn.addEventListener('click', () => selectCategory(btn.dataset.cat));
        });
    }

    async function selectCategory(catName) {
        activeCategory = catName;
        renderCategories(searchInput.value);
        listPanel.innerHTML = '<div class="template-browser-loading">Loading...</div>';
        previewPanel.innerHTML = '<div class="template-browser-empty">Select a template to preview</div>';

        const rawTemplates = await fetchTemplatesInCategory(type, catName);
        const templates = templatesOf(rawTemplates);
        renderTemplateList(templates);
    }

    function renderTemplateList(templates, filter) {
        const filtered = filterTemplates(templates, filter);
        if (!filtered.length) {
            listPanel.innerHTML = '<div class="template-browser-empty">No templates found</div>';
            return;
        }
        listPanel.innerHTML = filtered.map(t => {
            const name = templateName(t);
            const display = displayName(name);
            return `<button class="template-item-btn" data-cat="${escapeAttr(activeCategory)}" data-name="${escapeAttr(name)}">${escapeHtml(display)}</button>`;
        }).join('');

        listPanel.querySelectorAll('.template-item-btn').forEach(btn => {
            btn.addEventListener('click', () => selectTemplate(btn.dataset.cat, btn.dataset.name));
        });

        // Store for search filtering
        allTemplates = templates;
    }

    async function selectTemplate(cat, name) {
        previewPanel.innerHTML = '<div class="template-browser-loading">Loading...</div>';
        const template = await fetchTemplate(type, cat, name);
        if (!template) {
            previewPanel.innerHTML = '<div class="template-browser-empty">Failed to load template</div>';
            return;
        }

        const { displayName: shownName, desc, body: truncBody, meta, btnLabel } = previewParts(template, name, type);

        previewPanel.innerHTML = `
            <div class="template-preview-name">${escapeHtml(shownName)}</div>
            ${desc ? `<div class="template-preview-desc">${escapeHtml(desc)}</div>` : ''}
            ${meta.length ? `<div class="template-preview-meta">${meta.map(m => escapeHtml(m)).join(' &middot; ')}</div>` : ''}
            <div class="template-preview-body"><pre>${escapeHtml(truncBody)}</pre></div>
            <button class="btn btn-primary template-use-btn">${btnLabel}</button>
        `;

        previewPanel.querySelector('.template-use-btn').addEventListener('click', () => {
            close();
            onSelect(template);
        });
    }

    // Search filtering
    searchInput.addEventListener('input', () => {
        const q = searchInput.value.trim();
        renderCategories(q);
        if (allTemplates.length) renderTemplateList(allTemplates, q);
    });

    renderCategories();
}

// The template browser's ×: it removes its dialog (#3645).
registerActions({
    'template-browser-close': el => closeDialog(el.closest('.modal')),
});
