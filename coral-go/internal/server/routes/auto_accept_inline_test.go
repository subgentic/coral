package routes

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

// #7201: inline code, remote commands and command lists always ask; a script file, a module run and the version and help flags stay as they were.
func TestShellRiskInlineCodeRemoteAndListCommandsAsk(t *testing.T) {
	dir := t.TempDir()
	for _, c := range []string{
		// python
		`python3 -c 'print(1)'`, `python -c "import os; os.system('rm -rf /etc')"`, `python3.11 -c 'x'`, `pypy3 -c 'x'`, `/usr/bin/python3 -c 'x'`, `python3 -Sc 'x'`, `python3 -u -c 'x'`, `python3 -W ignore -c 'x'`, `python3 -`, `python3`, `python3 < x.py`, `echo 'print(1)' | python3`,
		// node, deno, bun
		`node -e 'console.log(1)'`, `node --eval 'x'`, `node --eval='x'`, `node -p '1+1'`, `node --print 1`, `node -pe '1'`, `nodejs -e 'x'`, `node -r ./setup -e 'x'`, `node --require ./setup -e 'x'`, `node --`, `node`, `echo 'x' | node`, `node -`,
		`deno eval 'x'`, `bun -e 'x'`, `bun --eval 'x'`, `bun -p 'x'`,
		// perl, ruby, php
		`perl -e 'system("x")'`, `perl -e 'print ` + "`" + `ls` + "`" + `'`, `perl -E 'unlink "x"'`, `perl -e 'exec "x"'`, `perl -e 'open(F, "| sh")'`, `perl -MFile::Path -e 'rmtree("x")'`, `perl -MPOSIX -e 'x'`, `perl -e 'eval $ENV{X}'`, `perl -ne 'print | "sh"'`, `perl -I lib -e 'system("x")'`, `perl`, `perl -`, `echo 'print 1' | perl`,
		`ruby -e 'puts 1'`, `ruby -ne 'puts'`, `ruby -I lib -e 'x'`, `ruby -rjson -e 'x'`, `php -r 'echo 1;'`, `php --run 'echo 1;'`, `php -R 'x'`, `php -B 'x'`,
		// awk with commands
		`awk 'BEGIN{system("rm -rf /etc")}'`, `awk 'BEGIN { system ("ls") }'`, `gawk '{print | "sort"}'`, `awk '{"date" | getline d}'`, `awk -F: '{print $1 | "sh"}' x`, `mawk 'BEGIN{system("x")}'`, `awk -e 'BEGIN{system("x")}'`,
		// behind a wrapper or a launcher
		`env python3 -c 'x'`, `env FOO=1 node -e 'x'`, `nice perl -e 'system("x")'`, `timeout 5 ruby -e 'x'`, `nohup python3 -c 'x' &`, `time php -r 'x'`, `xargs python3 -c 'x'`, `find . -exec python3 -c 'x' \;`, `watch node -e 'x'`, `flock /tmp/l python3 -c 'x'`, `setsid perl -e 'system("x")'`,
		`timeout 5 ssh host ls`, `env awk 'BEGIN{system("x")}'`, `nice parallel echo ::: a`,
		// remote and list
		`ssh host ls`, `ssh user@host 'rm -rf /etc'`, `ssh -p 22 host cmd`, `ssh host`, `ssh -o StrictHostKeyChecking=no host uptime`, `parallel echo ::: a b`, `parallel -j4 rm -rf ::: /etc`, `cat list | parallel gzip`,
	} {
		assert.NotEmpty(t, shellRisk(c, dir), "must ask: %s", c)
	}
}

func TestShellRiskInlineCodeRulesLeaveOrdinaryCommandsAlone(t *testing.T) {
	dir := t.TempDir()
	for _, c := range []string{
		// scripts, modules, versions
		`python3 x.py`, `python3 x.py -c config`, `python3 ./tools/run.py --e foo`, `python3 -m pytest`, `python3 -m http.server 8000`, `python -m venv .venv`, `python3 -V`, `python3 --version`, `python3 -h`, `pypy3 x.py`, `python3 -u x.py -c y`, `python3 -W ignore x.py`, `python3 -O x.py`,
		`node app.js`, `node app.js -e foo`, `node -v`, `node --version`, `node --check x.js`, `node -r ./setup x.js`, `node --require ./setup x.js`, `node --max-old-space-size=4096 build.js`, `deno run x.ts`, `deno test`, `deno --version`, `bun run x.ts`, `bun test`, `bun install`, `bun --version`,
		`perl -e 'print 1'`, `perl -E 'say 1'`, `perl -ne 'print'`, `perl -lane 'print $F[0]'`, `perl -pi -e 's/a/b/' x`, `perl -pi.bak -e 's/a/b/' x`, `perl -Mstrict -e 'print 1'`, `perl -I lib -ne 'print'`, `perl -0777 -ne 'print'`, `perl -pi -e 's/a/b/' src/a.go`, `perl -wle 'print 1'`,
		`perl script.pl`, `perl -w script.pl`, `perl -v`, `perl -c script.pl`, `perl -I lib script.pl`, `perl -Mstrict script.pl`, `ruby x.rb`, `ruby -v`, `ruby -I lib x.rb`, `ruby --version`, `php x.php`, `php -v`, `php -S localhost:8000`, `php artisan test`,
		`env python3 x.py`, `timeout 5 python3 x.py`, `nice node app.js`, `nohup python3 x.py &`, `xargs python3 x.py`, `find . -exec python3 x.py {} \;`, `env FOO=1 perl script.pl`,
		// awk and sed that do not run commands
		`awk '{print $1}' x`, `awk -F: '$1 > 5 {print}' x`, `awk '$1=="a"||$2=="b"' x`, `awk -f prog.awk x`, `awk 'BEGIN{x=1} END{print x}' x`, `gawk '{print $2}' x`, `sed -n 1p x`,
		// ordinary commands next to them
		`ssh-keygen -l -f key`, `ssh-add -l`, `ssh -V`, `ssh -G host`, `ssh -Q cipher`, `scp x host:y`, `parallel --version`, `parallelize x`, `go test ./...`, `git status`, `npm test`, `make`, `echo "python3 -c x"`, `git commit -m "node -e x"`, `ls python3`,
	} {
		assert.Empty(t, shellRisk(c, dir), "must pass: %s", c)
	}
}
