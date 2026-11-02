package routes

import (
	"context"
	"log"

	"github.com/subgentic/coral/internal/skills"
	"github.com/subgentic/coral/internal/store"
)

// SeedStarterSkills puts the example skills Coral ships (internal/skills/starter, #12463) in the Skills Store: approved, published by Coral, on every start. A skill whose newest approved version holds the same
// bytes is left alone; one whose text changed with the program is added as a new version (an agent pinned to the old one keeps it). They go through the checks every skill goes through (the parser, the sign-in
// link and secret scans, the Markdown-only rule): one that fails any of them is logged and skipped, never stored. A skill of the same name that a person or an agent published is not touched, and none is made
// beside it. Best effort: a store that cannot be written is logged, and Coral starts anyway. The examples cannot be deleted (store.ErrStarterSkill).
func (h *SkillsHandler) SeedStarterSkills(ctx context.Context) {
	zips, err := skills.StarterZips()
	if err != nil {
		log.Printf("[skills] the example skills could not be read: %v", err)
		return
	}
	rows, err := h.ss.ListSkills(ctx, "")
	if err != nil {
		log.Printf("[skills] the example skills were not added: %v", err)
		return
	}
	for _, z := range zips {
		sk, err := skills.Parse(z.Data)
		if err != nil {
			log.Printf("[skills] the example skill %s is not valid: %v", z.Name, err)
			continue
		}
		if f := fileWithSignInLink(sk); f != "" {
			log.Printf("[skills] the example skill %s holds a sign-in link in %s: skipped", z.Name, skillFileName(f))
			continue
		}
		if f, rerr := heldSecret(sk); rerr != nil || f != "" {
			log.Printf("[skills] the example skill %s holds what looks like a secret or could not be checked: skipped", z.Name)
			continue
		}
		taken, current := false, false
		for _, r := range rows {
			if r.Name != sk.Name {
				continue
			}
			if r.PublisherKind != store.PublisherCoral {
				taken = true // a person's or an agent's skill of this name: theirs
			} else if r.Status == store.SkillApproved && r.Digest == sk.Digest {
				current = true
			}
		}
		if taken || current {
			continue
		}
		created, err := h.saveSkillZip(sk.Digest, z.Data)
		if err != nil {
			log.Printf("[skills] the example skill %s could not be kept: %v", z.Name, err)
			continue
		}
		if _, _, err := h.ss.AddSkill(ctx, store.AddSkillInput{Skill: sk, Digest: sk.Digest, Kind: store.PublisherCoral}); err != nil {
			if created {
				h.dropSkillZip(sk.Digest)
			}
			log.Printf("[skills] the example skill %s was not added: %v", z.Name, err)
		}
	}
}
