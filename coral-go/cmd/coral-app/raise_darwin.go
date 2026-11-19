//go:build webview

package main

/*
#cgo CFLAGS: -x objective-c -fobjc-arc
#cgo LDFLAGS: -framework Cocoa

#import <Cocoa/Cocoa.h>

// coralRaiseWindow brings the app's window to the front and gives it the keyboard: a minimized window comes back, the app is
// activated over whatever has the screen. Safe from any thread (it runs on the main queue).
void coralRaiseWindow() {
    dispatch_async(dispatch_get_main_queue(), ^{
        NSApplication *app = [NSApplication sharedApplication];
        for (NSWindow *win in [app windows]) {
            if ([win isMiniaturized]) [win deminiaturize:nil];
            [win makeKeyAndOrderFront:nil];
        }
        [app activateIgnoringOtherApps:YES];
    });
}
*/
import "C"

import (
	"os"
	"os/signal"
	"syscall"
)

// raiseWindow brings the window to the front (#19789).
func raiseWindow() { C.coralRaiseWindow() }

// init makes SIGUSR1 (what the tray sends when the person clicks Open Coral, or opens the app again) raise the window. It is in init(), not main():
// SIGUSR1 ends a program that has no handler, and the tray can click in the first moments of a start, before main has run its first line.
func init() {
	ch := make(chan os.Signal, 1)
	signal.Notify(ch, syscall.SIGUSR1)
	go func() {
		for range ch {
			raiseWindow()
		}
	}()
}
