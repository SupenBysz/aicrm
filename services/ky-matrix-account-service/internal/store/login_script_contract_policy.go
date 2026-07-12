package store

import (
	"encoding/json"
	"strings"
)

const maxAutomaticLoginScriptRepairsPerAttempt = 1

const (
	loginScriptGenerationOperationGenerate     = "generate"
	loginScriptGenerationOperationRepair       = "repair"
	loginScriptGenerationOperationContractTest = "contract_test"

	loginScriptGenerationArtifactCandidate          = "candidate"
	loginScriptGenerationArtifactContractTestResult = "contract_test_result"
)

// candidateLoginScriptDSL is intentionally separate from executableLoginScriptDSL.
// Candidate persistence can describe future, contract-tested ElementKey actions
// without claiming that the currently shipped Desktop runtime can execute them.
type candidateLoginScriptDSL struct {
	Version int                        `json:"version"`
	Purpose string                     `json:"purpose"`
	Steps   []candidateLoginScriptStep `json:"steps"`
}

type candidateLoginScriptStep struct {
	Action         string `json:"action"`
	ElementKey     string `json:"elementKey"`
	KeySource      string `json:"keySource"`
	Stability      string `json:"stability"`
	FallbackReason string `json:"fallbackReason"`
	Selector       string `json:"selector"`
	Text           string `json:"text"`
	ResultKey      string `json:"resultKey"`
	TimeoutMs      *int64 `json:"timeoutMs"`
	Ms             *int64 `json:"ms"`
	URL            string `json:"url"`
}

type loginScriptActivationCandidate struct {
	ScriptID            string
	VersionID           string
	Source              string
	Status              string
	Purpose             string
	DSL                 json.RawMessage
	GenerationOperation string
	GenerationRunStatus string
	ContractID          string
	ContractRevision    int64
	ScriptRevision      int64
}

type loginScriptActivationTestResult struct {
	CandidateVersionID string
	ScriptID           string
	ScriptRevision     int64
	ContractID         string
	ContractRevision   int64
	RunStatus          string
	Status             string
}

type loginScriptActivationGate struct {
	ScriptID                 string
	CurrentScriptRevision    int64
	ExpectedScriptRevision   int64
	ContractID               string
	ContractStatus           string
	CurrentContractRevision  int64
	ExpectedContractRevision int64
	ContractMethods          []string
	Candidate                loginScriptActivationCandidate
	LatestTest               loginScriptActivationTestResult
}

// loginScriptGenerationArtifact returns the only artifact that an operation is
// permitted to materialize. Generate and repair may create a candidate. A
// contract test may only create a test result and must never create a candidate.
func loginScriptGenerationArtifact(operation string) (string, error) {
	switch strings.TrimSpace(operation) {
	case loginScriptGenerationOperationGenerate, loginScriptGenerationOperationRepair:
		return loginScriptGenerationArtifactCandidate, nil
	case loginScriptGenerationOperationContractTest:
		return loginScriptGenerationArtifactContractTestResult, nil
	default:
		return "", ErrValidation
	}
}

func validateLoginScriptGenerationMaterialization(operation, runStatus, artifact string) error {
	if runStatus != "succeeded" {
		return ErrValidation
	}
	expected, err := loginScriptGenerationArtifact(operation)
	if err != nil || artifact != expected {
		return ErrValidation
	}
	return nil
}

func validateLoginScriptCandidateMaterialization(operation, runStatus string) error {
	artifact, err := loginScriptGenerationArtifact(operation)
	if err != nil || artifact != loginScriptGenerationArtifactCandidate ||
		validateLoginScriptGenerationMaterialization(operation, runStatus, artifact) != nil {
		return ErrValidation
	}
	return nil
}

