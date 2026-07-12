package store

import (
	"encoding/json"
	"os"
	"strings"
	"testing"
)

func TestLoginScriptGenerationArtifactSeparatesCandidatesAndContractTests(t *testing.T) {
	for _, operation := range []string{loginScriptGenerationOperationGenerate, loginScriptGenerationOperationRepair} {
		artifact, err := loginScriptGenerationArtifact(operation)
		if err != nil || artifact != loginScriptGenerationArtifactCandidate {
			t.Fatalf("operation %q = %q, %v; want candidate", operation, artifact, err)
		}
		if err := validateLoginScriptCandidateMaterialization(operation, "succeeded"); err != nil {
			t.Fatalf("operation %q should be allowed to create candidate: %v", operation, err)
		}
		if err := validateLoginScriptCandidateMaterialization(operation, "failed"); err != ErrValidation {
			t.Fatalf("failed operation %q must not create candidate, got %v", operation, err)
		}
	}

	artifact, err := loginScriptGenerationArtifact(loginScriptGenerationOperationContractTest)
	if err != nil || artifact != loginScriptGenerationArtifactContractTestResult {
		t.Fatalf("contract_test = %q, %v; want contract_test_result", artifact, err)
	}
	if err := validateLoginScriptGenerationMaterialization(loginScriptGenerationOperationContractTest, "succeeded", loginScriptGenerationArtifactContractTestResult); err != nil {
		t.Fatalf("successful contract_test should create only its test result: %v", err)
	}
	if err := validateLoginScriptCandidateMaterialization(loginScriptGenerationOperationContractTest, "succeeded"); err != ErrValidation {
		t.Fatalf("contract_test must not create candidate, got %v", err)
	}
	if _, err := loginScriptGenerationArtifact("unknown"); err != ErrValidation {
		t.Fatalf("unknown operation must be rejected, got %v", err)
	}
}

func TestValidateLoginScriptActivationGateRequiresMatchingPassedContract(t *testing.T) {
	if err := validateLoginScriptActivationGate(validLoginScriptActivationGate()); err != nil {
		t.Fatalf("valid activation facts should pass: %v", err)
	}

	tests := map[string]func(*loginScriptActivationGate){
		"missing test":              func(g *loginScriptActivationGate) { g.LatestTest = loginScriptActivationTestResult{} },
		"failed test":               func(g *loginScriptActivationGate) { g.LatestTest.Status = "failed" },
		"failed test run":           func(g *loginScriptActivationGate) { g.LatestTest.RunStatus = "failed" },
		"candidate mismatch":        func(g *loginScriptActivationGate) { g.LatestTest.CandidateVersionID = "version_other" },
		"candidate not candidate":   func(g *loginScriptActivationGate) { g.Candidate.Status = "active" },
		"unknown candidate source":  func(g *loginScriptActivationGate) { g.Candidate.Source = "unknown" },
		"unfinished generation run": func(g *loginScriptActivationGate) { g.Candidate.GenerationRunStatus = "running" },
		"contract test created candidate": func(g *loginScriptActivationGate) {
			g.Candidate.GenerationOperation = loginScriptGenerationOperationContractTest
		},
		"stale expected script revision":    func(g *loginScriptActivationGate) { g.ExpectedScriptRevision-- },
		"stale candidate script revision":   func(g *loginScriptActivationGate) { g.Candidate.ScriptRevision-- },
		"stale tested script revision":      func(g *loginScriptActivationGate) { g.LatestTest.ScriptRevision-- },
		"stale expected contract revision":  func(g *loginScriptActivationGate) { g.ExpectedContractRevision-- },
		"stale candidate contract revision": func(g *loginScriptActivationGate) { g.Candidate.ContractRevision-- },
		"stale tested contract revision":    func(g *loginScriptActivationGate) { g.LatestTest.ContractRevision-- },
		"contract mismatch":                 func(g *loginScriptActivationGate) { g.LatestTest.ContractID = "contract_other" },
		"contract disabled":                 func(g *loginScriptActivationGate) { g.ContractStatus = "disabled" },
		"required method missing": func(g *loginScriptActivationGate) {
			g.ContractMethods = []string{"detectLoginCompleted", "getAccountIdentity"}
		},
		"low stability only": func(g *loginScriptActivationGate) {
			g.Candidate.DSL = json.RawMessage(`{"version":1,"purpose":"account_detect","steps":[{"action":"readElementKey","elementKey":"account-id","keySource":"platform_semantic","stability":"low","resultKey":"identityKey"},{"action":"readElementKey","elementKey":"nickname","keySource":"a11y_role_name","stability":"low","resultKey":"nickname"}]}`)
		},
		"coordinate": func(g *loginScriptActivationGate) {
			g.Candidate.DSL = json.RawMessage(`{"version":1,"purpose":"account_detect","steps":[{"action":"readElementKey","elementKey":"account-id","keySource":"platform_semantic","stability":"high","resultKey":"identityKey","x":20},{"action":"readElementKey","elementKey":"nickname","keySource":"a11y_role_name","stability":"medium","resultKey":"nickname"}]}`)
		},
	}
	for name, mutate := range tests {
		t.Run(name, func(t *testing.T) {
			gate := validLoginScriptActivationGate()
			mutate(&gate)
			if err := validateLoginScriptActivationGate(gate); err != ErrValidation {
				t.Fatalf("expected ErrValidation, got %v", err)
			}
		})
	}
}

