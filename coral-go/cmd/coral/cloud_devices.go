package main

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// pairingPrompt is what the computer says, in plain words, before the person confirms a browser pairing: what that browser will be able to do, and how to lower it here first (coral-hub condition b). The words follow the mode the next pairing will get.
func pairingPrompt(mode string) string {
	var can string
	switch mode {
	case "launch":
		can = "start sessions on this computer, and send to and answer your agents"
	case "interact":
		can = "send to and answer your agents' sessions on this computer, but not start new ones"
	case "view":
		can = "look at your sessions on this computer, and nothing more"
	default:
		// Fail safe: say what the most could be, never nothing.
		return "\nThis computer's setting for what a paired browser may do could not be read, so assume the most: this browser may be able to start sessions on this computer.\nTo give it less, press Ctrl-C and run first: coral cloud devices web-mode view\nYou can lower or remove any paired device later, here: coral cloud devices\n"
	}
	return fmt.Sprintf("\nThis browser will be able to %s (access: %s). This is the setting now: it is read again when the browser pairs, so what it gets is whatever the setting is then.\nTo give it less, press Ctrl-C and run first: coral cloud devices web-mode view\nYou can lower or remove any paired device later, here: coral cloud devices\n", can, mode)
}

type deviceListReply struct {
	WebMode string `json:"web_mode"`
	Devices []struct {
		KID        string `json:"kid"`
		Label      string `json:"label"`
		Mode       string `json:"mode"`
		Origin     string `json:"origin"`
		Kind       string `json:"kind"`
		LastUsedAt int64  `json:"last_used_at"`
	} `json:"devices"`
	ClockNotice string `json:"clock_notice"`
}

func validModeWord(m string) bool { return m == "view" || m == "interact" || m == "launch" }

// devices is `coral cloud devices`: list, remove, mode, web-mode and clear-clock, all through this computer's own server (never the Hub).
func (c *cloudClient) devices(ctx context.Context, words []string, out, errw io.Writer) int {
	if len(words) == 0 {
		words = []string{"list"}
	}
	var reply deviceListReply
	do := func(method, path string, body any) int {
		reply = deviceListReply{}
		return c.call(ctx, method, path, body, nil, 15*time.Second, &reply)
	}
	var code int
	switch {
	case words[0] == "list" && len(words) == 1:
		code = do(http.MethodGet, "/api/cloud/devices", nil)
	case words[0] == "remove" && len(words) == 2:
		code = do(http.MethodDelete, "/api/cloud/devices/"+url.PathEscape(words[1]), nil)
		if code < 0 {
			fmt.Fprintln(out, "Removed.")
		}
	case words[0] == "mode" && len(words) == 3 && validModeWord(words[2]):
		code = do(http.MethodPut, "/api/cloud/devices/"+url.PathEscape(words[1])+"/mode", map[string]string{"mode": words[2]})
		if code < 0 {
			fmt.Fprintf(out, "That device now has %s access.\n", words[2])
		}
	case words[0] == "web-mode" && len(words) == 2 && validModeWord(words[1]):
		code = do(http.MethodPut, "/api/cloud/device-web-mode", map[string]string{"mode": words[1]})
		if code < 0 {
			fmt.Fprintf(out, "A browser paired from now on gets %s access. Devices already paired keep theirs: lower one with: coral cloud devices mode <kid> <mode>\n", words[1])
		}
	case words[0] == "clear-clock" && len(words) == 1:
		code = do(http.MethodPost, "/api/cloud/devices/clear-clock", map[string]any{})
		if code < 0 {
			fmt.Fprintln(out, "The clock mark was reset to now.")
		}
	default:
		fmt.Fprintln(errw, "usage: coral cloud devices [list | remove <kid> | mode <kid> <view|interact|launch> | web-mode <view|interact|launch> | clear-clock]")
		return 2
	}
	if code >= 0 {
		return code
	}
	printDevices(out, reply)
	return 0
}

func printDevices(out io.Writer, r deviceListReply) {
	if r.ClockNotice != "" {
		fmt.Fprintln(out, r.ClockNotice)
	}
	fmt.Fprintf(out, "A browser paired from now on gets: %s access (a beta default, decided 2026-11-18; first reviewed at the start of the closed beta's second week). Change it here: coral cloud devices web-mode <view|interact|launch>\n", r.WebMode)
	if len(r.Devices) == 0 {
		fmt.Fprintln(out, "No paired devices.")
		return
	}
	for _, d := range r.Devices {
		// The label is a stranger's text: one line, no control characters.
		fmt.Fprintf(out, "%s  %-8s %-8s %-8s %s\n", d.KID, d.Mode, d.Origin, d.Kind, oneLine(d.Label))
	}
}

func oneLine(s string) string {
	return strings.Map(func(r rune) rune {
		if r < 0x20 || r == 0x7f || (r >= 0x80 && r < 0xa0) {
			return ' '
		}
		return r
	}, s)
}
