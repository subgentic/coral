package main

import (
	"os"
	"reflect"
	"strings"
	"testing"
	"time"
)

// Ready mode (#10010) is one switch for what a person trying Coral with the mock needs: the raw-input box and hooks (a folder of its own), the idle profile, and the transcript. Off, nothing changes.
func TestReadyModeSetsWhatTheOtherModesRead(t *testing.T) {
	t.Run("off: nothing is set and the transcript choice is the caller's", func(t *testing.T) {
		t.Setenv("MOCK_AGENT_READY", "")
		t.Setenv("MOCK_AGENT_RAW_DIR", "")
		t.Setenv("MOCK_AGENT_IDLE", "")
		if applyReadyMode(false) {
			t.Error("the transcript was turned on")
		}
		if os.Getenv("MOCK_AGENT_RAW_DIR") != "" || os.Getenv("MOCK_AGENT_IDLE") != "" {
			t.Error("the environment was changed")
		}
	})
	t.Run("on: the box and hooks, idle, and the transcript", func(t *testing.T) {
		t.Setenv("HOME", t.TempDir()) // a home under the temp folder: the transcript cannot reach a real one
		t.Setenv("USERPROFILE", os.Getenv("HOME"))
		t.Setenv("CLAUDE_PROJECTS_DIR", "")
		t.Setenv("MOCK_AGENT_READY", "1")
		t.Setenv("MOCK_AGENT_RAW_DIR", "")
		t.Setenv("MOCK_AGENT_IDLE", "")
		if !applyReadyMode(false) {
			t.Error("the transcript is not written")
		}
		t.Cleanup(func() { os.RemoveAll(rawInputDir()) })
		if dir := rawInputDir(); dir == "" || !strings.HasPrefix(dir, os.TempDir()) {
			t.Errorf("raw-input mode is not on, in a folder of its own: %q", dir)
		}
		if os.Getenv("MOCK_AGENT_IDLE") != "1" {
			t.Error("the idle profile is not on")
		}
	})
	t.Run("on: a folder the caller set is kept", func(t *testing.T) {
		own := t.TempDir()
		t.Setenv("MOCK_AGENT_READY", "1")
		t.Setenv("MOCK_AGENT_RAW_DIR", own)
		applyReadyMode(false)
		if rawInputDir() != own {
			t.Errorf("raw folder %q, want %q", rawInputDir(), own)
		}
	})
}

// The reply a person sees in the chat is the canned greeting naming what they said, not the numbered line the suites read; with it off the numbered line is unchanged.
func TestReadyModeRepliesWithAGreeting(t *testing.T) {
	t.Setenv("CLAUDE_PROJECTS_DIR", t.TempDir())
	read := func(sid string) string {
		tr := newTranscript(sid, "claude-sonnet-5-5")
		if tr == nil {
			t.Fatal("no transcript")
		}
		if err := tr.Turn("hello, what can you do?\nsecond line"); err != nil {
			t.Fatal(err)
		}
		b, err := os.ReadFile(tr.path)
		if err != nil {
			t.Fatal(err)
		}
		return string(b)
	}
	t.Setenv("MOCK_AGENT_READY", "1")
	got := read("00000000-0000-4000-8000-00000000a0d1")
	if want := "Hi! I'm mock-agent, a stand-in for a real agent, so this reply is canned. You said: hello, what can you do?"; !strings.Contains(got, want) {
		t.Errorf("ready reply %q, want it to contain %q", got, want)
	}
	t.Setenv("MOCK_AGENT_READY", "")
	if got := read("00000000-0000-4000-8000-00000000a0d2"); !strings.Contains(got, "Mock reply 1 to: hello, what can you do?") {
		t.Errorf("default reply changed: %q", got)
	}
}

