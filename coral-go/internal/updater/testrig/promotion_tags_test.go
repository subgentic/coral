package testrig

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/updater/stage"
)

// The promotion release is tagged on the promote branch's commit, so GitHub's list (ordered by that commit's date) puts it behind every newer release, and past the one page the check reads.
// With the tags asked for by name it is found whatever the list holds: staged. Without the lookup (the old behaviour, the control) the same repository is "not promoted", silently.
func TestAPromotionBehindSixtyNewerReleasesIsFoundByItsTag(t *testing.T) {
	for _, withTags := range []bool{false, true} {
		t.Run(fmt.Sprintf("tag lookup %v", withTags), func(t *testing.T) {
			r := newRig(t)
			r.publish(Spec{Version: "1.4.131", Sequence: 7})
			var page []map[string]any // the first page of the list: 60 newer releases and no promotion
			for i := 0; i < 60; i++ {
				page = append(page, map[string]any{"tag_name": fmt.Sprintf("v1.5.%d", i), "draft": false, "prerelease": true, "assets": []any{}})
			}
			var err error
			r.gh.ListBody, err = json.Marshal(page)
			require.NoError(t, err)
			if withTags {
				r.gh.ServeRefs = true
				r.cfg.RefsURL = r.gh.RefsURL()
			}
			res := r.check()
			if withTags {
				require.Equal(t, stage.ResultStaged, res.Result, "%+v", res)
				assert.Equal(t, "1.4.131", res.Version)
				assert.Zero(t, r.gh.Hits[listKey], "the list was not needed")
			} else {
				assert.Equal(t, stage.ResultNotPromoted, res.Result, "the control: the list shows no promotion")
			}
		})
	}
}

// The newest ten promotion tags are looked at, chosen by the sequence in the name and not by the order of the answer; a name that is not promote-<tag>-<sequence> is not looked at. Every manifest
// here is garbled so that none verifies: each is skipped, and the pass goes on to the next.
func TestPromotionTagsAreChosenBySequenceNotByAnswerOrder(t *testing.T) {
	r := newRig(t)
	r.publish(Spec{Version: "1.4.131", Sequence: 1}) // a newer release than the installed one, for the feed
	for n := 1; n <= 15; n++ {
		if n != 7 { // the tags have no sequence 7
			r.publish(Spec{Version: "1.4.140", Sequence: int64(n)})
		}
	}
	r.gh.Mutate = func(path string, body []byte) []byte {
		if strings.HasPrefix(path, "promote-v1.4.140-") && strings.HasSuffix(path, "/"+stage.ManifestFile) {
			return []byte("{}")
		}
		return body
	}
	r.gh.ServeRefs = true
	r.cfg.RefsURL = r.gh.RefsURL()
	var refs []map[string]string
	for _, n := range []int{3, 14, 1, 12, 5, 10, 2, 13, 4, 11, 6, 15, 9, 8} { // out of order
		refs = append(refs, map[string]string{"ref": "refs/tags/" + PromotionTag("v1.4.140", int64(n))})
	}
	refs = append(refs, map[string]string{"ref": "refs/tags/promote-nonsense"}, map[string]string{"ref": "refs/tags/" + PromotionTag("v1.4.140", 99) + "x"})
	var err error
	r.gh.RefsBody, err = json.Marshal(refs)
	require.NoError(t, err)
	res := r.check()
	assert.Equal(t, stage.ResultFailed, res.Result, "none of them verifies: a refusal; %+v", res)
	asked := func(n int) int {
		return r.gh.Hits[FakeRepo+"/releases/download/"+PromotionTag("v1.4.140", int64(n))+"/"+stage.ManifestFile]
	}
	for _, n := range []int{15, 14, 13, 12, 11, 10, 9, 8, 6, 5} {
		assert.Positive(t, asked(n), "sequence %d is among the newest ten", n)
	}
	for _, n := range []int{4, 3, 2, 1} {
		assert.Zero(t, asked(n), "sequence %d is not", n)
	}
}