func TestValidateLoginScriptActivationGateAllowsContractTestedManualCandidate(t *testing.T) {
	gate := validLoginScriptActivationGate()
	gate.Candidate.Source = "manual"
	gate.Candidate.GenerationOperation = ""
	gate.Candidate.GenerationRunStatus = ""
	if err := validateLoginScriptActivationGate(gate); err != nil {
		t.Fatalf("contract-tested manual candidate should pass the same activation gate: %v", err)
	}
}

func TestCandidateAutomaticActivationRequiresStableElementKeyAndRecordedFallback(t *testing.T) {
	valid := json.RawMessage(`{
		"version":1,
		"purpose":"qr_login_refresh",
		"steps":[
			{"action":"clickElementKey","elementKey":"refresh-qr","keySource":"platform_semantic","stability":"high"},
			{"action":"clickSelector","selector":"[data-action=refresh]","stability":"low","fallbackReason":"stable key unavailable on legacy layout"},
			{"action":"captureElementKey","elementKey":"login-qr","keySource":"a11y_role_name","stability":"medium","resultKey":"qrCodeDataUrl"}
		]
	}`)
	if err := validateLoginScriptCandidateForAutomaticActivation(valid, "qr_login_refresh"); err != nil {
		t.Fatalf("stable candidate with recorded fallback should pass: %v", err)
	}

	missingReason := json.RawMessage(`{
		"version":1,
		"purpose":"qr_login_refresh",
		"steps":[
			{"action":"clickElementKey","elementKey":"refresh-qr","keySource":"platform_semantic","stability":"high"},
			{"action":"clickSelector","selector":"[data-action=refresh]","stability":"low"},
			{"action":"captureElementKey","elementKey":"login-qr","keySource":"a11y_role_name","stability":"medium","resultKey":"qrCodeDataUrl"}
		]
	}`)
	if err := validateLoginScriptCandidateForAutomaticActivation(missingReason, "qr_login_refresh"); err != ErrValidation {
		t.Fatalf("fallback without reason must be rejected, got %v", err)
	}

	fallbackOnly := json.RawMessage(`{"version":1,"purpose":"account_detect","steps":[{"action":"readText","selector":"[data-account-id]","stability":"low","fallbackReason":"no stable key","resultKey":"identityKey"}]}`)
	if err := validateLoginScriptCandidateForAutomaticActivation(fallbackOnly, "account_detect"); err != ErrValidation {
		t.Fatalf("critical candidate relying only on low-stability fallback must be rejected, got %v", err)
	}

	sensitiveLocator := json.RawMessage(`{"version":1,"purpose":"account_detect","steps":[{"action":"readElementKey","elementKey":"session-token","keySource":"platform_semantic","stability":"high","resultKey":"identityKey"},{"action":"readElementKey","elementKey":"nickname","keySource":"a11y_role_name","stability":"high","resultKey":"nickname"}]}`)
	if err := validateLoginScriptCandidateForAutomaticActivation(sensitiveLocator, "account_detect"); err != ErrValidation {
		t.Fatalf("credential-like locator must be rejected, got %v", err)
	}

	sensitiveField := json.RawMessage(`{"version":1,"purpose":"account_detect","steps":[{"action":"readElementKey","elementKey":"account-id","keySource":"platform_semantic","stability":"high","resultKey":"identityKey","storage":"cookie"},{"action":"readElementKey","elementKey":"nickname","keySource":"a11y_role_name","stability":"high","resultKey":"nickname"}]}`)
	if err := validateLoginScriptCandidateForAutomaticActivation(sensitiveField, "account_detect"); err != ErrValidation {
		t.Fatalf("hidden sensitive field must be rejected, got %v", err)
	}
}