// Ready mode never writes a transcript into a real ~/.claude/projects (#10033): only with CLAUDE_PROJECTS_DIR set or a HOME under a temp folder; else it goes on without one.
func TestReadyModeTranscriptNeverReachesARealHome(t *testing.T) {
	setup := func(t *testing.T, home, projects string) {
		t.Setenv("MOCK_AGENT_READY", "1")
		t.Setenv("MOCK_AGENT_RAW_DIR", t.TempDir())
		t.Setenv("HOME", home)
		t.Setenv("USERPROFILE", home)
		t.Setenv("CLAUDE_PROJECTS_DIR", projects)
	}
	t.Run("a home that is not under a temp folder: no transcript", func(t *testing.T) {
		setup(t, "/nonexistent/real-home", "")
		if applyReadyMode(false) {
			t.Error("the transcript is written into a real home")
		}
	})
	t.Run("a caller that asked for the transcript keeps its choice", func(t *testing.T) {
		setup(t, "/nonexistent/real-home", "")
		if !applyReadyMode(true) {
			t.Error("MOCK_AGENT_TRANSCRIPT=1 was overridden")
		}
	})
	t.Run("CLAUDE_PROJECTS_DIR set: the transcript goes there", func(t *testing.T) {
		setup(t, "/nonexistent/real-home", t.TempDir())
		if !applyReadyMode(false) {
			t.Error("no transcript with a projects folder set")
		}
	})
	t.Run("a home under the temp folder: the transcript is written", func(t *testing.T) {
		setup(t, t.TempDir(), "")
		if !applyReadyMode(false) {
			t.Error("no transcript in a test's own home")
		}
	})
	t.Run("the temp folder itself is not a home", func(t *testing.T) {
		setup(t, os.TempDir(), "")
		if applyReadyMode(false) {
			t.Error("the temp folder was taken as a home")
		}
	})
}

// The raw-input folder is one of its own per agent, not a fixed path shared by every mock.
func TestReadyModeRawFolderIsOwnPerAgent(t *testing.T) {
	t.Setenv("MOCK_AGENT_READY", "1")
	var dirs []string
	for i := 0; i < 2; i++ {
		t.Setenv("MOCK_AGENT_RAW_DIR", "")
		t.Setenv("CLAUDE_PROJECTS_DIR", t.TempDir())
		applyReadyMode(false)
		d := rawInputDir()
		t.Cleanup(func() { os.RemoveAll(d) })
		dirs = append(dirs, d)
	}
	if dirs[0] == "" || dirs[0] == dirs[1] || strings.HasSuffix(dirs[0], "mock-agent-ready") {
		t.Errorf("the raw folders are not each their own: %v", dirs)
	}
}

// A tester makes the mock ask a question, ask permission or stop reading by typing a line (#10168): the menu opens and the hooks that make a Needs you row are told, an Enter ends it with the hooks that end the wait, and a deaf mock
// takes nothing (so the next send is typed and never shows).
func TestMockControlsMakeAQuestionAPermissionAndADeafBox(t *testing.T) {
	newBox := func() (*inputBox, *[]string) {
		var kinds []string
		b := &inputBox{}
		b.notify = func(kind string) { kinds = append(kinds, kind) }
		return b, &kinds
	}
	t.Run("a permission request", func(t *testing.T) {
		b, kinds := newBox()
		if h, w := applyControl(b, "MOCK_ASK_PERMISSION"); !h || !w || !b.promptOpen || b.question {
			t.Fatalf("the permission menu is not open: %+v", b)
		}
		b.feed([]byte("\r"), func(string) {})
		if want := []string{"permission_request", "permission_answered"}; !reflect.DeepEqual(*kinds, want) {
			t.Errorf("hooks %v, want %v", *kinds, want)
		}
		if b.promptOpen {
			t.Error("an Enter did not answer it")
		}
	})
	t.Run("a question", func(t *testing.T) {
		b, kinds := newBox()
		if h, w := applyControl(b, "MOCK_ASK_QUESTION"); !h || !w || !b.promptOpen || !b.question {
			t.Fatalf("the question is not open: %+v", b)
		}
		b.feed([]byte("\r"), func(string) {})
		if want := []string{"question_request", "question_answered"}; !reflect.DeepEqual(*kinds, want) {
			t.Errorf("hooks %v, want %v", *kinds, want)
		}
		if b.promptOpen || b.question {
			t.Error("an Enter did not answer it")
		}
	})
	t.Run("a digit answers a question, as the dashboard's answer buttons send it", func(t *testing.T) {
		b, kinds := newBox()
		applyControl(b, "MOCK_ASK_QUESTION")
		b.feed([]byte("1"), func(string) {})
		if want := []string{"question_request", "question_answered"}; !reflect.DeepEqual(*kinds, want) {
			t.Errorf("hooks %v, want %v", *kinds, want)
		}
		if b.promptOpen || b.question {
			t.Error("a digit did not answer it")
		}
	})
	t.Run("a dismissed question", func(t *testing.T) {
		b, kinds := newBox()
		applyControl(b, "MOCK_ASK_QUESTION")
		b.feed([]byte("\x1bx"), func(string) {}) // a lone Escape is held as the start of a paste marker until more arrives (as it always was): a following key completes it
		if want := []string{"question_request", "permission_dismissed"}; !reflect.DeepEqual(*kinds, want) || b.question {
			t.Errorf("hooks %v question=%v", *kinds, b.question)
		}
	})
	t.Run("a deaf box takes nothing", func(t *testing.T) {
		b, _ := newBox()
		if h, w := applyControl(b, "MOCK_GO_DEAF"); !h || w || !b.deaf {
			t.Fatal("not deaf")
		}
		var got []string
		b.feed([]byte("hello\r"), func(s string) { got = append(got, s) })
		if len(got) != 0 || b.display() != "" {
			t.Errorf("a deaf box took input: submitted %v, shows %q", got, b.display())
		}
	})
	t.Run("any other line is not a control", func(t *testing.T) {
		b, _ := newBox()
		if h, _ := applyControl(b, "hello"); h {
			t.Error("an ordinary message was taken as a control")
		}
	})
}

