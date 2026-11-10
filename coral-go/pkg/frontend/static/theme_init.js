/* Apply the saved theme before first paint (classic script, runs in <head>). Only dark, light and system are themes here: anything else (a name a hub stored, an old value) is not one, and a page with no saved choice
   follows the system's light or dark (a phone set to light opens light, #15234), on this computer and on the Cloud Hub, its sign-in and connect pages included (#6087: a phone through the hub has no saved choice, and must never be left with no theme tokens). */
(function () {
    var mode = document.documentElement.hasAttribute('data-hub-page') ? 'cloud' : 'local'; // the hub's own pages (sign-in, connect a machine) say so on <html>: they follow the system too (#6094); this computer's own pages (the dashboard, its sign-in and password pages) do not
    try { var boot = document.getElementById('coral-boot'); if (boot) mode = JSON.parse(boot.textContent).mode || 'local'; } catch (_) {}
    var t = null;
    try { t = localStorage.getItem('coral-theme'); } catch (_) {}
    if (t !== 'dark' && t !== 'light' && t !== 'system') t = 'system';
    if (t === 'system') t = window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', t);
    // The browser's own bar follows the page's light or dark (#10095): the colour is the theme's page colour, set again whenever the theme changes.
    function barColour() { return document.documentElement.getAttribute('data-theme') === 'light' ? '#f4f5f7' : '#0a0e14'; }
    // This script runs before the page's own theme-color meta is parsed, so the right one goes in first (the browser reads the first): a light theme's first paint does not flash the dark bar.
    var first = document.createElement('meta');
    first.setAttribute('name', 'theme-color'); first.setAttribute('content', barColour());
    if (document.head) document.head.insertBefore(first, document.head.firstChild);
    function paintBar() {
        var m = document.querySelector('meta[name="theme-color"]'); // the first one: the one above
        if (m) m.setAttribute('content', barColour());
    }
    // The launch notice's row (#14835): it is read after first paint, and arriving moved the page by its height. A browser that last saw it unseen kept a hint (a convenience only: the server's 409 gate is the authority), and its room is reserved
    // here, before first paint, until the notice fills it (launch_disclosure.js releases it). The hint is for this kind of screen (phone or not: a phone's window is not its final width while the head is read, so its screen counts too), whose notice is that tall; the hub's pages and a pop-out never get the notice.
    try {
        var hint = /^([pd])\|(\d{1,3})$/.exec(localStorage.getItem('coral-launch-notice') || ''), phoneScreen = window.innerWidth <= 600 || screen.width <= 600, room_px = '';
        if (hint && (hint[1] === 'p') === phoneScreen) room_px = hint[2];
        else { // no hint for this kind of screen (a new profile, a phone after a wide window): when the server says the notice is unseen, a typical height is reserved (#14935; the notice's real height is kept as the hint once it is shown)
            var unseen = false; try { unseen = JSON.parse(document.getElementById('coral-boot').textContent).launch_unseen === true; } catch (_) {}
            if (unseen) room_px = phoneScreen ? '53' : '73';
        }
        if (room_px && mode !== 'cloud' && location.pathname.indexOf('/agent/') !== 0 && document.head) {
            var room = document.createElement('style'); room.id = 'launch-notice-room';
            room.textContent = 'html[data-launch-notice]:not(:has(#launch-disclosure-banner)) .layout{margin-top:' + room_px + 'px}'; // the notice sits just above the layout (after the sign-in banner, which is in the page from the start, hidden until shown)
            document.head.appendChild(room); document.documentElement.setAttribute('data-launch-notice', '1');
        }
    } catch (_) {}
    document.addEventListener('DOMContentLoaded', paintBar);
    new MutationObserver(paintBar).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
})();
/* The static prefix this page loaded from (/static/ or a versioned /static/b/<build>/).
   Scripts and tools that import app modules from outside the module graph (tests,
   devtools) import from here, so they share the page's module instances. */
try { window.__coralStatic = new URL('./', document.currentScript.src).pathname; } catch (_) { window.__coralStatic = '/static/'; }
