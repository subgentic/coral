package dropbox

import (
	"net/http/httptest"
	"net/url"
	"testing"
)

// newTestClient points a client at srv: its host is the only one allowed, and every Dropbox URL goes there.
func newTestClient(t *testing.T, srv *httptest.Server) *Client {
	t.Helper()
	u, err := url.Parse(srv.URL)
	if err != nil {
		t.Fatal(err)
	}
	return newClient("appkey", srv.URL, srv.URL, func(host string) bool { return host == u.Host })
}
