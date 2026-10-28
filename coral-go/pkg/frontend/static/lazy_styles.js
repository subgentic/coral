/* Stylesheets that load with the tab that uses them, not at start (#10706): the Analytics page's rules (css/cost_dashboard.css) are a request of their own the first time the page is opened, and
 * the start's one stylesheet is that much smaller (page_weight css). The file is served next to the others (the bundled base keeps css/ beside it) and was one of the shell's links before, in the
 * same place in the cascade for every rule that is not also written in a sheet that comes after it (a census of the rest is in the commit that moved the file). A module that needs one awaits
 * loadStyles at its top, before it draws anything or the view is shown (panel loaders show a page only when its module has loaded), so the page is never drawn unstyled. */

const loads = new Map(); // href -> promise

/** Load css/<name> once. Resolves when the sheet has applied; a sheet that cannot be fetched is forgotten (the next call asks again) and the promise still resolves: the page is readable without it. */
export function loadStyles(name) {
    const href = new URL(`./css/${name}`, import.meta.url).href;
    if (loads.has(href)) return loads.get(href);
    if (/jsdom/i.test(globalThis.navigator?.userAgent || '')) return Promise.resolve(); // the node tests' DOM loads no stylesheet: nothing would ever say it had
    const p = new Promise(resolve => {
        const link = document.createElement('link');
        link.rel = 'stylesheet'; link.href = href;
        link.onload = () => resolve();
        link.onerror = () => { loads.delete(href); link.remove(); resolve(); };
        document.head.appendChild(link);
    });
    loads.set(href, p);
    return p;
}