func TestCandidateAutomaticActivationUsesLockedElementKeyAndResultSemantics(t *testing.T) {
	for _, source := range []string{"platform_semantic", "a11y_role_name", "stable_id_name", "scoped_text", "structural_selector"} {
		if !validStableElementKeySource(source) {
			t.Fatalf("locked key source %q should be accepted", source)
		}
	}
	for _, source := range []string{"accessible", "stable_attribute", "container_text", "coordinate", ""} {
		if validStableElementKeySource(source) {
			t.Fatalf("unlocked key source %q should be rejected", source)
		}
	}

	validSession := json.RawMessage(`{"version":1,"purpose":"session_check","steps":[{"action":"readElementKey","elementKey":"login-state","keySource":"stable_id_name","stability":"high","resultKey":"loginCompleted"}]}`)
	if err := validateLoginScriptCandidateForAutomaticActivation(validSession, "session_check"); err != nil {
		t.Fatalf("stable login completion result should pass: %v", err)
	}

	missingSessionResult := json.RawMessage(`{"version":1,"purpose":"session_check","steps":[{"action":"readElementKey","elementKey":"login-state","keySource":"stable_id_name","stability":"high","resultKey":"phase"}]}`)
	if err := validateLoginScriptCandidateForAutomaticActivation(missingSessionResult, "session_check"); err != ErrValidation {
		t.Fatalf("session_check without loginPhase/loginCompleted must be rejected, got %v", err)
	}

	homeURLOnlyIdentity := json.RawMessage(`{"version":1,"purpose":"account_detect","steps":[{"action":"readElementKey","elementKey":"profile-link","keySource":"platform_semantic","stability":"high","resultKey":"homeUrl"},{"action":"readElementKey","elementKey":"nickname","keySource":"a11y_role_name","stability":"high","resultKey":"nickname"}]}`)
	if err := validateLoginScriptCandidateForAutomaticActivation(homeURLOnlyIdentity, "account_detect"); err != ErrValidation {
		t.Fatalf("homeUrl must not substitute for stable identityKey/platformUid, got %v", err)
	}
}

func TestCandidatePersistenceAllowsSafeLowStabilityButRejectsSensitiveUnknownFields(t *testing.T) {
	lowStability := json.RawMessage(`{
		"version":1,
		"purpose":"account_detect",
		"steps":[
			{"action":"readElementKey","elementKey":"account-id","keySource":"platform_semantic","stability":"low","resultKey":"identityKey"},
			{"action":"readElementKey","elementKey":"nickname","keySource":"a11y_role_name","stability":"low","resultKey":"nickname"}
		]
	}`)
	if err := validateLoginScriptCandidateForPersistence(lowStability, "account_detect"); err != nil {
		t.Fatalf("safe low-stability candidate should be persisted for contract testing: %v", err)
	}
	if err := validateLoginScriptCandidateForAutomaticActivation(lowStability, "account_detect"); err != ErrValidation {
		t.Fatalf("safe low-stability candidate must not auto-activate, got %v", err)
	}
	if err := validateExecutableLoginScriptDSL(lowStability, "account_detect"); err != ErrValidation {
		t.Fatalf("current runtime must not claim future ElementKey candidate support, got %v", err)
	}

	for _, field := range []string{
		"cookie", "localStorage", "indexedDB", "accessToken", "password", "credential",
		"proof", "receipt", "verificationReceipt", "snapshotProof", "cleanupProof",
		"javascript", "xpath", "coordinates",
	} {
		t.Run(field, func(t *testing.T) {
			var value map[string]any
			if err := json.Unmarshal(lowStability, &value); err != nil {
				t.Fatal(err)
			}
			steps, ok := value["steps"].([]any)
			if !ok || len(steps) == 0 {
				t.Fatal("candidate steps fixture invalid")
			}
			step, ok := steps[0].(map[string]any)
			if !ok {
				t.Fatal("candidate step fixture invalid")
			}
			step[field] = map[string]any{"safeWrapper": map[string]any{"value": "CANARY"}}
			raw, err := json.Marshal(value)
			if err != nil {
				t.Fatal(err)
			}
			if err := validateLoginScriptCandidateForPersistence(raw, "account_detect"); err != ErrValidation {
				t.Fatalf("nested sensitive field %q must be rejected before persistence, got %v", field, err)
			}
		})
	}

	for name, raw := range map[string]json.RawMessage{
		"unknown root field": json.RawMessage(`{"version":1,"purpose":"account_detect","notes":"innocuous","steps":[{"action":"readElementKey","elementKey":"account-id","keySource":"platform_semantic","stability":"low","resultKey":"identityKey"}]}`),
		"unknown step field": json.RawMessage(`{"version":1,"purpose":"account_detect","steps":[{"action":"readElementKey","elementKey":"account-id","keySource":"platform_semantic","stability":"low","resultKey":"identityKey","debugLabel":"innocuous"}]}`),
	} {
		t.Run(name, func(t *testing.T) {
			if err := validateLoginScriptCandidateForPersistence(raw, "account_detect"); err != ErrValidation {
				t.Fatalf("unknown candidate field must be rejected, got %v", err)
			}
		})
	}

	sensitiveAction := json.RawMessage(`{"version":1,"purpose":"account_detect","steps":[{"action":"readStorage","storage":"localStorage","key":"account","resultKey":"identityKey"}]}`)
	if err := validateLoginScriptCandidateForPersistence(sensitiveAction, "account_detect"); err != ErrValidation {
		t.Fatalf("sensitive candidate action must be rejected, got %v", err)
	}
}

