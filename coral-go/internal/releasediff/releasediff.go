// Package releasediff reads what Coral Hub pins from two refs of this repository and says what changed between them, mechanically, for a release's "For Coral Hub" note (#12331, goal #196):
// the tunnel's route table (every route with its tier, and who may use it when it is the owner's alone) and the keys of the board settings, HealthSettings included.
//
// Nothing here runs the code of either ref. The routes come from the route census's own golden files (internal/server/testdata/cloud_routes.golden, which a test keeps equal to the table the
// connector enforces, and owner_routes.golden), and the settings keys from the Go source of internal/board, read with go/parser, so an old tag needs no build.
package releasediff

import (
	"bufio"
	"bytes"
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"reflect"
	"sort"
	"strings"
)

// The files and the type this reads, relative to the repository root.
const (
	CloudRoutesPath = "coral-go/internal/server/testdata/cloud_routes.golden"
	OwnerRoutesPath = "coral-go/internal/server/testdata/owner_routes.golden"
	BoardDir        = "coral-go/internal/board/"
	SettingsType    = "BoardSettings"
)

// Entries maps a key (a route, a settings key) to what it holds in one ref: "launch owner-only" for a route, "bool" for a settings key.
type Entries map[string]string

// ParseRoutes reads the two route goldens: cloud lists every route as "METHOD path tier"; owner lists the owner's routes as "METHOD path tier how" (owner-only, owner-sees, ...). A route's entry is
// its tier, then how the owner reaches it when it is in the second list.
func ParseRoutes(cloud, owner []byte) (Entries, error) {
	out := Entries{}
	rows := func(b []byte, fields int, each func(key string, f []string)) error {
		sc := bufio.NewScanner(bytes.NewReader(b))
		sc.Buffer(make([]byte, 0, 64*1024), 1<<20)
		for n := 1; sc.Scan(); n++ {
			line := strings.TrimSpace(sc.Text())
			if line == "" || strings.HasPrefix(line, "#") {
				continue
			}
			f := strings.Fields(line)
			if len(f) != fields {
				return fmt.Errorf("line %d: want %d fields, have %d: %q", n, fields, len(f), line)
			}
			each(f[0]+" "+f[1], f[2:])
		}
		return sc.Err()
	}
	if err := rows(cloud, 3, func(key string, f []string) { out[key] = f[0] }); err != nil {
		return nil, fmt.Errorf("the cloud route golden: %w", err)
	}
	if err := rows(owner, 4, func(key string, f []string) {
		if t, ok := out[key]; ok {
			out[key] = t + " " + f[1]
		}
	}); err != nil {
		return nil, fmt.Errorf("the owner route golden: %w", err)
	}
	return out, nil
}

// ParseSettings reads the Go files of internal/board (name to source; test files left out by the caller) and flattens BoardSettings into its JSON keys: "health.claim_nudge.after_min" is "int", a
// list of structs is "list.field" under "key[]". A field tagged json:"-" is not a key, and a field with no json tag is not one either (the settings are read and written by their tags).
func ParseSettings(files map[string][]byte) (Entries, error) {
	fset := token.NewFileSet()
	structs := map[string]*ast.StructType{}
	names := make([]string, 0, len(files))
	for n := range files {
		names = append(names, n)
	}
	sort.Strings(names)
	for _, n := range names {
		f, err := parser.ParseFile(fset, n, files[n], parser.SkipObjectResolution)
		if err != nil {
			return nil, fmt.Errorf("%s: %w", n, err)
		}
		for _, d := range f.Decls {
			g, ok := d.(*ast.GenDecl)
			if !ok || g.Tok != token.TYPE {
				continue
			}
			for _, s := range g.Specs {
				if ts, ok := s.(*ast.TypeSpec); ok {
					if st, ok := ts.Type.(*ast.StructType); ok {
						structs[ts.Name.Name] = st
					}
				}
			}
		}
	}
	root, ok := structs[SettingsType]
	if !ok {
		return nil, fmt.Errorf("no type %s in %s*.go", SettingsType, BoardDir)
	}
	out := Entries{}
	var walk func(st *ast.StructType, prefix string, seen map[string]bool)
	walk = func(st *ast.StructType, prefix string, seen map[string]bool) {
		for _, fld := range st.Fields.List {
			name := jsonName(fld)
			if name == "" {
				continue
			}
			key := prefix + name
			elem, suffix := fld.Type, ""
			for {
				switch t := elem.(type) {
				case *ast.StarExpr:
					elem = t.X
					continue
				case *ast.ArrayType:
					elem, suffix = t.Elt, "[]"
					continue
				}
				break
			}
			if id, ok := elem.(*ast.Ident); ok && structs[id.Name] != nil && !seen[id.Name] {
				out[key+suffix] = "object " + id.Name // the object is a key too: a switch added or removed under it shows below
				walk(structs[id.Name], key+suffix+".", withSeen(seen, id.Name))
				continue
			}
			out[key] = typeString(fld.Type)
		}
	}
	walk(root, "", map[string]bool{SettingsType: true})
	return out, nil
}

func withSeen(m map[string]bool, k string) map[string]bool {
	n := make(map[string]bool, len(m)+1)
	for a := range m {
		n[a] = true
	}
	n[k] = true
	return n
}

// jsonName is the key a field is read and written under, or "" for a field that is not one.
func jsonName(f *ast.Field) string {
	if f.Tag == nil || len(f.Names) == 0 {
		return ""
	}
	tag := reflect.StructTag(strings.Trim(f.Tag.Value, "`")).Get("json")
	name, _, _ := strings.Cut(tag, ",")
	if name == "-" {
		return ""
	}
	return name
}

func typeString(e ast.Expr) string {
	switch t := e.(type) {
	case *ast.Ident:
		return t.Name
	case *ast.StarExpr:
		return "*" + typeString(t.X)
	case *ast.ArrayType:
		return "[]" + typeString(t.Elt)
	case *ast.MapType:
		return "map[" + typeString(t.Key) + "]" + typeString(t.Value)
	case *ast.SelectorExpr:
		return typeString(t.X) + "." + t.Sel.Name
	case *ast.InterfaceType:
		return "any"
	}
	return "?"
}

// Change is one key that is in both refs with a different entry.
type Change struct{ Key, Old, New string }

// Diff is what was added, removed and changed from one ref to the next, each in key order.
type Diff struct {
	Added, Removed []Change // Old is empty for an added key, New for a removed one
	Changed        []Change
}

// Compare says what differs between the old and the new entries.
func Compare(old, cur Entries) Diff {
	var d Diff
	for k, v := range cur {
		if o, ok := old[k]; !ok {
			d.Added = append(d.Added, Change{Key: k, New: v})
		} else if o != v {
			d.Changed = append(d.Changed, Change{Key: k, Old: o, New: v})
		}
	}
	for k, v := range old {
		if _, ok := cur[k]; !ok {
			d.Removed = append(d.Removed, Change{Key: k, Old: v})
		}
	}
	for _, s := range [][]Change{d.Added, d.Removed, d.Changed} {
		sort.Slice(s, func(i, j int) bool { return s[i].Key < s[j].Key })
	}
	return d
}

// Empty is whether nothing differs.
func (d Diff) Empty() bool { return len(d.Added)+len(d.Removed)+len(d.Changed) == 0 }