// A promotion named by its tag whose files answer 404 is most often one made seconds ago that the download host does not serve yet. Above the best promotion verified so far (here: nothing yet) it
// stops the pass, so an older promotion cannot win over it (a revocation must not lose to the promotion it revokes); once its files are served it is the one taken. (Security's ruling on #530.)
func TestATaggedPromotionNotServedYetStopsThePassAndDoesNotLetAnOlderOneWin(t *testing.T) {
	r := newRig(t)
	r.publish(Spec{Version: "1.4.130", Sequence: 5})
	r.publish(Spec{Version: "1.4.131", Sequence: 8})
	r.gh.ServeRefs = true
	r.cfg.RefsURL = r.gh.RefsURL()
	newest := PromotionTag("v1.4.131", 8) + "/" + stage.ManifestFile
	r.gh.Status[newest] = 404
	res := r.check()
	assert.Equal(t, stage.ResultFailed, res.Result, "%+v", res)
	assert.Equal(t, "manifest", res.FailedStage)
	assert.NotEmpty(t, res.NextAttempt, "backed off")
	r.nothingStaged()
	assert.Zero(t, r.gh.Hits[FakeRepo+"/releases/download/"+PromotionTag("v1.4.130", 5)+"/"+stage.ManifestFile], "the older promotion was not even asked for")

	delete(r.gh.Status, newest)
	r.cfg.Now = func() time.Time { return time.Now().Add(time.Hour) }
	res = r.check()
	require.Equal(t, stage.ResultStaged, res.Result, "%+v", res)
	assert.Equal(t, "1.4.131", res.Version)
}

// A tagged promotion at or below the best verified one cannot beat it: its 404 is skipped and the verified one is staged.
func TestATaggedPromotionBelowAVerifiedOneThatAnswers404IsSkipped(t *testing.T) {
	r := newRig(t)
	r.publish(Spec{Version: "1.4.130", Sequence: 5})
	r.publish(Spec{Version: "1.4.131", Sequence: 8})
	r.gh.ServeRefs = true
	r.cfg.RefsURL = r.gh.RefsURL()
	r.gh.Status[PromotionTag("v1.4.130", 5)+"/"+stage.ManifestFile] = 404
	res := r.check()
	require.Equal(t, stage.ResultStaged, res.Result, "%+v", res)
	assert.Equal(t, "1.4.131", res.Version)
	assert.Empty(t, res.NextAttempt)
}

// A bare promote-* tag (no release made for it) with a higher sequence than the real promotions is junk: its files 404 and the by-tag lookup answers 404, so it is skipped and the real promotion
// is staged. (coral-hub's Security on #317.)
func TestABareTagAboveARealPromotionDoesNotBlockIt(t *testing.T) {
	r := newRig(t)
	r.publish(Spec{Version: "1.4.131", Sequence: 8})
	r.gh.ServeRefs = true
	r.cfg.RefsURL, r.cfg.ReleaseByTagURL = r.gh.RefsURL(), r.gh.ReleaseByTagURL()
	refs, err := json.Marshal([]map[string]string{{"ref": "refs/tags/" + PromotionTag("v1.4.131", 8)}, {"ref": "refs/tags/" + PromotionTag("v1.4.140", 99)}})
	require.NoError(t, err)
	r.gh.RefsBody = refs
	res := r.check()
	require.Equal(t, stage.ResultStaged, res.Result, "%+v", res)
	assert.Equal(t, "1.4.131", res.Version)
	assert.Equal(t, 1, r.gh.Hits["repos/"+FakeRepo+"/releases/tags/"+PromotionTag("v1.4.140", 99)], "one lookup, for the bare tag")
}

