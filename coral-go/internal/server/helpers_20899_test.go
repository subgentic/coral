package server

import "time"

func timeNow() time.Time     { return time.Now() }
func timeLongAgo() time.Time { return time.Now().AddDate(-1, 0, 0) }
