//go:build ignore

// Build a portable offline page with existing vendored libraries and the existing strict renderer.
package main
import (
 "fmt"
 "os"
 "path/filepath"
 "strings"
 "github.com/evanw/esbuild/pkg/api"
)
func main(){
 root,err:=filepath.Abs("..");if err!=nil{panic(err)}
 dir:=filepath.Join(root,"tests/prototypes/markdown_text")
 result:=api.Build(api.BuildOptions{EntryPoints:[]string{filepath.Join(dir,"view.mjs")},Bundle:true,Write:false,Format:api.FormatESModule,Platform:api.PlatformBrowser,Target:api.ES2022,MinifyWhitespace:true,MinifySyntax:true,MinifyIdentifiers:true,LogLevel:api.LogLevelWarning})
 if len(result.Errors)>0{os.Exit(1)}
 read:=func(path string)string{b,e:=os.ReadFile(path);if e!=nil{panic(e)};return string(b)}
 page:=read(filepath.Join(dir,"page.html"))
 safe:=func(s string)string{return strings.ReplaceAll(s,"</script","<\\/script")}
 pairs:=[]string{"STYLE",read(filepath.Join(dir,"style.css")),"REPORT",strings.ReplaceAll(read(filepath.Join(dir,"report.json")),"<","\\u003c"),"MARKED",safe(read(filepath.Join(root,"coral-go/pkg/frontend/static/vendor/marked.min.js"))),"PURIFY",safe(read(filepath.Join(root,"coral-go/pkg/frontend/static/vendor/purify.min.js"))),"APP",safe(string(result.OutputFiles[0].Contents))}
 // Replace placeholders once; document text must never be treated as another template marker.
 page=strings.NewReplacer(pairs...).Replace(page)
 out:=filepath.Join(root,"scratchpad/13728-markdown-text.html");if e:=os.MkdirAll(filepath.Dir(out),0700);e!=nil{panic(e)};if e:=os.WriteFile(out,[]byte(page),0600);e!=nil{panic(e)};fmt.Printf("Offline prototype: %d bytes\n",len(page))
}
