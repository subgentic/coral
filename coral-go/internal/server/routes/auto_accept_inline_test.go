package routes

import (
	"runtime"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
)

// #7201: inline code, remote commands and command lists always ask (the rule for the family: if a word could put inline code or a remote command in front of an interpreter, ask); a script file, a
// module run and the version and help flags stay as they were.
func TestShellRiskInlineCodeRemoteAndListCommandsAsk(t *testing.T) {
	dir := t.TempDir()
	for _, c := range []string{
		// python: -c or a group with c anywhere, a program from input, modules that run the code they are given
		`python3 -c 'print(1)'`, `python -c "import os; os.system('rm -rf /etc')"`, `python3.11 -c 'x'`, `pypy3 -c 'x'`, `/usr/bin/python3 -c 'x'`, `./venv/bin/python -c 'x'`, `python3 -Sc 'x'`, `python3 -u -c 'x'`, `python3 -W ignore -c 'x'`,
		`python3 --check-hash-based-pycs default -c 'x'`, `python3 -c'print(1)'`, `python3 x.py -c config`, `python3 -u x.py -c y`, `python3 -m timeit 'x'`, `python3 -m code`, `python3 -`, `python3`, `python3 < x.py`, `echo 'print(1)' | python3`,
		// node, bun, deno
		`node -e 'console.log(1)'`, `node --eval 'x'`, `node --eval='x'`, `node -p '1+1'`, `node --print 1`, `node -pe '1'`, `nodejs -e 'x'`, `node -r ./setup -e 'x'`, `node --require ./setup -e 'x'`, `node app.js -e foo`, `node --`, `node`, `echo 'x' | node`, `node -`,
		`node --input-type module -e '1'`, `node --conditions x -e '1'`, `node -C x -e '1'`, `node --stack-trace-limit 5 -e '1'`, `deno eval 'x'`, `deno -e 'x'`, `bun -e 'x'`, `bun --eval 'x'`, `bun -p 'x'`,
		// perl, ruby, php: -e and -E always ask, whatever the program
		`perl -e 'print 1'`, `perl -E 'say 1'`, `perl -ne 'print'`, `perl -lane 'print $F[0]'`, `perl -pi -e 's/a/b/' x`, `perl -pi.bak -e 's/a/b/' x`, `perl -Mstrict -e 'x'`, `perl -I lib -e 'x'`, `perl -0777 -ne 'x'`, `perl -e 'readpipe("touch /tmp/x")'`,
		`perl -pi -e 's/a/readpipe("id")/e' x`, `perl -e 'dbmopen(%h, "/etc/x", 0644)'`, `perl -MStorable -e 'store {}, "/etc/x"'`, `perl -e 'system("x")'`, `perl -pi -e 's/a/b/' src/a.go`, `perl -wle 'print 1'`, `perl`, `perl -`, `echo 'print 1' | perl`,
		`ruby -e 'puts 1'`, `ruby -ne 'puts'`, `ruby -I lib -e 'x'`, `ruby -rjson -e 'x'`, `php -r 'echo 1;'`, `php --run 'echo 1;'`, `php -R 'x'`, `php -B 'x'`,
		// awk: system(), or any single | (a pipe to or from a command, in a variable too), attached -e and --source=
		`awk 'BEGIN{system("rm -rf /etc")}'`, `awk 'BEGIN { system ("ls") }'`, `gawk '{print | "sort"}'`, `awk '{"date" | getline d}'`, `awk -F: '{print $1 | "sh"}' x`, `mawk 'BEGIN{system("x")}'`, `awk -e 'BEGIN{system("x")}'`,
		`awk 'BEGIN{c="id"; c | getline x}'`, `awk '{ print | cmd }' f`, `gawk --source='BEGIN{system("id")}'`, `gawk -e'BEGIN{system("id")}'`, `awk '{print | "cat"} END{}' f`, `gawk 'BEGIN{x |& getline}'`,
		// the other inline-code launchers
		`osascript -e 'do shell script "id"'`, `osascript -l JavaScript -e 'x'`, `lua -e 'os.execute("id")'`, `Rscript -e 'system("id")'`, `julia -e 'run(` + "`id`" + `)'`, `julia -E 'x'`, `emacs --batch --eval '(shell-command "id")'`, `emacs --eval '(x)'`, `emacs -f x`,
		`vim -c '!id'`, `nvim --headless -c '!id'`, `vim --cmd '!id'`, `vim '+!id'`, `vi -S x`, `tclsh`, `tclsh x.tcl`, `npx -c 'id'`, `npx --call 'id'`, `rsync -e 'ssh -o ProxyCommand=id' a b`, `rsync -avze ssh a host:b`, `rsync --rsh='ssh' a b`, `rsync -e'sh -c id' a b`,
		// behind a wrapper or a launcher
		`env python3 -c 'x'`, `env FOO=1 node -e 'x'`, `nice perl -e 'x'`, `timeout 5 ruby -e 'x'`, `nohup python3 -c 'x' &`, `time php -r 'x'`, `xargs python3 -c 'x'`, `find . -exec python3 -c 'x' \;`, `watch node -e 'x'`, `flock /tmp/l python3 -c 'x'`, `setsid perl -e 'x'`,
		`timeout 5 ssh host ls`, `env awk 'BEGIN{system("x")}'`, `nice parallel echo ::: a`,
		// remote and list
		`ssh host ls`, `ssh user@host 'rm -rf /etc'`, `ssh -p 22 host cmd`, `ssh host`, `ssh -o StrictHostKeyChecking=no host uptime`, `sshpass -p x ssh host id`, `mosh host id`, `mosh host`, `autossh -M 0 host id`, `parallel echo ::: a b`, `parallel -j4 rm -rf ::: /etc`, `cat list | parallel gzip`,
	} {
		assert.NotEmpty(t, shellRisk(c, dir), "must ask: %s", c)
	}
}

