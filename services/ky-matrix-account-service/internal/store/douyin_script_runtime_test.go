package store

import (
	"errors"
	"reflect"
	"testing"
)

func runtimeInput(identifier string) DouyinScriptInput {
	return DouyinScriptInput{Identifier: identifier, Name: "脚本", MatchType: "exact", MatchURL: "https://example.com"}
}

func TestDouyinScriptRuntimeDefaultsForLegacyInput(t *testing.T) {
	in, err := normalizeDouyinScriptInput(runtimeInput("legacy"))
	if err != nil {
		t.Fatal(err)
	}
	if in.RunAt != DefaultDouyinScriptRunAt || in.Priority == nil || *in.Priority != DefaultDouyinScriptPriority {
		t.Fatalf("unexpected defaults: runAt=%q priority=%v", in.RunAt, in.Priority)
	}
	update, err := normalizeDouyinScriptUpdateInput(runtimeInput("legacy"))
	if err != nil {
		t.Fatal(err)
	}
	if update.RunAt != DefaultDouyinScriptRunAt || update.Priority == nil || *update.Priority != DefaultDouyinScriptPriority {
		t.Fatalf("new update defaults must use document_start: %+v", update)
	}
}

func TestDouyinScriptRuntimeValidation(t *testing.T) {
	for _, runAt := range []string{"document_start", "dom_content_loaded", "document_idle", "load", "spa_route_change", "user_action"} {
		in := runtimeInput("valid-" + runAt)
		in.RunAt = runAt
		if _, err := normalizeDouyinScriptInput(in); err != nil {
			t.Fatalf("runAt %q rejected: %v", runAt, err)
		}
	}
	for _, runAt := range []string{"document_end", "execute_script"} {
		in := runtimeInput("bad-run-at")
		in.RunAt = runAt
		_, err := normalizeDouyinScriptInput(in)
		var fieldErr *DouyinScriptInputError
		if !errors.As(err, &fieldErr) || fieldErr.Field != "runAt" {
			t.Fatalf("runAt %q did not return field validation: %v", runAt, err)
		}
	}
	for _, priority := range []int{MinDouyinScriptPriority, MaxDouyinScriptPriority, 0, 1000} {
		in := runtimeInput("priority")
		in.Priority = &priority
		if _, err := normalizeDouyinScriptInput(in); err != nil {
			t.Fatalf("priority %d rejected: %v", priority, err)
		}
	}
	for _, priority := range []int{MinDouyinScriptPriority - 1, MaxDouyinScriptPriority + 1} {
		in := runtimeInput("bad-priority")
		in.Priority = &priority
		_, err := normalizeDouyinScriptInput(in)
		var fieldErr *DouyinScriptInputError
		if !errors.As(err, &fieldErr) || fieldErr.Field != "priority" {
			t.Fatalf("priority %d did not return field validation: %v", priority, err)
		}
	}
}

func TestDouyinScriptCandidateSortAndWorkspaceIsolation(t *testing.T) {
	items := []DouyinScript{
		{ID: "z", WorkspaceType: "platform", WorkspaceID: "other", Status: "enabled", EffectiveVersionID: "v", RunAt: "document_start", Priority: 0, Identifier: "a"},
		{ID: "4", WorkspaceType: "platform", WorkspaceID: "root", Status: "enabled", EffectiveVersionID: "v", RunAt: "load", Priority: 1, Identifier: "z"},
		{ID: "3", WorkspaceType: "platform", WorkspaceID: "root", Status: "enabled", EffectiveVersionID: "v", RunAt: "document_start", Priority: 10, Identifier: "z"},
		{ID: "2", WorkspaceType: "platform", WorkspaceID: "root", Status: "enabled", EffectiveVersionID: "v", RunAt: "document_start", Priority: 10, Identifier: "a"},
		{ID: "1", WorkspaceType: "platform", WorkspaceID: "root", Status: "disabled", EffectiveVersionID: "v", RunAt: "document_start", Priority: -1, Identifier: "first"},
		{ID: "5", WorkspaceType: "platform", WorkspaceID: "root", Status: "enabled", RunAt: "document_idle", Priority: 1, Identifier: "missing-version"},
	}
	got := sortDouyinScriptCandidates(items, "platform", "root")
	want := []string{"2", "3", "4"}
	ids := make([]string, 0, len(got))
	for _, item := range got {
		ids = append(ids, item.ID)
	}
	if !reflect.DeepEqual(ids, want) {
		t.Fatalf("candidate order=%v want=%v", ids, want)
	}
	for _, item := range got {
		if item.WorkspaceID != "root" {
			t.Fatalf("workspace isolation failed: %+v", item)
		}
	}
}
