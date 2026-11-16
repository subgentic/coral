/* The pages of Coral a question card may offer a button for (#18768): coral-agent ask --open <page>. The names are internal/askpage's list (a test keeps the two equal); a name not here is not a button. */
import { go } from './nav.js';

export const ASK_PAGES = {
    analytics: { label: 'Open Analytics', open: () => go({ view: 'analytics' }) },
    settings: { label: 'Open Settings', open: () => { if (!window.showSettingsModal) throw new Error('Settings cannot be opened here.'); return window.showSettingsModal(); } },
    inbox: { label: 'Open Needs you', open: () => go({ view: 'inbox-folder', folder: 'needs' }) },
};

/** The button's words for a page name, '' when it is not a page of Coral that a card may open. */
export const askPageLabel = name => (Object.prototype.hasOwnProperty.call(ASK_PAGES, name) ? ASK_PAGES[name].label : '');

/** Open that page of Coral; it answers nothing. */
export const openAskPage = name => { if (!askPageLabel(name)) throw new Error('That is not a page of Coral.'); return ASK_PAGES[name].open(); };
