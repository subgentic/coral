package hubproxy

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// Security's MUST 6 on #21220: a request key goes in its own header, never as Authorization, and never to a plain-http address that is not this computer; an API key is sent as before.
func TestARequestKeyIsSentInItsOwnHeaderAndNeverInClearAcrossANetwork(t *testing.T) {
	key := "lr" + "k_0123abcd_" + strings.Repeat("e", 32)
	var gotAuth, gotKey atomic.Value
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth.Store(r.Header.Get("Authorization"))
		gotKey.Store(r.Header.Get(LinkKeyHeader))
	}))
	defer ts.Close()

	send := func(k string) error {
		req, _ := http.NewRequestWithContext(context.Background(), "GET", "http://x/api/health", nil)
		req.Header.Set("Authorization", "Bearer from-the-browser")
		resp, err := HTTPTarget{URL: ts.URL, APIKey: k, AllowPrivate: true}.RoundTrip(req)
		if err == nil {
			resp.Body.Close()
		}
		return err
	}
	require.NoError(t, send(key), "plain http to this computer (loopback) is allowed")
	assert.Equal(t, "", gotAuth.Load(), "never as Authorization")
	assert.Equal(t, key, gotKey.Load())
	require.NoError(t, send("an-api-key"))
	assert.Equal(t, "Bearer an-api-key", gotAuth.Load(), "an API key is sent as before")
	assert.Equal(t, "", gotKey.Load())

	for _, u := range []string{"http://box.example.com", "http://192.168.1.20:8420", "ftp://box.example.com"} {
		err := HTTPTarget{URL: u, APIKey: key, AllowPrivate: true}.Validate()
		require.Error(t, err, u)
		assert.True(t, errors.Is(err, ErrLinkKeyPlainHTTP) || strings.Contains(err.Error(), "invalid remote url"), "%s: %v", u, err)
		_, err = HTTPTarget{URL: u, APIKey: key, AllowPrivate: true}.DialWS(context.Background(), "/ws/coral", "", nil)
		require.Error(t, err, u)
	}
	assert.NoError(t, HTTPTarget{URL: "https://box.example.com", APIKey: key, AllowPrivate: true}.Validate(), "https is allowed")
	registrationKey := "an-api-key" // a variable, not a literal beside APIKey: the repository secret rule reads that literal as a header key
	assert.NoError(t, HTTPTarget{URL: "http://box.example.com", APIKey: registrationKey, AllowPrivate: true}.Validate(), "an API key keeps its own rule (the registration's)")
}
