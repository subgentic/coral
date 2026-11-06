//go:build webview

package main

import (
	"encoding/json"
	"os/exec"
	"testing"
)

// Explicit-file go test with CGO_ENABLED=0 runs this Node policy test without
// compiling main.go, linking AppKit/WebKit, or opening a native window.
func TestManagedCoralLinksStayInsideTheApp13771(t *testing.T) {
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("node unavailable")
	}
	hex := "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
	for _, c := range []struct {
		name, href, marker  string
		external, prevented bool
	}{
		{"question artifact", "/api/artifacts/" + hex + "?v=2", hex, false, false},
		{"remote artifact", "/api/remote/other-computer/api/artifacts/" + hex + "?v=2", hex, false, false},
		{"managed chat", "coral://artifacts/" + hex, "chat:coral://artifacts/" + hex, false, false},
		{"managed goal", "coral://goals/team-a/12", "coral://goals/team-a/12", false, false},
		{"managed diff", "coral://diffs/team-a/abc123/0123456789abcdef", "coral://diffs/team-a/abc123/0123456789abcdef", false, false},
		{"malformed goal", "coral://goals/../12", "coral://goals/../12", false, true},
		{"external lookalike", "https://example.invalid/api/artifacts/" + hex, hex, true, true},
		{"unmarked new tab", "/api/artifacts/" + hex, "", true, true},
		{"mismatched marker", "/api/artifacts/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", hex, true, true},
	} {
		t.Run(c.name, func(t *testing.T) {
			harness := `global.location={href:'http://localhost:8420/inbox/needs',origin:'http://localhost:8420'};let handler;const opened=[];global.document={addEventListener:(_,fn)=>handler=fn};global.window={_coralOpenExternal:u=>opened.push(u),open:u=>opened.push(u)};global._coralOpenExternal=window._coralOpenExternal;eval(process.argv[1]);const href=process.argv[2],hex=process.argv[3],attrs={href,'data-artifact':hex,'class':'mb-artifact-ref'};if(hex.startsWith('chat:'))attrs['data-file-ref']=hex.slice(5);if(hex.startsWith('coral://'))attrs['data-coral-ref']=hex;const a={target:'_blank',getAttribute:n=>attrs[n]||null,hasAttribute:n=>n!=='download'&&!!attrs[n]};let prevented=false;handler({target:{closest:()=>a},preventDefault:()=>prevented=true});console.log(JSON.stringify({prevented,opened}));`
			out, err := exec.Command(node, "-e", harness, linkInterceptScript, c.href, c.marker).CombinedOutput()
			if err != nil {
				t.Fatalf("node: %v %s", err, out)
			}
			var got struct {
				Prevented bool     `json:"prevented"`
				Opened    []string `json:"opened"`
			}
			if err := json.Unmarshal(out, &got); err != nil {
				t.Fatal(err)
			}
			if got.Prevented != c.prevented || (len(got.Opened) > 0) != c.external {
				t.Fatalf("native policy: %s", out)
			}
		})
	}
}