// validateLoginScriptActivationGate is deliberately a pure policy in P0. The
// activation HTTP handler remains fail-closed until schema-backed facts can be
// assembled in one revision-CAS transaction.
func validateLoginScriptActivationGate(gate loginScriptActivationGate) error {
	if strings.TrimSpace(gate.ScriptID) == "" ||
		gate.CurrentScriptRevision < 1 ||
		gate.ExpectedScriptRevision != gate.CurrentScriptRevision ||
		strings.TrimSpace(gate.ContractID) == "" ||
		gate.ContractStatus != "enabled" ||
		gate.CurrentContractRevision < 1 ||
		gate.ExpectedContractRevision != gate.CurrentContractRevision {
		return ErrValidation
	}

	candidate := gate.Candidate
	if candidate.ScriptID != gate.ScriptID ||
		strings.TrimSpace(candidate.VersionID) == "" ||
		!validLoginScriptCandidateSource(candidate.Source) ||
		candidate.Status != "candidate" ||
		candidate.ScriptRevision != gate.CurrentScriptRevision ||
		candidate.ContractID != gate.ContractID ||
		candidate.ContractRevision != gate.CurrentContractRevision {
		return ErrValidation
	}
	if candidate.Source == "ai_generated" &&
		validateLoginScriptCandidateMaterialization(candidate.GenerationOperation, candidate.GenerationRunStatus) != nil {
		return ErrValidation
	}
	if candidate.Source != "ai_generated" &&
		(strings.TrimSpace(candidate.GenerationOperation) != "" || strings.TrimSpace(candidate.GenerationRunStatus) != "") {
		return ErrValidation
	}
	if validateLoginScriptContractMethods(candidate.Purpose, gate.ContractMethods) != nil ||
		validateLoginScriptCandidateForAutomaticActivation(candidate.DSL, candidate.Purpose) != nil {
		return ErrValidation
	}

	test := gate.LatestTest
	if test.CandidateVersionID != candidate.VersionID ||
		test.ScriptID != gate.ScriptID ||
		test.ScriptRevision != gate.CurrentScriptRevision ||
		test.ContractID != gate.ContractID ||
		test.ContractRevision != gate.CurrentContractRevision ||
		test.RunStatus != "succeeded" ||
		test.Status != "passed" {
		return ErrValidation
	}
	return nil
}

func validateLoginScriptContractMethods(purpose string, methods []string) error {
	required := requiredLoginScriptContractMethods(purpose)
	if len(required) == 0 {
		return ErrValidation
	}
	present := make(map[string]struct{}, len(methods))
	for _, method := range methods {
		method = strings.TrimSpace(method)
		if method != "" {
			present[method] = struct{}{}
		}
	}
	for _, method := range required {
		if _, ok := present[method]; !ok {
			return ErrValidation
		}
	}
	return nil
}

func requiredLoginScriptContractMethods(purpose string) []string {
	switch purpose {
	case "qr_login_prepare", "qr_login_refresh", "session_check":
		return []string{"getQrCode", "refreshQrCode", "verifyQrCodeReadable", "detectLoginPhase"}
	case "account_detect":
		return []string{"detectLoginCompleted", "getAccountIdentity", "getAccountProfile"}
	default:
		return nil
	}
}

// validateLoginScriptCandidateForPersistence is the P0 write boundary. It
// permits a safe low-stability candidate to be recorded for later testing, but
// rejects credential/proof access and coordinate or arbitrary-script payloads
// before any script/version counter or candidate row is written.
func validateLoginScriptCandidateForPersistence(raw json.RawMessage, expectedPurpose string) error {
	if !loginScriptCandidateFieldsAllowed(raw) || containsForbiddenLoginScriptCandidateField(raw) {
		return ErrValidation
	}
	var dsl candidateLoginScriptDSL
	if err := json.Unmarshal(raw, &dsl); err != nil {
		return ErrValidation
	}
	if dsl.Version != 1 || dsl.Purpose != expectedPurpose || len(dsl.Steps) == 0 || len(dsl.Steps) > 40 {
		return ErrValidation
	}
	for _, step := range dsl.Steps {
		action := strings.TrimSpace(step.Action)
		if !validCandidateLoginScriptAction(action) ||
			containsSensitiveLoginScriptLocatorTerm(action) ||
			containsSensitiveLoginScriptLocatorTerm(step.ElementKey) ||
			containsSensitiveLoginScriptLocatorTerm(step.Selector) ||
			containsSensitiveLoginScriptLocatorTerm(step.Text) ||
			containsSensitiveLoginScriptLocatorTerm(step.ResultKey) ||
			containsSensitiveLoginScriptLocatorTerm(step.URL) {
			return ErrValidation
		}
		if isElementKeyAction(action) {
			if strings.TrimSpace(step.ElementKey) == "" ||
				!validStableElementKeySource(step.KeySource) ||
				!validRecordedStability(step.Stability) {
				return ErrValidation
			}
			continue
		}
		if isLocatorFallbackAction(action) &&
			(strings.TrimSpace(step.FallbackReason) == "" || !validRecordedStability(step.Stability)) {
			return ErrValidation
		}
	}
	return nil
}