func TestShellRiskInlineCodeRulesLeaveOrdinaryCommandsAlone(t *testing.T) {
	dir := t.TempDir()
	for _, c := range []string{
		// scripts, modules, versions
		`python3 x.py`, `python3 x.py -- -c y`, `node app.js -- -e foo`, `perl script.pl -- -e x`, `python3 ./tools/run.py --e foo`, `python3 -m pytest`, `python3 -m http.server 8000`, `python -m venv .venv`, `python3 -V`, `python3 --version`, `python3 -h`, `pypy3 x.py`, `python3 -W ignore x.py`, `python3 -O x.py`,
		`node app.js`, `node -v`, `node --version`, `node --check x.js`, `node -r ./setup x.js`, `node --require ./setup x.js`, `node --max-old-space-size=4096 build.js`, `deno run x.ts`, `deno test`, `deno --version`, `bun run x.ts`, `bun test`, `bun install`, `bun --version`,
		`perl script.pl`, `perl -w script.pl`, `perl -v`, `perl -c script.pl`, `perl -I lib script.pl`, `perl -Mstrict script.pl`, `ruby x.rb`, `ruby -v`, `ruby -I lib x.rb`, `ruby --version`, `php x.php`, `php -v`, `php -S localhost:8000`, `php artisan test`,
		`env python3 x.py`, `timeout 5 python3 x.py`, `nice node app.js`, `nohup python3 x.py &`, `xargs python3 x.py`, `find . -exec python3 x.py {} \;`, `env FOO=1 perl script.pl`,
		// awk and sed that do not run commands
		`awk '{print $1}' x`, `awk -F: '$1 > 5 {print}' x`, `awk -F'|' '{print $1}' x`, `awk -F '|' '{print $2}' x`, `awk -v sep='|' '{print $1}' x`, `awk '$1=="a"||$2=="b"' x`, `awk -f prog.awk x`, `awk 'BEGIN{x=1} END{print x}' x`, `gawk '{print $2}' x`, `sed -n 1p x`,
		// editors and runners named alone, version and help flags, other commands
		`vim x.txt`, `nvim x.txt`, `vim -V`, `emacs x.txt`, `lua x.lua`, `Rscript x.R`, `julia x.jl`, `osascript x.scpt`, `npx prettier --check .`, `npx tsc`, `rsync -a src/ dst/`, `rsync -av --delete src/ dst/`, `rsync -a --exclude=x src/ dst/`,
		`ssh -V`, `ssh -G host`, `ssh -Q cipher`, `scp x host:y`, `parallel --version`, `parallelize x`, `go test ./...`, `git status`, `npm test`, `make`, `echo "python3 -c x"`, `git commit -m "node -e x"`, `ls python3`,
	} {
		assert.Empty(t, shellRisk(c, dir), "must pass: %s", c)
	}
}

// A hyphenated program name (ssh-keygen, ssh-add, ts-node) is an ordinary command on Unix. On Windows the shell-risk rules for PowerShell take a word of two parts joined by a
// hyphen for a cmdlet (Verb-Noun), and one whose verb is not a reading one asks: the safe side, and the words say why. This pins both, so the list above stays one that passes everywhere.
func TestShellRiskHyphenatedProgramNames(t *testing.T) {
	dir := t.TempDir()
	for _, c := range []string{`ssh-keygen -l -f key`, `ssh-add -l`, `ts-node x.ts`} {
		if runtime.GOOS == "windows" {
			assert.Equal(t, "it runs "+strings.Fields(c)[0]+", which is not known to only read", shellRisk(c, dir), "asks on Windows: %s", c)
		} else {
			assert.Empty(t, shellRisk(c, dir), "must pass: %s", c)
		}
	}
}
