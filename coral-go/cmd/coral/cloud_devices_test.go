package main

import (
	"bufio"
	"bytes"
	"context"
	"io"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func withWebMode(mode string) string {
	return strings.Replace(enrolling, `"max_mode"`, `"device_web_mode":"`+mode+`","max_mode"`, 1)
}

// coral-hub condition (b): before the person confirms, the computer says in plain words what the paired browser will be able to do and how to lower it here; the words follow the setting; the text comes before the link.
func TestConnectPromptSaysWhatThePairedBrowserCanDoBeforeTheLink(t *testing.T) {
	want := map[string]string{
		"launch":   "This browser will be able to start sessions on this computer",
		"interact": "but not start new ones",
		"view":     "look at your sessions on this computer, and nothing more",
	}
	for mode, phrase := range want {
		fastPoll(t)
		f := newFakeCoral(t, ready, enrolled)
		f.statuses = []string{idle, enrolling, connected}
		f.connectReply = withWebMode(mode)
		c, _ := newCloudClient(f.srv.URL, "", "connect", io.Discard)
		require.NotNil(t, c)
		var out bytes.Buffer
		ui := connectUI{out: &out, in: bufio.NewReader(strings.NewReader("\n3\ny\n")), ask: true, how: "coral cloud connect"}
		require.Equal(t, 0, c.connectFlow(context.Background(), ui), out.String())
		o := out.String()
		assert.Contains(t, o, phrase, mode)
		assert.Contains(t, o, "(access: "+mode+")")
		assert.Contains(t, o, "read again when the browser pairs", "QA INFO: the mode is read at pairing time, not now")
		assert.Contains(t, o, "coral cloud devices web-mode view", "how to lower it here")
		assert.Less(t, strings.Index(o, phrase), strings.Index(o, "Open https://"), "before the link: the person reads it before confirming")
	}
}

// A log or a script gets no prompt (it asks nobody), and a mode that could not be read is never silence: the prompt says so and names launch, the most it could be.
func TestConnectPromptIsOnlyForAPersonAndFailsSafeForAnUnknownMode(t *testing.T) {
	// Security's SHOULD on slice 5: a mode that could not be read (an older server, a bad word) is never silence: the prompt says so and names the most it could be.
	for _, bad := range []string{"", "root", "LAUNCH"} {
		p := pairingPrompt(bad)
		assert.Contains(t, p, "could not be read", bad)
		assert.Contains(t, p, "start sessions on this computer", "names launch, the most it could be: "+bad)
		assert.Contains(t, p, "coral cloud devices web-mode view", bad)
	}
	fastPoll(t)
	f := newFakeCoral(t, ready, enrolled)
	f.statuses = []string{idle, enrolling, connected}
	f.connectReply = withWebMode("launch")
	c, _ := newCloudClient(f.srv.URL, "", "connect", io.Discard)
	var out bytes.Buffer
	require.Equal(t, 0, c.connectFlow(context.Background(), connectUI{out: &out, in: bufio.NewReader(strings.NewReader("")), how: "coral cloud connect"}))
	assert.NotContains(t, out.String(), "This browser will be able")
}

func TestCloudDevicesCommands(t *testing.T) {
	list := `{"web_mode":"launch","devices":[{"kid":"KID1","label":"Lap\u001b[31mtop\nx","mode":"launch","origin":"pairing","kind":"device"}],"clock_notice":"This computer's clock is behind the last time it accepted a device message (2026-11-20 10:00). Set the clock right. If the clock is right and the old time was wrong, run: coral cloud devices clear-clock"}`
	f := newFakeCoral(t, ready, enrolled)
	f.deviceReply = list
	var out, errb bytes.Buffer
	run := func(args ...string) int {
		out.Reset()
		return runCloud(append([]string{"devices"}, append(args, "--url", f.srv.URL)...), nil, &out, &errb)
	}
	require.Equal(t, 0, run(), errb.String())
	o := out.String()
	assert.Contains(t, o, "KID1")
	assert.Contains(t, o, "clear-clock", "the clock notice")
	assert.NotContains(t, o, "\x1b", "a label is one line of text")
	assert.Equal(t, 1, strings.Count(o, "KID1"))
	assert.Contains(t, o, "decided 2026-11-18; first reviewed at the start of the closed beta's second week", "the beta default is dated, with its review")

	require.Equal(t, 0, run("remove", "KID1"))
	require.Equal(t, 0, run("mode", "KID1", "view"))
	require.Equal(t, 0, run("web-mode", "interact"))
	require.Equal(t, 0, run("clear-clock"))
	calls := strings.Join(f.callList(), "\n")
	assert.Contains(t, calls, "DELETE /api/cloud/devices/KID1")
	assert.Contains(t, calls, `PUT /api/cloud/devices/KID1/mode {"mode":"view"}`)
	assert.Contains(t, calls, `PUT /api/cloud/device-web-mode {"mode":"interact"}`)
	assert.Contains(t, calls, "POST /api/cloud/devices/clear-clock")

	for _, bad := range [][]string{{"mode", "KID1", "root"}, {"web-mode"}, {"remove"}, {"nonsense"}, {"mode", "KID1"}} {
		errb.Reset()
		assert.Equal(t, 2, run(bad...), "%v", bad)
		assert.Contains(t, errb.String(), "usage: coral cloud devices")
	}
}

// #19969: the connect command tells the person which key to compare with the browser's.
func TestFingerprintLineNamesTheKeyAndSaysWhenNotToApprove(t *testing.T) {
	l := fingerprintLine("ABCD-EFGH-JKLM-NPQR")
	assert.Contains(t, l, "ABCD-EFGH-JKLM-NPQR")
	assert.Contains(t, l, "if the two differ, do not approve")
}
