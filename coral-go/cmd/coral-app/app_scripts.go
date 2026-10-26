//go:build webview

package main

// nativeAppScript marks the page as the native app (class flags on <html> and <body>) and shows the Server Disconnected overlay when the server stops answering.
const nativeAppScript = `window.__CORAL_APP__ = true;
	(function() {
		var mac = navigator.platform && navigator.platform.indexOf('Mac') !== -1;
		var win = navigator.platform && navigator.platform.indexOf('Win') !== -1;
		function mark(el) {
			if (!el || !el.classList) return;
			el.classList.add('native-app');
			if (mac) el.classList.add('native-macos');
			if (win) el.classList.add('native-windows');
		}
		mark(document.documentElement);
		document.addEventListener('DOMContentLoaded', function() { mark(document.documentElement); mark(document.body); });
	})();

	// Server health check — detect when the backend crashes
	(function() {
		var wasConnected = false;
		var overlayEl = null;

		function getOverlay() {
			if (overlayEl) return overlayEl;
			overlayEl = document.getElementById('coral-app-disconnect-overlay');
			if (overlayEl) return overlayEl;
			// Create overlay if it doesn't exist yet (injected before DOM loads)
			var el = document.createElement('div');
			el.id = 'coral-app-disconnect-overlay';
			el.style.cssText = 'display:none;position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,0.75);align-items:center;justify-content:center;flex-direction:column;font-family:-apple-system,BlinkMacSystemFont,sans-serif;color:#e0e0e0;';
			el.innerHTML = '<div style="text-align:center;max-width:400px;padding:32px">'
				+ '<div style="font-size:48px;margin-bottom:16px">⚠️</div>'
				+ '<h2 style="margin:0 0 8px;font-size:20px;color:#fff">Server Disconnected</h2>'
				+ '<p style="margin:0 0 16px;font-size:14px;color:#aaa">Coral may have crashed. Check <code style="background:rgba(255,255,255,0.1);padding:2px 6px;border-radius:3px;font-size:12px">~/.coral/coral.log</code> for details.</p>'
				+ '<div style="display:flex;align-items:center;gap:8px;justify-content:center">'
				+ '<span class="coral-reconnect-spinner" style="display:inline-block;width:16px;height:16px;border:2px solid rgba(255,255,255,0.2);border-top-color:#fff;border-radius:50%;animation:coral-reconnect-spin 0.8s linear infinite"></span>'
				+ '<span style="font-size:13px;color:#888">Reconnecting...</span>'
				+ '</div></div>';
			// The log this server writes, in its own data folder (#4151), as text.
			var code = el.querySelector('code');
			if (code && window.__CORAL_LOG_PATH__) code.textContent = window.__CORAL_LOG_PATH__;
			// Add spinner animation
			var style = document.createElement('style');
			style.textContent = '@keyframes coral-reconnect-spin { to { transform: rotate(360deg); } }';
			document.head.appendChild(style);
			document.body.appendChild(el);
			overlayEl = el;
			return el;
		}

		function checkHealth() {
			fetch('/api/health', { method: 'GET', cache: 'no-store' })
				.then(function(r) {
					if (r.ok) {
						if (!wasConnected) wasConnected = true;
						var ov = getOverlay();
						if (ov.style.display !== 'none') {
							ov.style.display = 'none';
							// Reload to restore full state after reconnect
							location.reload();
						}
					} else {
						showDisconnect();
					}
				})
				.catch(function() {
					showDisconnect();
				});
		}

		function showDisconnect() {
			if (!wasConnected) return; // Don't show overlay during initial load
			var ov = getOverlay();
			ov.style.display = 'flex';
		}

		// Start polling after page loads
		document.addEventListener('DOMContentLoaded', function() {
			wasConnected = true;
			setInterval(checkHealth, 5000);
		});
	})();`

// consoleRedirectScript sends the page's console output, navigation and WebSocket events to the Go log (the --debug window only).
const consoleRedirectScript = `
			(function() {
				const origLog = console.log;
				const origWarn = console.warn;
				const origError = console.error;
				console.log = function() {
					origLog.apply(console, arguments);
					try { _coralLog('LOG', Array.from(arguments).join(' ')); } catch(e) {}
				};
				console.warn = function() {
					origWarn.apply(console, arguments);
					try { _coralLog('WARN', Array.from(arguments).join(' ')); } catch(e) {}
				};
				console.error = function() {
					origError.apply(console, arguments);
					try { _coralLog('ERROR', Array.from(arguments).join(' ')); } catch(e) {}
				};

				// Log navigation and WebSocket events
				window.addEventListener('hashchange', function(e) {
					_coralLog('NAV', 'hashchange: ' + location.hash);
				});
				window.addEventListener('popstate', function(e) {
					_coralLog('NAV', 'popstate: ' + location.href);
				});

				// Monitor WebSocket connections
				const origWS = window.WebSocket;
				window.WebSocket = function(url, protocols) {
					_coralLog('WS', 'connecting: ' + url);
					const ws = new origWS(url, protocols);
					ws.addEventListener('open', function() { _coralLog('WS', 'connected: ' + url); });
					ws.addEventListener('close', function(e) { _coralLog('WS', 'closed: ' + url + ' code=' + e.code); });
					ws.addEventListener('error', function() { _coralLog('WS', 'error: ' + url); });
					return ws;
				};
				window.WebSocket.prototype = origWS.prototype;
				window.WebSocket.CONNECTING = origWS.CONNECTING;
				window.WebSocket.OPEN = origWS.OPEN;
				window.WebSocket.CLOSING = origWS.CLOSING;
				window.WebSocket.CLOSED = origWS.CLOSED;
			})();
		`
