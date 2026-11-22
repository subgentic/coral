//go:build darwin && cgo

package executil

/*
#cgo LDFLAGS: -framework CoreServices -framework CoreFoundation
#include <CoreServices/CoreServices.h>
#include <stdlib.h>
static char *coralDefaultHTTPSBrowser(void) {
 CFStringRef id = LSCopyDefaultHandlerForURLScheme(CFSTR("https"));
 if (!id) return NULL;
 CFIndex size = CFStringGetMaximumSizeForEncoding(CFStringGetLength(id), kCFStringEncodingUTF8) + 1;
 char *out = (char *)malloc(size);
 if (out && !CFStringGetCString(id, out, size, kCFStringEncodingUTF8)) { free(out); out = NULL; }
 CFRelease(id);
 return out;
}
*/
import "C"
import "unsafe"

// Ask LaunchServices rather than guessing from file associations or preference
// overrides (the OS default can exist without an explicit preference entry).
func defaultBrowserID() (string, error) {
	id := C.coralDefaultHTTPSBrowser()
	if id == nil {
		return "", ErrUnknownBrowser
	}
	defer C.free(unsafe.Pointer(id))
	return C.GoString(id), nil
}