func loginScriptCandidateFieldsAllowed(raw json.RawMessage) bool {
	var root map[string]json.RawMessage
	if err := json.Unmarshal(raw, &root); err != nil || root == nil {
		return false
	}
	rootFields := map[string]struct{}{"version": {}, "purpose": {}, "steps": {}}
	for field := range root {
		if _, ok := rootFields[field]; !ok {
			return false
		}
	}
	rawSteps, ok := root["steps"]
	if !ok {
		return false
	}
	var steps []map[string]json.RawMessage
	if err := json.Unmarshal(rawSteps, &steps); err != nil {
		return false
	}
	stepFields := map[string]struct{}{
		"action": {}, "elementKey": {}, "keySource": {}, "stability": {}, "fallbackReason": {},
		"selector": {}, "text": {}, "resultKey": {}, "timeoutMs": {}, "ms": {}, "url": {},
	}
	for _, step := range steps {
		if step == nil {
			return false
		}
		for field := range step {
			if _, ok := stepFields[field]; !ok {
				return false
			}
		}
	}
	return true
}

func validCandidateLoginScriptAction(action string) bool {
	return validExecutableLoginScriptAction(action) || isElementKeyAction(action)
}

func validateLoginScriptCandidateForAutomaticActivation(raw json.RawMessage, expectedPurpose string) error {
	if validateLoginScriptCandidateForPersistence(raw, expectedPurpose) != nil {
		return ErrValidation
	}
	var dsl candidateLoginScriptDSL
	if err := json.Unmarshal(raw, &dsl); err != nil {
		return ErrValidation
	}

	stableActions := make(map[string]int)
	resultKeys := make(map[string]struct{})
	for _, step := range dsl.Steps {
		action := strings.TrimSpace(step.Action)
		if isElementKeyAction(action) {
			if !validAutomaticActivationStability(step.Stability) {
				return ErrValidation
			}
			stableActions[action]++
			if key := strings.TrimSpace(step.ResultKey); key != "" {
				resultKeys[key] = struct{}{}
			}
			continue
		}
	}

	if !hasRequiredStableElementKeyActions(expectedPurpose, stableActions, resultKeys) {
		return ErrValidation
	}
	return nil
}

func validLoginScriptCandidateSource(source string) bool {
	switch source {
	case "ai_generated", "manual", "imported":
		return true
	default:
		return false
	}
}

func containsForbiddenLoginScriptCandidateField(raw json.RawMessage) bool {
	var value any
	if err := json.Unmarshal(raw, &value); err != nil {
		return true
	}
	var blocked func(any) bool
	blocked = func(current any) bool {
		switch typed := current.(type) {
		case map[string]any:
			for key, child := range typed {
				normalized := normalizeLoginScriptPolicyToken(key)
				if forbiddenLoginScriptCandidateField(normalized) || blocked(child) {
					return true
				}
			}
		case []any:
			for _, child := range typed {
				if blocked(child) {
					return true
				}
			}
		}
		return false
	}
	return blocked(value)
}

