package main

import (
	"io"
	"os"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"
)

// stdoutOf runs fn and returns what it printed to the terminal.
func stdoutOf(t *testing.T, fn func()) string {
	t.Helper()
	old := os.Stdout
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	os.Stdout = w
	done := make(chan string)
	go func() { b, _ := io.ReadAll(r); done <- string(b) }()
	fn()
	os.Stdout = old
	w.Close()
	return <-done
}

// MOCK_BUSY behaves like Claude Code while it works (#10672): a line typed during the turn is held (queued) until the turn ends, in order, and does not end it.
func TestBusyHoldsTypedLinesUntilTheTurnEnds(t *testing.T) {
	var mu sync.Mutex
	var log []string
	note := func(s string) { mu.Lock(); log = append(log, s); mu.Unlock() }
	b := &inputBox{}
	if b.holdIfBusy("idle line") {
		t.Fatal("an idle box held a line")
	}
	b.beginBusy(80*time.Millisecond, func() { note("stop") }, func(s string) { note("send:" + s) })
	var submitted []string
	out := stdoutOf(t, func() { b.feed([]byte("first\rsecond\r"), func(s string) { submitted = append(submitted, s) }) })
	if len(submitted) != 0 {
		t.Fatalf("lines typed while busy reached the agent at once: %q", submitted)
	}
	if !strings.Contains(out, "queued") {
		t.Errorf("a held line says it is queued; saw %q", out)
	}
	mu.Lock()
	early := len(log)
	mu.Unlock()
	if early != 0 {
		t.Fatalf("typing during the turn ended it: %q", log)
	}
	time.Sleep(400 * time.Millisecond)
	mu.Lock()
	defer mu.Unlock()
	if want := []string{"stop", "send:first", "send:second"}; !reflect.DeepEqual(log, want) {
		t.Errorf("when the turn ends: Stop, then each held line in order; got %q want %q", log, want)
	}
}

// Escape (the dashboard's Stop) ends the turn at once with the CLI's interrupt line; the held lines go back into the box, as Claude Code does, and the timer never fires a second Stop.
func TestEscapeInterruptsABusyTurn(t *testing.T) {
	var mu sync.Mutex
	stops, sends := 0, 0
	b := &inputBox{}
	b.beginBusy(150*time.Millisecond, func() { mu.Lock(); stops++; mu.Unlock() }, func(string) { mu.Lock(); sends++; mu.Unlock() })
	stdoutOf(t, func() { b.feed([]byte("queued one\r"), func(string) {}) })
	out := stdoutOf(t, func() { b.feed([]byte("\x1b"), func(string) {}) })
	if !strings.Contains(out, "[Request interrupted by user]") {
		t.Errorf("no interrupt line: %q", out)
	}
	mu.Lock()
	if stops != 1 {
		t.Errorf("Stop fires once, at once, on Escape; got %d", stops)
	}
	mu.Unlock()
	if d := b.display(); d != "queued one" {
		t.Errorf("the held line goes back into the box; box = %q", d)
	}
	time.Sleep(400 * time.Millisecond)
	mu.Lock()
	defer mu.Unlock()
	if stops != 1 || sends != 0 {
		t.Errorf("the interrupted turn's timer must not end it again or send the held line: stops=%d sends=%d", stops, sends)
	}
	// After the interrupt a line is a normal submit again.
	var got []string
	b.feed([]byte("\r"), func(s string) { got = append(got, s) })
	if !reflect.DeepEqual(got, []string{"queued one"}) {
		t.Errorf("after an interrupt the box submits normally; got %q", got)
	}
}

// An Escape with nothing running is nothing, and a key's escape sequence (an arrow) never interrupts.
func TestEscapeWhenIdleOrAnArrowDoesNotInterrupt(t *testing.T) {
	stops := 0
	b := &inputBox{}
	if out := stdoutOf(t, func() { b.feed([]byte("\x1b"), func(string) {}) }); strings.Contains(out, "interrupted") {
		t.Errorf("an idle Escape printed %q", out)
	}
	b.beginBusy(time.Hour, func() { stops++ }, func(string) {})
	stdoutOf(t, func() { b.feed([]byte("\x1b[A\x1b[B"), func(string) {}) })
	if stops != 0 || !b.isBusy() {
		t.Errorf("an arrow key ended the turn: stops=%d busy=%v", stops, b.isBusy())
	}
	stdoutOf(t, func() { b.feed([]byte("\x1b"), func(string) {}) })
	if stops != 1 || b.isBusy() {
		t.Errorf("Escape ends it: stops=%d busy=%v", stops, b.isBusy())
	}
}
