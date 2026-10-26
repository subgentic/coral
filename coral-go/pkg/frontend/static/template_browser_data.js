/* The pure parts of the template browser (moved out of template_browser.js, #8413): what the aitmpl.com answers hold, which entries a filter keeps, the names a row shows and the words of a template's preview. Node-tested. */

/** The categories of the answer: the list itself or the one under `categories` or `commands`. */
export const categoriesOf = raw => raw.categories || raw.commands || raw || [];

/** The templates of a category's answer: the list itself or the one under `agents` or `commands`. */
export const templatesOf = raw => raw.agents || raw.commands || raw || [];

/** A category is a name or an object with one. */
export const categoryName = c => c.name || c;

/** The categories whose name holds `filter`, in any case; all of them for none. */
export function filterCategories(categories, filter) {
    const q = (filter || '').toLowerCase();
    return categories.filter(c => !q || categoryName(c).toLowerCase().includes(q));
}

/** The templates whose name (or file name) holds `filter`, in any case; all of them for none. */
export function filterTemplates(templates, filter) {
    const q = (filter || '').toLowerCase();
    return templates.filter(t => !q || (t.name || t.filename || '').toLowerCase().includes(q));
}

/** A template's name: its own, else its file name without .md. */
export const templateName = t => t.name || (t.filename || '').replace(/\.md$/, '');

/** A name as a row shows it: dashes as spaces. */
export const displayName = name => name.replace(/-/g, ' ');

/** What a template's preview says: name, description, the body cut at 500 characters, the facts it states (model, tools, arguments) and the button's label. */
export function previewParts(template, name, type) {
    const body = template.body || '';
    const meta = [];
    if (template.model) meta.push(`Model: ${template.model}`);
    if (template.tools) meta.push(`Tools: ${template.tools}`);
    if (template.allowed_tools) meta.push(`Tools: ${template.allowed_tools}`);
    if (template.argument_hint) meta.push(`Args: ${template.argument_hint}`);
    return {
        displayName: displayName(template.name || name),
        desc: template.description || '',
        body: body.length > 500 ? body.substring(0, 500) + '...' : body,
        meta,
        btnLabel: type === 'agents' ? 'Use Template' : 'Add as Macro',
    };
}
