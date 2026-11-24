package board

import (
	"context"
	"testing"

	"github.com/subgentic/coral/internal/reviewsize"
)

func TestReviewSizeSettingDefaultsOffAndRoundTrips(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	got, err := s.GetReviewSizeSetting(ctx, "team")
	if err != nil || got.On {
		t.Fatalf("default: %+v %v", got, err)
	}
	saved, err := s.SetReviewSizeSetting(ctx, "team", reviewsize.Setting{On: true, Lines: 800, Files: 20, Skip: []string{" *.lock ", "*.lock"}, OnlyRoles: []string{"Lead Developer"}})
	if err != nil || len(saved.Skip) != 1 {
		t.Fatalf("save: %+v %v", saved, err)
	}
	got, err = s.GetReviewSizeSetting(ctx, "team")
	if err != nil || !got.On || got.Lines != 800 || got.Files != 20 || got.Skip[0] != "*.lock" || got.OnlyRoles[0] != "Lead Developer" {
		t.Fatalf("read back: %+v %v", got, err)
	}
	if other, _ := s.GetReviewSizeSetting(ctx, "other"); other.On {
		t.Fatal("a setting is per team")
	}
	if _, err := s.SetReviewSizeSetting(ctx, "team", reviewsize.Setting{On: true}); err == nil {
		t.Fatal("on with no limit was saved")
	}
	if got, _ = s.GetReviewSizeSetting(ctx, "team"); got.Lines != 800 {
		t.Fatalf("a refused save changed the stored setting: %+v", got)
	}
}

func TestReviewSizeSettingThatCannotBeReadIsAnErrorNotOff(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	if err := s.SetBoardSetting(ctx, "team", settingReviewSize, "{not json"); err != nil {
		t.Fatal(err)
	}
	if _, err := s.GetReviewSizeSetting(ctx, "team"); err == nil {
		t.Fatal("a broken value read as off")
	}
}
