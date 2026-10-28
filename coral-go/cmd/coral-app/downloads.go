//go:build webview

package main

// downloadInterceptScript sends a download to the app (#9894). A native webview drops <a download> and blob: addresses, so the person pressed Download and nothing happened.
// A click on an <a download> (the person's, or a script's a.click() on a link that is not in the page) is fetched here, with the window's own session,
// and its bytes go to window._coralSaveFile (the token-checked native, which saves them into Downloads); the page is told with a coral:native-download event, which the dashboard
// says in a toast. A link to another origin (an address the page cannot read) is left to the webview, and so is any page that has no _coralSaveFile (a page that is not the dashboard).
const downloadInterceptScript = `(function () {
	if (window.__coralDownloadWired) return;
	window.__coralDownloadWired = true;
	var origClick = HTMLAnchorElement.prototype.click;
	// The dashboard's connect-src does not allow blob: addresses, so a blob: link is not fetched: the Blob a page made is kept by its address (until it is revoked) and read directly.
	var blobs = {};
	var origCreate = URL.createObjectURL, origRevoke = URL.revokeObjectURL;
	URL.createObjectURL = function (b) { var u = origCreate.apply(this, arguments); try { blobs[u] = b; } catch (e) {} return u; };
	URL.revokeObjectURL = function (u) { try { delete blobs[u]; } catch (e) {} return origRevoke.apply(this, arguments); };
	function readable(a) {
		try { var u = new URL(a.href, location.href); return u.protocol === 'blob:' || u.origin === location.origin; } catch (e) { return false; }
	}
	function isDownload(a) { return !!a && a.tagName === 'A' && a.hasAttribute('download') && !!a.href && readable(a) && typeof window._coralSaveFile === 'function'; }
	// The file's name: the link's own download="name", else the server's Content-Disposition (an artifact's Download has an empty download attribute and its address ends in a hash, #9894), else the address's last part.
	function dispositionName(h) {
		if (!h) return '';
		var m = /filename\*\s*=\s*utf-8''([^;]+)/i.exec(h);
		if (m) { try { return decodeURIComponent(m[1].trim()); } catch (e) {} }
		m = /filename\s*=\s*"((?:[^"\\]|\\.)*)"/i.exec(h) || /filename\s*=\s*([^;]+)/i.exec(h);
		return m ? m[1].trim().replace(/\\(.)/g, '$1') : '';
	}
	function nameOf(a, header) {
		var n = a.getAttribute('download');
		if (n) return n;
		n = dispositionName(header);
		if (n) return n;
		try { return decodeURIComponent(new URL(a.href, location.href).pathname.split('/').pop()) || 'download'; } catch (e) { return 'download'; }
	}
	var MAX_BYTES = 100 * 1024 * 1024; // the native refuses more; the page does not read it into memory first
	function base64Of(blob) {
		return new Promise(function (resolve, reject) {
			var r = new FileReader();
			r.onload = function () { var s = String(r.result); resolve(s.slice(s.indexOf(',') + 1)); };
			r.onerror = function () { reject(new Error('could not read the file')); };
			r.readAsDataURL(blob);
		});
	}
	function tell(detail) { window.dispatchEvent(new CustomEvent('coral:native-download', { detail: detail })); }
	function save(a) {
		var url = a.href, name = nameOf(a, '');
		var made = blobs[url]; // taken now: the page revokes the address right after its click
		(made ? Promise.resolve(made) : fetch(url, { credentials: 'same-origin', cache: 'no-store' }).then(function (r) {
			if (!r.ok) throw new Error('Download failed (' + r.status + ')');
			name = nameOf(a, r.headers && r.headers.get ? r.headers.get('Content-Disposition') : '');
			return r.blob();
		}))
			.then(function (blob) { if (blob.size > MAX_BYTES) throw new Error('that file is too large to save from the app'); return blob; })
			.then(base64Of)
			.then(function (b64) { return window._coralSaveFile(name, b64); })
			.then(function (path) { tell({ name: name, path: String(path || '') }); })
			.catch(function (e) { tell({ name: name, error: (e && e.message) || 'Download failed' }); });
	}
	document.addEventListener('click', function (e) {
		var a = e.target && e.target.closest ? e.target.closest('a[download]') : null;
		if (isDownload(a)) { e.preventDefault(); e.stopPropagation(); save(a); }
	}, true);
	HTMLAnchorElement.prototype.click = function () {
		if (isDownload(this)) { save(this); return; }
		return origClick.apply(this, arguments);
	};
})();`
