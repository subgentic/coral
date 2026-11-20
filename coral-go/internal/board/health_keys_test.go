package board

import (
	"encoding/json"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// Every number of HealthSettings says what it accepts: a setting added without its range fails here, so `show` never prints a blank range.
func TestEveryHealthKeyThatIsANumberOrTextSaysWhatItAccepts(t *testing.T) {
	for _, k := range HealthKeys(DefaultHealthSettings()) {
		if k.Kind == "int" || (k.Kind == "text" || k.Kind == "list") && !k.Free || k.Kind == "text" && k.Free {
			assert.NotEmpty(t, k.Range, "%s has no words for what it accepts (healthKeyRanges / healthKeyWords)", k.Key)
		}
	}
}

func TestEveryRuleHasATextLevelAndARecipientKey(t *testing.T) {
	have := map[string]bool{}
	for _, k := range HealthKeys(DefaultHealthSettings()) {
		have[k.Key] = true
	}
	for rule := range (&HealthSettings{}).ruleRoutes() {
		assert.True(t, have[rule+".text"], rule+".text")
		assert.True(t, have[rule+".to"], rule+".to")
	}
	for _, k := range []string{"off_books.post_grace_min", "off_books.max_lines", "pool_review.after_min", "wait_escalate.after_min", "unowned_tasks.max_list"} {
		assert.True(t, have[k], k)
	}
}

func TestAHealthPatchIsNestedAndTyped(t *testing.T) {
	p, err := HealthPatchFor("landing.wait_min", "240")
	require.NoError(t, err)
	raw, _ := json.Marshal(p)
	assert.JSONEq(t, `{"landing":{"wait_min":240}}`, string(raw))
	p, err = HealthPatchFor("goal_size.on", "off")
	require.NoError(t, err)
	raw, _ = json.Marshal(p)
	assert.JSONEq(t, `{"goal_size":{"on":false}}`, string(raw))
	_, err = HealthPatchFor("landing.wait_min", "soon")
	assert.ErrorContains(t, err, "not a whole number")
	_, err = HealthPatchFor("nope.x", "1")
	assert.ErrorContains(t, err, "not a health setting")
}

func TestTheNewDefaultsAreTheFixedNumbersTheyReplace(t *testing.T) {
	h := DefaultHealthSettings().Clamp()
	assert.Equal(t, 2, h.OffBooks.PostGraceMin)
	assert.Equal(t, 5, h.OffBooks.MaxLines)
	assert.Equal(t, 15, h.PoolReview.AfterMin)
	assert.Equal(t, 10, h.WaitEscalate.AfterMin)
	assert.Equal(t, 8, h.UnownedTasks.MaxList)
	var stored HealthSettings // a body that carries none of them: the defaults, not the shortest
	assert.Equal(t, 5, stored.Clamp().OffBooks.MaxLines)
	assert.Equal(t, TextNormal, stored.Clamp().Landing.Level())
}
