package routes

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/ptymanager"
	"github.com/subgentic/coral/internal/terminalinput"
)

type countBackend struct {
	ptymanager.TerminalBackend
	sent, resized atomic.Int32
}

func (b *countBackend) SendInput(terminalinput.Origin, string, []byte) error {
	b.sent.Add(1)
	return nil
}
func (b *countBackend) Resize(string, uint16, uint16) error { b.resized.Add(1); return nil }

// #21883: with "Require a trusted device" on, a terminal socket through the Hub refuses the frames that act (typing, a composer message, a resize) with device_required, keeps the socket for reading,
// and types nothing; a frame that only reads or focuses goes on, a person at this computer (not through the Hub) is untouched, and with the switch off nothing changes.
func TestWithTheSwitchOnATerminalSocketThroughTheHubRefusesEveryActingFrame(t *testing.T) {
	for _, tc := range []struct {
		name         string
		viaHub, on   bool
		frame        terminalFrame
		refused      bool
		wantSent     int32
		wantResized  int32
		wantReplyAny bool
	}{
		{"typing through the hub, switch on", true, true, terminalFrame{Type: "terminal_input", Data: "rm -rf x\r"}, true, 0, 0, true},
		{"composer through the hub, switch on", true, true, terminalFrame{Type: "composer_send", Data: "hello"}, true, 0, 0, true},
		{"resize through the hub, switch on", true, true, terminalFrame{Type: "terminal_resize", Cols: 120, Rows: 40}, true, 0, 0, true},
		{"typing through the hub, switch off", true, false, terminalFrame{Type: "terminal_input", Data: "ls"}, false, 1, 0, true},
		{"typing at this computer, switch on", false, true, terminalFrame{Type: "terminal_input", Data: "ls"}, false, 1, 0, true},
		{"focus through the hub, switch on", true, true, terminalFrame{Type: "terminal_focus", Focused: true}, false, 0, 0, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			be := &countBackend{}
			h := &SessionsHandler{backend: be, requireDevice: func() bool { return tc.on }}
			done := make(chan struct{})
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				defer close(done)
				conn, err := websocket.Accept(w, r, nil)
				if err != nil {
					return
				}
				defer conn.CloseNow()
				ts := &terminalStream{h: h, ctx: r.Context(), conn: conn, name: "n", agentType: "claude", sessionID: "S", viaHub: tc.viaHub, sizeCheck: make(chan int64, 1)}
				id := int64(7)
				tc.frame.ID = &id
				ts.handleFrame(tc.frame)
				conn.Close(websocket.StatusNormalClosure, "done")
			}))
			defer srv.Close()
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			c, _, err := websocket.Dial(ctx, "ws"+srv.URL[4:], nil)
			require.NoError(t, err)
			defer c.CloseNow()
			_, data, err := c.Read(ctx)
			<-done
			if tc.refused {
				require.NoError(t, err)
				var m map[string]any
				require.NoError(t, json.Unmarshal(data, &m))
				assert.Equal(t, "terminal_input_failed", m["type"])
				assert.Equal(t, "device_required", m["code"])
				assert.Equal(t, true, m["not_sent"])
				assert.EqualValues(t, 7, m["id"])
				assert.Equal(t, requireDeviceFrameText, m["error"])
			} else if err == nil {
				var m map[string]any
				require.NoError(t, json.Unmarshal(data, &m))
				assert.NotEqual(t, "device_required", m["code"])
			}
			assert.Equal(t, tc.wantSent, be.sent.Load(), "what was typed")
			assert.Equal(t, tc.wantResized, be.resized.Load(), "what was resized")
		})
	}
}

func TestTheTerminalFrameSwitchIsOffWhenNothingIsWired(t *testing.T) {
	assert.False(t, (&SessionsHandler{}).refuseTerminalFrame(true, "terminal_input"))
}
