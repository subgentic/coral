package shellkill

// Programs is what a caller that wants to know WHICH commands a Bash call runs (the resource queue's hook, #13645) reads: for every simple command in the text, including the ones inside $( ), backquotes, bash -c
// and eval, the words from the program on (the wrappers sudo, env, time, timeout, nohup and a leading NAME=value are skipped; the program's own path is cut to its name). A word in a quote, a heredoc or an
// echo argument is an ARGUMENT, never a program. ok is false past a bound (a longer command, deeper nesting, more commands, more time than the pkill guard allows): the caller then treats the command as one it
// cannot read, which for a guard against overlap means: let it run.
func Programs(command string) (all [][]string, ok bool) {
	cmds, ok := commands(command)
	if !ok {
		return nil, false
	}
	for _, c := range cmds {
		i := programIndex(c)
		if i < 0 {
			continue
		}
		words := append([]string{base(c.words[i])}, c.words[i+1:]...)
		all = append(all, words)
	}
	return all, true
}