// A real release whose files 404 still stops the pass, and so does a lookup that fails: only a definite 404 of the release is "bare".
func TestARealReleaseWithNoFilesYetAndAFailedLookupBothStopThePass(t *testing.T) {
	for name, fail := range map[string]func(r *rig){
		"a real release, files not served yet": func(r *rig) {},
		"the by-tag lookup errs":               func(r *rig) { r.gh.Status["bytag"] = 503 },
	} {
		t.Run(name, func(t *testing.T) {
			r := newRig(t)
			r.publish(Spec{Version: "1.4.130", Sequence: 5})
			r.publish(Spec{Version: "1.4.131", Sequence: 8})
			r.gh.ServeRefs = true
			r.cfg.RefsURL, r.cfg.ReleaseByTagURL = r.gh.RefsURL(), r.gh.ReleaseByTagURL()
			if name != "a real release, files not served yet" {
				// the newest tag has no release the lookup can find, and its files 404; the lookup itself fails
				r.gh.RefsBody, _ = json.Marshal([]map[string]string{{"ref": "refs/tags/" + PromotionTag("v1.4.130", 5)}, {"ref": "refs/tags/" + PromotionTag("v1.4.140", 99)}})
			}
			fail(r)
			r.gh.Status[PromotionTag("v1.4.131", 8)+"/"+stage.ManifestFile] = 404
			r.gh.Status[PromotionTag("v1.4.140", 99)+"/"+stage.ManifestFile] = 404
			res := r.check()
			assert.Equal(t, stage.ResultFailed, res.Result, "%+v", res)
			assert.Equal(t, "manifest", res.FailedStage)
			r.nothingStaged()
		})
	}
}

// GitHub pages the tag list (30 by default, whatever per_page says): all of it is read, with the newest tag last. 31 and 101 tags, and a lookup that fills all five pages falls back to the list.
func TestThePromotionTagsAreReadAcrossPages(t *testing.T) {
	for _, c := range []struct {
		name     string
		tags     int
		pageSize int
	}{{"31 tags, pages of 30", 31, 30}, {"101 tags, pages of 100", 101, 100}} {
		t.Run(c.name, func(t *testing.T) {
			r := newRig(t)
			r.publish(Spec{Version: "1.4.131", Sequence: 1000}) // the newest by sequence; it sorts last by name too
			r.gh.ServeRefs = true
			r.gh.RefsPageSize = c.pageSize
			r.cfg.RefsURL = r.gh.RefsURL()
			var refs []map[string]string
			for n := 1; n < c.tags; n++ { // older, junk-by-files tags first
				refs = append(refs, map[string]string{"ref": "refs/tags/" + PromotionTag("v1.4.120", int64(n))})
			}
			refs = append(refs, map[string]string{"ref": "refs/tags/" + PromotionTag("v1.4.131", 1000)}) // the last of the list
			var err error
			r.gh.RefsBody, err = json.Marshal(refs)
			require.NoError(t, err)
			res := r.check()
			require.Equal(t, stage.ResultStaged, res.Result, "the last tag on the last page is found: %+v", res)
			assert.Equal(t, "1.4.131", res.Version)
		})
	}
}

func TestAFullFifthPageOfTagsFallsBackToTheList(t *testing.T) {
	r := newRig(t)
	r.publish(Spec{Version: "1.4.131", Sequence: 7})
	r.gh.ServeRefs = true
	r.gh.RefsPageSize = 1
	r.cfg.RefsURL = r.gh.RefsURL()
	var refs []map[string]string
	for n := 1; n <= 6; n++ { // more tags than five pages of one
		refs = append(refs, map[string]string{"ref": "refs/tags/" + PromotionTag("v1.4.120", int64(n))})
	}
	var err error
	r.gh.RefsBody, err = json.Marshal(refs)
	require.NoError(t, err)
	res := r.check()
	require.Equal(t, stage.ResultStaged, res.Result, "the releases list, which has the promotion, answered: %+v", res)
	assert.Positive(t, r.gh.Hits[listKey], "the list was asked")
}
