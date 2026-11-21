package main

import (
	"bytes"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

const linkList = `{"links":[{"link_id":"lnk-0000000a","hub_origin":"https://hub-a.example.com","label":"Lap\u001b[31mtop\nx","state":"active","max_mode":"view"}],"max_links":8}`

func runLinks(t *testing.T, f *fakeCoral, args ...string) (int, string, string) {
	t.Helper()
	var out, errb bytes.Buffer
	code := runCloud(append(append([]string{"links"}, args...), "--url", f.srv.URL), nil, &out, &errb)
	return code, out.String(), errb.String()
}

func mutating(f *fakeCoral) []string {
	var m []string
	for _, c := range f.callList() {
		if !strings.HasPrefix(c, "GET ") {
			m = append(m, c)
		}
	}
	return m
}

// #20346: the list names each link by id and full Hub address, one line each, a label's control characters never reach the terminal.
func TestLinksListShowsIdAndFullHubAddress(t *testing.T) {
	f := newFakeCoral(t, ready, enrolled)
	f.linkReply = linkList
	code, out, _ := runLinks(t, f)
	require.Equal(t, 0, code, out)
	assert.Contains(t, out, "lnk-0000000a")
	assert.Contains(t, out, "https://hub-a.example.com")
	assert.Contains(t, out, "view")
	assert.NotContains(t, out, "\x1b")
	assert.Equal(t, 1, strings.Count(strings.TrimSpace(out), "\n")+1, "one link, one line: "+out)
}

// The cap is typed out loud: a link is found by id or by its full address, the answer names the Hub and the grant, and a word that is not a mode, a missing mode or an unknown link calls nothing.
func TestLinksCapNamesTheHubAndTheGrantAndNeverGuesses(t *testing.T) {
	f := newFakeCoral(t, ready, enrolled)
	f.linkReply = linkList
	code, out, _ := runLinks(t, f, "cap", "https://hub-a.example.com", "interact")
	require.Equal(t, 0, code, out)
	assert.Equal(t, []string{`PUT /api/cloud/links/lnk-0000000a/cap {"mode":"interact"}`}, mutating(f))
	assert.Contains(t, out, "https://hub-a.example.com")
	assert.Contains(t, out, "interact")
	assert.Contains(t, out, "send to and answer your agents")

	for _, bad := range [][]string{{"cap", "lnk-0000000a"}, {"cap", "lnk-0000000a", "root"}, {"cap", "lnk-0000000a", "LAUNCH"}, {"cap"}, {"remove"}, {"nope"}} {
		g := newFakeCoral(t, ready, enrolled)
		g.linkReply = linkList
		code, _, errb := runLinks(t, g, bad...)
		assert.Equal(t, 2, code, "%v", bad)
		assert.Contains(t, errb, "usage:")
		assert.Empty(t, mutating(g), "%v", bad)
	}
	g := newFakeCoral(t, ready, enrolled)
	g.linkReply = linkList
	code, _, errb := runLinks(t, g, "cap", "lnk-ffffffff", "view")
	assert.NotEqual(t, 0, code)
	assert.Contains(t, errb, "No link")
	assert.Empty(t, mutating(g))
}

// Remove says what the Hub answered: finished, or waiting, or "the Hub still lists this computer".
func TestLinksRemoveReportsTheOutcome(t *testing.T) {
	for name, c := range map[string]struct{ reply, want string }{
		"still listed": {`{"links":[],"message":"the Hub still lists this computer"}`, "the Hub still lists this computer"},
		"pending":      {`{"links":[{"link_id":"lnk-0000000a","hub_origin":"https://hub-a.example.com","state":"removing","max_mode":"view"}],"pending":true,"message":"Removing: waiting for the Hub to confirm. It is asked again every hour."}`, "waiting for the Hub"},
		"done":         {`{"links":[]}`, "Removed https://hub-a.example.com"},
	} {
		f := newFakeCoral(t, ready, enrolled)
		f.linkReply = c.reply
		// the list read first resolves the id; the fake answers every links route with the one reply, so give the lookup a list that holds the link
		f.linkReply = strings.Replace(c.reply, `"links":[]`, `"links":[{"link_id":"lnk-0000000a","hub_origin":"https://hub-a.example.com","state":"active","max_mode":"view"}]`, 1)
		code, out, _ := runLinks(t, f, "remove", "lnk-0000000a")
		require.Equal(t, 0, code, name+": "+out)
		assert.Equal(t, []string{"DELETE /api/cloud/links/lnk-0000000a "}, mutating(f), name)
		assert.Contains(t, out, c.want, name)
	}
}
