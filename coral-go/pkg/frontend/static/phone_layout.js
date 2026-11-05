/* What counts as a phone's layout (#6683): a window at most 767 px wide (the breakpoint of css/mobile.css and every `max-width: 767px` rule), or a touch screen at most 500 px high, which is a phone turned to
 * landscape (844x390, 800x360, 844x200 with the keyboard up): wider than the breakpoint, but a phone all the same, so it gets the phone's layout (no side panel beside a terminal, the view dropdown, the
 * phone's controls) and not the desktop's. The CSS says the same with these two media queries (written out in each rule: a media query cannot name another); a tablet (touch, taller than 500 px) and a
 * desktop window (a mouse, any height) are not phones. The sideways clause stops at 950 px (the widest phone turned, 932 px): a touch laptop with a short, wide browser window is not a phone. No imports: the layout code, the renderer and the Settings dialog all ask it. */
export const PHONE_QUERY = '(max-width: 767px), (pointer: coarse) and (max-height: 500px) and (max-width: 950px)';
/** Where the phone's ONE top bar (phone_bar.js, css/mobile.css) replaces the old top pill: under 640 px (the width the old pill was a button for) and a phone turned to landscape. A view's search is the bar's pill there (#13591), and the Inbox has no tab row (#13596); between 640 and 767 px the view dropdown is still the pill and the Inbox keeps its tabs. */
export const PHONE_BAR_QUERY = '(max-width: 639px), (pointer: coarse) and (max-height: 500px) and (max-width: 950px)';
export const isPhoneBar = () => typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(PHONE_BAR_QUERY).matches;
/** The complement of PHONE_QUERY: a window wide enough for the desktop's layout. */
export const DESKTOP_QUERY = '(min-width: 768px) and (min-height: 501px), (min-width: 768px) and (pointer: fine), (min-width: 951px)';

/** Is the window a phone's right now? */
export function isPhoneLayout() {
    if (typeof window === 'undefined') return false;
    if (typeof window.matchMedia === 'function') return window.matchMedia(PHONE_QUERY).matches;
    return window.innerWidth <= 767;
}
