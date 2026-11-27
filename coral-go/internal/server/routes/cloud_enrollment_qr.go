package routes

import (
	"net/http"

	"github.com/subgentic/coral/internal/cloud"
)

// EnrollmentQR is local human input only. No request parameter carries the link
// or secret, and every refusal is the same 404 as an absent or expired hold.
func (h *CloudHandler) EnrollmentQR(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	if cloud.Tunneled(r) || !humanInputCaller(r) || !localDashboard(r) {
		http.NotFound(w, r)
		return
	}
	if same, supported := h.sameUser(r); supported && !same {
		http.NotFound(w, r)
		return
	}
	m := h.manager()
	if m == nil {
		http.NotFound(w, r)
		return
	}
	png := m.EnrollmentQRPNG()
	if len(png) == 0 {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Content-Type", "image/png")
	_, _ = w.Write(png)
}

// EnrollmentQRLocalOnly preserves the QR route's non-disclosing 404 before the
// general Hub guard would answer 403 for a never-tunneled route. It only refuses.
func EnrollmentQRLocalOnly(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/cloud/enroll-qr" && cloud.Tunneled(r) {
			w.Header().Set("Cache-Control", "no-store")
			w.Header().Set("X-Content-Type-Options", "nosniff")
			http.NotFound(w, r)
			return
		}
		next.ServeHTTP(w, r)
	})
}
