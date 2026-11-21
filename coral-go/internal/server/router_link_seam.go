package server

import (
	"net/http"

	"github.com/subgentic/coral/internal/store"
)

// routerTestWrap is a seam for this package's tests and is nil in every build: when a test sets it, the router puts the middleware it returns first. The tests build requests that carry
// the connector's stamp (cloud.ViaSecret) straight onto the router; the link stamp (#20312) would refuse each one for want of a link, so the tests' init supplies a known link to a request
// that carries none (link_stamp_test.go). Nothing else about the request is changed.
var routerTestWrap func(db *store.DB) func(http.Handler) http.Handler