// MOCK_EXIT ends the mock like a CLI that quit; the test only checks it asks to exit (and is a control).
// MOCK_BUSY <seconds> keeps the stand-in working (#10602): the line is a turn with no Stop for that long, so a tester can reach Stop and queue sends. No number is 30 s; a bad number is not a control.
func TestApplyControlBusy(t *testing.T) {
	b := &inputBox{}
	if h, w := applyControl(b, "MOCK_BUSY 5"); !h || !w || b.busyFor != 5*time.Second {
		t.Fatalf("MOCK_BUSY 5: handled=%v waiting=%v busyFor=%v", h, w, b.busyFor)
	}
	b = &inputBox{}
	if h, w := applyControl(b, "MOCK_BUSY"); !h || !w || b.busyFor != 30*time.Second {
		t.Fatalf("MOCK_BUSY: handled=%v waiting=%v busyFor=%v", h, w, b.busyFor)
	}
	b = &inputBox{}
	if h, _ := applyControl(b, "MOCK_BUSY soon"); h || b.busyFor != 0 {
		t.Fatalf("a bad number is a message, not a control: handled=%v busyFor=%v", h, b.busyFor)
	}
}

func TestMockExitControlEndsTheProcess(t *testing.T) {
	var code = -1
	old := exitNow
	exitNow = func(c int) { code = c }
	t.Cleanup(func() { exitNow = old })
	b := &inputBox{}
	if h, _ := applyControl(b, "MOCK_EXIT"); !h || code != 0 {
		t.Errorf("handled=%v exit code %d", h, code)
	}
}

// MOCK_STUCK_ENTER leaves typed text in the box: an Enter submits nothing.
func TestStuckEnterLeavesTheTextInTheBox(t *testing.T) {
	b := &inputBox{}
	if h, _ := applyControl(b, "MOCK_STUCK_ENTER"); !h || !b.noSubmit {
		t.Fatal("not stuck")
	}
	var got []string
	b.feed([]byte("hello\r"), func(s string) { got = append(got, s) })
	if len(got) != 0 || b.display() != "hello" {
		t.Errorf("an Enter submitted %v, box shows %q", got, b.display())
	}
}

func TestStartDelay(t *testing.T) {
	for in, want := range map[string]time.Duration{"": 0, "x": 0, "-3": 0, "0": 0, "12": 12 * time.Second, "0.5": 500 * time.Millisecond} {
		t.Setenv("MOCK_AGENT_START_DELAY", in)
		if got := startDelay(); got != want {
			t.Errorf("MOCK_AGENT_START_DELAY=%q: %v, want %v", in, got, want)
		}
	}
}
