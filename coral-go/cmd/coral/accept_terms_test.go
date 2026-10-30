package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/license"
	terms "github.com/subgentic/coral/pkg/license"
)

func acceptPayload(version, digest, by string) string {
	b, _ := json.Marshal(map[string]string{"version": version, "sha256": digest, "by": by})
	return string(b)
}

type recorded struct{ version, digest, by string }

// The command's own job: read the acceptance from stdin, strictly, and hand it on. What the marker holds and which terms are refused is the license package's (hub_owner_test.go).
func TestAcceptTermsReadsTheAcceptanceFromStdinOnly(t *testing.T) {
	var got []recorded
	record := func(v, d, b string) error { got = append(got, recorded{v, d, b}); return nil }
	var out, errb bytes.Buffer

	if code := runAcceptTerms([]string{license.EULAVersion}, strings.NewReader(""), &out, &errb, record); code != 2 {
		t.Errorf("an argument: %d", code)
	}
	for name, in := range map[string]string{
		"empty":         "",
		"not json":      "accepted",
		"extra field":   `{"version":"` + license.EULAVersion + `","sha256":"` + terms.EULADigest() + `","by":"hub-owner","source":"dialog"}`,
		"two documents": acceptPayload(license.EULAVersion, terms.EULADigest(), "hub-owner") + acceptPayload(license.EULAVersion, terms.EULADigest(), "hub-owner"),
		"too long":      acceptPayload(license.EULAVersion, terms.EULADigest(), "hub-owner") + strings.Repeat(" ", 5000),
	} {
		out.Reset()
		errb.Reset()
		assert.Equal(t, 2, runAcceptTerms(nil, strings.NewReader(in), &out, &errb, record), name)
		assert.Empty(t, out.String(), name)
	}
	assert.Empty(t, got, "a refused input reached the recorder")

	// a refusal of the recorder is the command's refusal
	out.Reset()
	errb.Reset()
	deny := func(string, string, string) error { return errors.New("not these terms") }
	assert.Equal(t, 1, runAcceptTerms(nil, strings.NewReader(acceptPayload("1999-01-01", terms.EULADigest(), "hub-owner")), &out, &errb, deny))
	assert.Contains(t, errb.String(), "refused")
	assert.Empty(t, out.String())

	// a good acceptance is handed on exactly as given
	out.Reset()
	errb.Reset()
	require.Equal(t, 0, runAcceptTerms(nil, strings.NewReader(acceptPayload(license.EULAVersion, terms.EULADigest(), "hub-owner@build-host")), &out, &errb, record), errb.String())
	assert.Equal(t, []recorded{{license.EULAVersion, terms.EULADigest(), "hub-owner@build-host"}}, got)
	assert.Contains(t, out.String(), license.EULAVersion)
}

func TestAcceptTermsIsNotInTheHelp(t *testing.T) {
	for _, c := range commands() {
		assert.NotEqual(t, "accept-terms", c.name, "it is the setup's command, not a person's")
	}
}
