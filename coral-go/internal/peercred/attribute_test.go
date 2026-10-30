package peercred

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/netip"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #95 (Security's conditions 1 and 5): only a positive answer is Self. Another user is OtherUser;
// no row after one re-read 20 ms later, two owners, a process that can't be opened or any other
// error is Unattributed (fail closed); a table layout this build doesn't know is Unsupported. #409: any
// read error but an unknown layout is read again once (macOS's sysctl size race), so a read that fails
// for a moment and then finds Coral's user is Self.
func TestAttribute(t *testing.T) {
	if !Supported {
		v, err := Attribute(netip.MustParseAddrPort("127.0.0.1:50000"), netip.MustParseAddrPort("127.0.0.1:8420"))
		assert.Equal(t, Unsupported, v)
		assert.NoError(t, err)
		return
	}
	oldCheck, oldWait := ownerCheck, retryWait
	t.Cleanup(func() { ownerCheck, retryWait = oldCheck, oldWait })
	retryWait = 30 * time.Millisecond
	client, server := netip.MustParseAddrPort("127.0.0.1:50000"), netip.MustParseAddrPort("127.0.0.1:8420")

	for _, tc := range []struct {
		name    string
		answers []error // one per table read; nil means a row was found
		me      bool
		want    Verdict
	}{
		{"same user", []error{nil}, true, Self},
		{"another user", []error{nil}, false, OtherUser},
		{"no row, then one on the re-read", []error{ErrNotFound, nil}, true, Self},
		{"no row twice", []error{ErrNotFound, ErrNotFound}, true, Unattributed},
		{"two owners", []error{errAmbiguous, errAmbiguous}, true, Unattributed},
		{"process can't be opened", []error{errors.New("open process 1234: Access is denied"), errors.New("open process 1234: Access is denied")}, true, Unattributed},
		{"a read that fails for a moment, then finds the row", []error{errors.New("sysctl net.inet.tcp.pcblist_n: cannot allocate memory"), nil}, true, Self},
		{"unknown table layout, read once", []error{fmt.Errorf("%w: an inpcb item of 112 bytes", ErrLayout)}, true, Unsupported},
	} {
		reads := 0
		var times []time.Time
		ownerCheck = func(netip.AddrPort, netip.AddrPort, time.Time) (bool, error) {
			times = append(times, time.Now())
			err := tc.answers[reads]
			reads++
			return tc.me && err == nil, err
		}
		v, _ := Attribute(client, server)
		assert.Equal(t, tc.want, v, tc.name)
		assert.LessOrEqual(t, reads, 2, "%s: at most one re-read", tc.name)
		if len(times) == 2 {
			assert.GreaterOrEqual(t, times[1].Sub(times[0]), retryWait, "%s: the re-read waits", tc.name)
		}
	}
}

// #396: the relay is its own verdict, but not one anything but the sign-in link may tell from another user: SameUser says "not the same user" for it, like OtherUser.
func TestARelayIsNotTheSameUser(t *testing.T) {
	oldOwner, oldRelay := ownerCheck, relayCheck
	ownerCheck = func(netip.AddrPort, netip.AddrPort, time.Time) (bool, error) { return false, nil }
	relayCheck = func(netip.AddrPort, netip.AddrPort) bool { return true }
	t.Cleanup(func() { ownerCheck, relayCheck = oldOwner, oldRelay })
	if !Supported {
		t.Skip("no peer check on this platform")
	}
	v, err := Attribute(client, server)
	require.NoError(t, err)
	assert.Equal(t, Relay, v)

	r := httptestRequest()
	r = r.WithContext(context.WithValue(r.Context(), http.LocalAddrContextKey, net.Addr(&net.TCPAddr{IP: net.ParseIP("127.0.0.1"), Port: 8420})))
	same, supported := SameUser(r)
	assert.False(t, same, "the relay is not the same user")
	assert.True(t, supported)

	relayCheck = func(netip.AddrPort, netip.AddrPort) bool { return false }
	v, _ = Attribute(client, server)
	assert.Equal(t, OtherUser, v, "without the relay check it is another user, as before")
}
