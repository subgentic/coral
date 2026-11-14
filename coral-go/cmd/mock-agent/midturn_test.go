package main

import (
	"bufio"
	"encoding/json"
	"os"
	"reflect"
	"testing"
)

func TestMidturnReceiptsUseBothClaudeShapes(t *testing.T) {
	t.Setenv("CLAUDE_PROJECTS_DIR", t.TempDir())
	t.Setenv("MOCK_AGENT_MIDTURN", "1")
	tr := newTranscript("00000000-0000-4000-8000-000000016464", "")
	for _, text := range []string{"MIDTURN-PLAIN focus on the test", "MIDTURN-QUEUED prepare a test build"} {
		if err := tr.Turn(text); err != nil {
			t.Fatal(err)
		}
	}
	f, err := os.Open(tr.path)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	var rows []map[string]any
	scan := bufio.NewScanner(f)
	for scan.Scan() {
		var row map[string]any
		if err := json.Unmarshal(scan.Bytes(), &row); err != nil {
			t.Fatal(err)
		}
		rows = append(rows, row)
	}
	if err := scan.Err(); err != nil {
		t.Fatal(err)
	}
	var kinds []any
	for _, row := range rows {
		kinds = append(kinds, row["type"])
	}
	if !reflect.DeepEqual(kinds, []any{"user", "queue-operation", "queue-operation", "attachment"}) {
		t.Fatalf("receipt shapes: %v", kinds)
	}
	att := rows[3]["attachment"].(map[string]any)
	if att["type"] != "queued_command" || att["prompt"] != "MIDTURN-QUEUED prepare a test build" || att["commandMode"] != "prompt" {
		t.Fatalf("wrong attachment shape")
	}
}

func TestMidturnModeDoesNotHoldInputUntilStop(t *testing.T) {
	t.Setenv("MOCK_AGENT_MIDTURN", "1")
	b := &inputBox{}
	b.busy.active = true
	if b.holdIfBusy("MIDTURN-PLAIN hello") {
		t.Fatal("midturn receipt was held")
	}
	if !b.isBusy() {
		t.Fatal("receiving a message ended the open turn")
	}
}