func TestGeneratedCandidateRunsPersistencePolicyBeforeStartingWriteTransaction(t *testing.T) {
	source, err := os.ReadFile("login_script_store.go")
	if err != nil {
		t.Fatal(err)
	}
	text := string(source)
	start := strings.Index(text, "func (s *Store) CreateGeneratedLoginScriptCandidate(")
	end := strings.Index(text, "func (s *Store) ListWebSpaceLoginScriptRuns(")
	if start < 0 || end <= start {
		t.Fatal("CreateGeneratedLoginScriptCandidate source section not found")
	}
	section := text[start:end]
	validation := strings.Index(section, "validateLoginScriptCandidateForPersistence")
	beginTransaction := strings.Index(section, "s.db.BeginTx")
	insertCandidate := strings.Index(section, "INSERT INTO ky_matrix_account_login_script_version")
	if validation < 0 || beginTransaction < 0 || insertCandidate < 0 || validation > beginTransaction || validation > insertCandidate {
		t.Fatal("candidate persistence policy must run before transaction and candidate insert")
	}
}

func TestAutomaticLoginScriptRepairBudgetIsExactlyOne(t *testing.T) {
	if !canStartAutomaticLoginScriptRepair(0) {
		t.Fatal("first automatic repair should be allowed")
	}
	for _, attempted := range []int{-1, 1, 2} {
		if canStartAutomaticLoginScriptRepair(attempted) {
			t.Fatalf("attempted repairs %d should be rejected", attempted)
		}
	}
}

func validLoginScriptActivationGate() loginScriptActivationGate {
	const (
		scriptID   = "script_account_detect"
		versionID  = "version_candidate"
		contractID = "contract_douyin_account_detect"
	)
	return loginScriptActivationGate{
		ScriptID:                 scriptID,
		CurrentScriptRevision:    7,
		ExpectedScriptRevision:   7,
		ContractID:               contractID,
		ContractStatus:           "enabled",
		CurrentContractRevision:  3,
		ExpectedContractRevision: 3,
		ContractMethods:          []string{"detectLoginCompleted", "getAccountIdentity", "getAccountProfile"},
		Candidate: loginScriptActivationCandidate{
			ScriptID:            scriptID,
			VersionID:           versionID,
			Source:              "ai_generated",
			Status:              "candidate",
			Purpose:             "account_detect",
			GenerationOperation: loginScriptGenerationOperationRepair,
			GenerationRunStatus: "succeeded",
			ContractID:          contractID,
			ContractRevision:    3,
			ScriptRevision:      7,
			DSL: json.RawMessage(`{
				"version":1,
				"purpose":"account_detect",
				"steps":[
					{"action":"readElementKey","elementKey":"account-id","keySource":"platform_semantic","stability":"high","resultKey":"identityKey"},
					{"action":"readElementKey","elementKey":"nickname","keySource":"a11y_role_name","stability":"medium","resultKey":"nickname"}
				]
			}`),
		},
		LatestTest: loginScriptActivationTestResult{
			CandidateVersionID: versionID,
			ScriptID:           scriptID,
			ScriptRevision:     7,
			ContractID:         contractID,
			ContractRevision:   3,
			RunStatus:          "succeeded",
			Status:             "passed",
		},
	}
}
