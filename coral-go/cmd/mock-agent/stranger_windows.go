package main

import "syscall"

// strangerAttr: on Windows the stranger is a second program below the agent in its console (the notice gate's rule is "the agent is the only program in the tree").
func strangerAttr() *syscall.SysProcAttr { return nil }

func reclaimTerminal() {}