func forbiddenLoginScriptCandidateField(normalized string) bool {
	if normalized == "x" || normalized == "y" || normalized == "point" || normalized == "position" ||
		normalized == "screenx" || normalized == "screeny" || normalized == "clientx" || normalized == "clienty" {
		return true
	}
	for _, term := range []string{
		"cookie", "storage", "indexeddb", "token", "password", "passwd", "credential", "secret",
		"proof", "receipt", "verificationcode", "otp", "authorization", "sessionid", "uidtt",
		"javascript", "xpath", "coordinate",
	} {
		if strings.Contains(normalized, term) {
			return true
		}
	}
	return false
}

func containsSensitiveLoginScriptLocatorTerm(value string) bool {
	normalized := normalizeLoginScriptPolicyToken(value)
	if normalized == "" {
		return false
	}
	for _, term := range []string{
		"accesstoken", "refreshtoken", "token", "cookie", "localstorage", "sessionstorage",
		"indexeddb", "password", "passwd", "verificationcode", "credential", "secret", "sessionid", "uidtt",
		"proof", "receipt", "otp", "javascript", "xpath", "coordinate",
	} {
		if strings.Contains(normalized, term) {
			return true
		}
	}
	return false
}

func normalizeLoginScriptPolicyToken(value string) string {
	return strings.ToLower(strings.NewReplacer("_", "", "-", "", ".", "", ":", "", " ", "").Replace(strings.TrimSpace(value)))
}

func isElementKeyAction(action string) bool {
	switch action {
	case "clickElementKey", "waitForElementKey", "captureElementKey", "readElementKey":
		return true
	default:
		return false
	}
}

func isLocatorFallbackAction(action string) bool {
	switch action {
	case "clickText", "clickSelector", "waitForElement", "captureElement", "readText":
		return true
	default:
		return false
	}
}

func validStableElementKeySource(source string) bool {
	switch strings.TrimSpace(source) {
	case "platform_semantic", "a11y_role_name", "stable_id_name", "scoped_text", "structural_selector":
		return true
	default:
		return false
	}
}

func validAutomaticActivationStability(stability string) bool {
	return stability == "high" || stability == "medium"
}

func validRecordedStability(stability string) bool {
	return validAutomaticActivationStability(stability) || stability == "low"
}

func hasRequiredStableElementKeyActions(purpose string, actions map[string]int, resultKeys map[string]struct{}) bool {
	switch purpose {
	case "qr_login_prepare":
		_, qrResult := resultKeys["qrCodeDataUrl"]
		return actions["captureElementKey"] > 0 && qrResult
	case "qr_login_refresh":
		_, qrResult := resultKeys["qrCodeDataUrl"]
		return actions["clickElementKey"] > 0 && actions["captureElementKey"] > 0 && qrResult
	case "session_check":
		return actions["readElementKey"] > 0 && hasLoginPhaseResultKey(resultKeys)
	case "account_detect":
		return actions["readElementKey"] > 0 && hasIdentityResultKey(resultKeys) && hasProfileResultKey(resultKeys)
	default:
		return false
	}
}

func hasIdentityResultKey(resultKeys map[string]struct{}) bool {
	for _, key := range []string{"identityKey", "platformUid"} {
		if _, ok := resultKeys[key]; ok {
			return true
		}
	}
	return false
}

func hasLoginPhaseResultKey(resultKeys map[string]struct{}) bool {
	for _, key := range []string{"loginPhase", "loginCompleted"} {
		if _, ok := resultKeys[key]; ok {
			return true
		}
	}
	return false
}

func hasProfileResultKey(resultKeys map[string]struct{}) bool {
	for _, key := range []string{"displayName", "nickname", "avatarUrl", "homeUrl"} {
		if _, ok := resultKeys[key]; ok {
			return true
		}
	}
	return false
}

func canStartAutomaticLoginScriptRepair(attemptedRepairs int) bool {
	return attemptedRepairs >= 0 && attemptedRepairs < maxAutomaticLoginScriptRepairsPerAttempt
}
