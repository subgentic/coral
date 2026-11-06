//go:build webview

package main

// linkInterceptScript decides what a click on a link does in the app window (#5094). It runs in every page the window shows, before the page's own script.
//
//   - The address is resolved against the page (new URL), and what it is is read from that: the old test was a string prefix ("starts with the page's
//     origin"), which "http://localhost:8420.evil.example/" and "http://localhost:8420@evil.example/" pass, so the window itself navigated there and the
//     page, looking like Coral, had the app's native bindings.
//   - Only an http or https address is ever followed. A file:, a custom scheme, a javascript: or an address that does not parse does nothing (the window
//     is not navigated to a local file or handed to the system's opener).
//   - A web address on another origin, and a link with target _blank (except a same-origin native download), opens in the system browser; a same-origin link without target is the page's own.
const linkInterceptScript = `document.addEventListener('click', function(e) {
	if (e.defaultPrevented) return;
	var a = e.target && e.target.closest ? e.target.closest('a') : null;
	if (!a) return;
	var href = a.getAttribute('href');
	if (!href) return;
	var u;
	try { u = new URL(href, location.href); } catch (err) { e.preventDefault(); return; }
	// A dashboard-managed Coral reference belongs to the page's internal opener.
	// Match its exact closed identity and same-origin route; a marker cannot turn
	// an external/look-alike URL into a trusted destination (#13771).
	var marker = a.getAttribute('data-artifact') || a.getAttribute('data-attachment') || '';
	var chatRef = a.getAttribute('data-file-ref') || '';
	var chatHex = /^coral:\/\/artifacts\/([a-f0-9]{64})$/i.exec(chatRef);
	if (!marker && chatHex) marker = chatHex[1];
	var subject = a.getAttribute('data-coral-ref') || '';
	var subjectOK = /^coral:\/\/goals\/[A-Za-z0-9][A-Za-z0-9_.-]{0,63}\/[1-9][0-9]{0,9}$/.test(subject) || /^coral:\/\/diffs\/[A-Za-z0-9][A-Za-z0-9_.-]{0,63}\/[A-Za-z0-9][A-Za-z0-9_-]{5,63}\/[a-f0-9]{16}$/.test(subject);
	if ((subjectOK && href === subject) || (chatHex && href === chatRef)) return;
	var path = /^(?:\/api\/remote\/[^/]+)?\/api\/artifacts\/([a-f0-9]{64})$/i.exec(u.pathname);
	if (u.origin === location.origin && !u.username && !u.password && !u.hash && (u.search === '' || u.search === '?v=2') && path && /^[a-f0-9]{64}$/i.test(marker) && marker.toLowerCase() === path[1].toLowerCase() && !a.hasAttribute('download')) return;
	if (u.protocol !== 'http:' && u.protocol !== 'https:') { e.preventDefault(); return; }
	// Same-origin downloads belong to the native saver, including target=_blank links.
	if (u.origin === location.origin && a.hasAttribute('download') && typeof window._coralSaveFile === 'function') return;
	if (u.origin !== location.origin || a.target === '_blank') {
		e.preventDefault();
		if (window._coralOpenExternal) { _coralOpenExternal(u.href); } else { window.open(u.href, '_blank'); }
	}
}, true);`
