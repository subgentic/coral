//go:build webview

package main

import (
	"encoding/json"
	"os/exec"
	"strconv"
	"strings"
	"testing"
)

// runDownloadScript runs downloadInterceptScript in node against a page at pageURL with a stand-in DOM and reports what a click on, or a script's click() of, a link did.
// mode: "user" is the person's click (the document's capture handler), "script" is a.click() on a link; haveNative says whether the page has _coralSaveFile.
func runDownloadScript(t *testing.T, node, pageURL, href, download, mode string, haveNative bool, disposition string, size int) (saved []string, prevented bool, passedToWebview bool, told []string) {
	t.Helper()
	harness := `
const page = new URL(process.argv[1]);
const [href, download, mode, haveNative, cd, size] = [process.argv[3], process.argv[4], process.argv[5], process.argv[6] === 'true', process.argv[7], process.argv[8]];
global.location = { href: page.href, origin: page.origin };
class Anchor { constructor() { this.tagName = 'A'; this.href = new URL(href, page).href; } hasAttribute(n) { return n === 'download' && download !== '-'; } getAttribute(n) { return n === 'download' && download !== '' ? download : (n === 'download' ? '' : null); } click() { this.passed = true; } }
global.HTMLAnchorElement = Anchor;
let handler = null; const saved = [], told = [];
global.document = { addEventListener: (type, fn) => { if (type === 'click') handler = fn; } };
global.window = { dispatchEvent: e => told.push(JSON.stringify(e.detail)) };
global.CustomEvent = class { constructor(t, o) { this.type = t; this.detail = o.detail; } };
global.FileReader = class { readAsDataURL(b) { this.result = 'data:application/octet-stream;base64,' + Buffer.from(b.text).toString('base64'); setTimeout(() => this.onload(), 0); } };
global.URL.createObjectURL = global.URL.createObjectURL || (() => "blob:x"); global.URL.revokeObjectURL = global.URL.revokeObjectURL || (() => {});
global.fetch = async () => ({ ok: true, headers: { get: n => (n === 'Content-Disposition' && cd !== '-') ? cd : null }, blob: async () => ({ text: 'file-bytes', size: Number(size) }) });
if (haveNative) window._coralSaveFile = async (name, b64) => { saved.push(name + ':' + Buffer.from(b64, 'base64').toString()); return '/tmp/dl/' + name; };
eval(process.argv[2]);
(async () => {
  const a = new Anchor(); let prevented = false;
  if (mode === 'user') handler({ target: { closest: () => (a.hasAttribute('download') ? a : null) }, preventDefault: () => { prevented = true; }, stopPropagation() {} });
  else a.click();
  await new Promise(r => setTimeout(r, 30));
  console.log(JSON.stringify({ saved, prevented, passed: !!a.passed, told }));
})();`
	out, err := exec.Command(node, "-e", harness, pageURL, downloadInterceptScript, href, download, mode, map[bool]string{true: "true", false: "false"}[haveNative], disposition, strconv.Itoa(size)).CombinedOutput()
	if err != nil {
		t.Fatalf("node: %v\n%s", err, out)
	}
	var r struct {
		Saved     []string `json:"saved"`
		Prevented bool     `json:"prevented"`
		Passed    bool     `json:"passed"`
		Told      []string `json:"told"`
	}
	if err := json.Unmarshal([]byte(strings.TrimSpace(string(out))), &r); err != nil {
		t.Fatalf("%v: %s", err, out)
	}
	return r.Saved, r.Prevented, r.Passed, r.Told
}

// A download in the app window (#9894): the person's click on <a download>, and a script's a.click() on a link, go to the native save, with the file's own name;
// a link to another origin, a link that is not a download and a page with no native save are left to the webview.
func TestDownloadInterceptScript(t *testing.T) {
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("node is not installed")
	}
	const page = "http://localhost:8420/agents"
	saved, prevented, passed, told := runDownloadScript(t, node, page, "/api/artifacts/abc", "report.md", "user", true, "-", 10)
	if len(saved) != 1 || saved[0] != "report.md:file-bytes" || !prevented || passed || len(told) != 1 || !strings.Contains(told[0], "/tmp/dl/report.md") {
		t.Errorf("a click on a download link: saved=%v prevented=%v passed=%v told=%v", saved, prevented, passed, told)
	}
	saved, _, passed, _ = runDownloadScript(t, node, page, "blob:http://localhost:8420/1234", "export.json", "script", true, "-", 10)
	if len(saved) != 1 || saved[0] != "export.json:file-bytes" || passed {
		t.Errorf("a script's click on a blob link: saved=%v passed=%v", saved, passed)
	}
	saved, _, passed, _ = runDownloadScript(t, node, page, "/api/artifacts/abc/content", "", "script", true, "-", 10)
	if len(saved) != 1 || saved[0] != "content:file-bytes" || passed {
		t.Errorf("no name given: the path's last part names the file: saved=%v passed=%v", saved, passed)
	}
	// an artifact's Download has an empty download attribute and an address that ends in a hash: the server's Content-Disposition names the file (#9894)
	hash := "/api/artifacts/" + strings.Repeat("ab", 32)
	for _, c := range []struct{ header, want string }{
		{`attachment; filename="report.md"`, "report.md"},
		{`inline; filename="a b.txt"; filename*=UTF-8''a%20b.txt`, "a b.txt"},
		{`attachment; filename*=UTF-8''r%C3%A9sum%C3%A9.pdf`, "r\u00e9sum\u00e9.pdf"},
		{"attachment", strings.Repeat("ab", 32)},
		{"-", strings.Repeat("ab", 32)},
	} {
		saved, _, _, _ = runDownloadScript(t, node, page, hash, "", "script", true, c.header, 10)
		if len(saved) != 1 || !strings.HasPrefix(saved[0], c.want+":") {
			t.Errorf("Content-Disposition %q: saved=%v, want the name %q", c.header, saved, c.want)
		}
	}
	// the link's own download name wins over the server's
	saved, _, _, _ = runDownloadScript(t, node, page, hash, "mine.txt", "script", true, `attachment; filename="theirs.txt"`, 10)
	if len(saved) != 1 || !strings.HasPrefix(saved[0], "mine.txt:") {
		t.Errorf("the link's own name: saved=%v", saved)
	}
	// a file over the cap is refused in the page, before it is read into memory
	saved, _, _, told = runDownloadScript(t, node, page, "/api/artifacts/big", "big.bin", "script", true, "-", 101*1024*1024)
	if len(saved) != 0 || len(told) != 1 || !strings.Contains(told[0], "too large") {
		t.Errorf("an oversized file: saved=%v told=%v", saved, told)
	}
	for _, c := range []struct {
		name, href, download, mode string
		native                     bool
	}{
		{"another origin", "https://example.invalid/x.zip", "x.zip", "script", true},
		{"not a download", "/docs/page", "-", "script", true},
		{"no native save", "/api/artifacts/abc", "report.md", "script", false},
	} {
		saved, _, passed, _ = runDownloadScript(t, node, page, c.href, c.download, c.mode, c.native, "-", 10)
		if len(saved) != 0 || !passed {
			t.Errorf("%s was not left to the webview: saved=%v passed=%v", c.name, saved, passed)
		}
	}
}
