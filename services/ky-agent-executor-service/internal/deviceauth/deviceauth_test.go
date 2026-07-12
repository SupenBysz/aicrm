package deviceauth

import (
	"crypto/ed25519"
	"encoding/base64"
	"errors"
	"net/http"
	"strings"
	"testing"
	"time"
)

const (
	vectorPublicKey   = "A6EHv_POEL4dcN0Y50vAmWfk1jCbpQ1fHdyGZBJVMbg"
	vectorDeviceID    = "56475aa75463474c0285df5dbf2bcab73da651358839e9b77481b2eab107708c"
	vectorPath        = "/api/v1/ai-executor-authorization-sessions/authsession_1/desktop-handoffs/handoff_1/claim"
	vectorTimestamp   = int64(1783814400123)
	vectorNonce       = "AAECAwQFBgcICQoLDA0ODw"
	vectorBody        = `{"handoffId":"handoff_1","claimedAt":"2026-07-12T00:00:00Z"}`
	vectorBodyHash    = "76cbc68fdaa606ecadfc3b5ce68256b1433ab2be332f847a6bb86e245e55eb17"
	vectorToken       = "eyJhbGciOiJFZERTQSJ9.eyJwdXJwb3NlIjoiYXV0aG9yaXphdGlvbiJ9.c2lnbmF0dXJl"
	vectorTokenHash   = "3f946b6e7e496dfe18ff3b6d9bce87b7fcfe96e10c12e04faa0c1d790d364fb3"
	vectorSignature   = "z8gBKdlISOQwHDoWdihJDCM-wQWgDeyW3JtB4mLCqtgM6xdWLr6FCy8j2554bdtc0NKkASMTADWnU2Oa6pGqAg"
	vectorRequestHash = "8cea6e51fd24c5c79b75e38a6467721e366fdb6770457c3f1170b062c8b91367"
)

const vectorSigningInput = "AICRM-DEVICE-V1\n" +
	"POST\n" +
	vectorPath + "\n" +
	"1783814400123\n" +
	vectorNonce + "\n" +
	"42\n" +
	vectorBodyHash + "\n" +
	vectorTokenHash

func TestRawEd25519KeyAndDeviceIDVector(t *testing.T) {
	seed := make([]byte, ed25519.SeedSize)
	for index := range seed {
		seed[index] = byte(index)
	}
	privateKey := ed25519.NewKeyFromSeed(seed)
	publicKey := privateKey.Public().(ed25519.PublicKey)

	encoded, err := EncodePublicKey(publicKey)
	if err != nil {
		t.Fatal(err)
	}
	if encoded != vectorPublicKey {
		t.Fatalf("public key vector mismatch: %s", encoded)
	}
	parsed, err := ParsePublicKey(vectorPublicKey)
	if err != nil {
		t.Fatal(err)
	}
	deviceID, err := DeviceID(parsed)
	if err != nil {
		t.Fatal(err)
	}
	if deviceID != vectorDeviceID {
		t.Fatalf("device ID vector mismatch: %s", deviceID)
	}
	if err := MatchDeviceID(parsed, vectorDeviceID); err != nil {
		t.Fatal(err)
	}
	signature := ed25519.Sign(privateKey, []byte(vectorSigningInput))
	if base64.RawURLEncoding.EncodeToString(signature) != vectorSignature {
		t.Fatal("signature vector mismatch")
	}
	if err := VerifySignature(parsed, []byte(vectorSigningInput), signature); err != nil {
		t.Fatal(err)
	}
	for _, invalid := range []string{vectorPublicKey + "=", "AAECAw", "not+base64url"} {
		if _, err := ParsePublicKey(invalid); !errors.Is(err, ErrInvalidPublicKey) {
			t.Errorf("public key %q was not rejected: %v", invalid, err)
		}
	}
	if err := MatchDeviceID(parsed, strings.Repeat("0", 64)); !errors.Is(err, ErrDeviceIDMismatch) {
		t.Fatalf("mismatched device ID was not rejected: %v", err)
	}
}

func TestCanonicalPathAcceptsOnlyOriginalASCIIResourcePath(t *testing.T) {
	path, err := CanonicalPath(vectorPath)
	if err != nil || path != vectorPath {
		t.Fatalf("canonical vector rejected: path=%q err=%v", path, err)
	}

	invalid := []string{
		"",
		"/",
		"relative/path",
		vectorPath + "/",
		"/api//v1/device",
		"/api/v1/./device",
		"/api/v1/../device",
		"/api/v1/device?after=1",
		"/api/v1/device#fragment",
		"/api/v1/device+other",
		"/api/v1/device%2Fother",
		"/api/v1/device\\other",
		"/api/v1/device name",
		"/api/v1/设备",
	}
	for _, value := range invalid {
		if _, err := CanonicalPath(value); !errors.Is(err, ErrInvalidCanonicalPath) {
			t.Errorf("path %q was not rejected: %v", value, err)
		}
	}
	for _, method := range []string{"post", "Post", "POST ", "P0ST", ""} {
		if _, err := CanonicalMethod(method); !errors.Is(err, ErrInvalidMethod) {
			t.Errorf("method %q was not rejected: %v", method, err)
		}
	}
}

func TestHeaderBodyTokenAndSigningInputVector(t *testing.T) {
	headers := vectorHeaders()
	proof, err := ParseProofHeaders(headers)
	if err != nil {
		t.Fatal(err)
	}
	if proof.DeviceID != vectorDeviceID || proof.TimestampMilli != vectorTimestamp || proof.Nonce != vectorNonce || proof.Sequence != 42 {
		t.Fatalf("proof header vector mismatch: %+v", proof)
	}
	if HashBody([]byte(vectorBody)) != vectorBodyHash {
		t.Fatal("body hash vector mismatch")
	}
	tokenHash, err := AuthorizationTokenHash("AiCRM-Handoff "+vectorToken, []string{"AiCRM-Handoff"})
	if err != nil || tokenHash != vectorTokenHash {
		t.Fatalf("token hash vector mismatch: hash=%s err=%v", tokenHash, err)
	}
	signingInput, err := SigningInput("POST", vectorPath, proof, tokenHash)
	if err != nil {
		t.Fatal(err)
	}
	if string(signingInput) != vectorSigningInput {
		t.Fatalf("signing input mismatch:\n%s", signingInput)
	}
	if RequestHash(signingInput) != vectorRequestHash {
		t.Fatal("request hash vector mismatch")
	}
	if strings.HasSuffix(string(signingInput), "\n") {
		t.Fatal("signing input has a trailing newline")
	}
}

func TestEmptyAuthorizationHashIsAnEmptyEighthSigningField(t *testing.T) {
	proof := ProofHeaders{
		DeviceID:       vectorDeviceID,
		TimestampMilli: vectorTimestamp,
		Nonce:          vectorNonce,
		Sequence:       1,
		BodySHA256:     HashBody(nil),
	}
	input, err := SigningInput(
		"POST",
		"/api/v1/ai-executor-devices/device_1/heartbeat",
		proof,
		"",
	)
	if err != nil {
		t.Fatal(err)
	}
	expected := "AICRM-DEVICE-V1\n" +
		"POST\n" +
		"/api/v1/ai-executor-devices/device_1/heartbeat\n" +
		"1783814400123\n" +
		vectorNonce + "\n" +
		"1\n" +
		"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855\n"
	if string(input) != expected {
		t.Fatalf("empty authorization field vector mismatch:\n%s", input)
	}
}

func TestVerifyRequestVector(t *testing.T) {
	verified, err := VerifyRequest(vectorVerifyInput())
	if err != nil {
		t.Fatal(err)
	}
	expected := VerifiedRequest{
		DeviceID:               vectorDeviceID,
		TimestampMilli:         vectorTimestamp,
		Nonce:                  vectorNonce,
		Sequence:               42,
		BodySHA256:             vectorBodyHash,
		AuthorizationTokenHash: vectorTokenHash,
		CanonicalMethod:        "POST",
		CanonicalPath:          vectorPath,
		RequestHash:            vectorRequestHash,
	}
	if verified != expected {
		t.Fatalf("verified request mismatch:\n got: %+v\nwant: %+v", verified, expected)
	}
	serialized := strings.Join([]string{
		verified.DeviceID,
		verified.Nonce,
		verified.BodySHA256,
		verified.AuthorizationTokenHash,
		verified.RequestHash,
	}, "|")
	if strings.Contains(serialized, vectorToken) || strings.Contains(serialized, vectorSignature) || strings.Contains(serialized, vectorBody) {
		t.Fatal("verified safe projection leaked raw request material")
	}
}

func TestPersistentLedgerVerificationDefersOnlyClockWindow(t *testing.T) {
	input := vectorVerifyInput()
	input.Now = time.UnixMilli(vectorTimestamp).Add(ClockWindow + time.Hour)
	if _, err := VerifyRequest(input); !errors.Is(err, ErrTimestampOutsideWindow) {
		t.Fatalf("ordinary verification accepted expired timestamp: %v", err)
	}
	verified, err := VerifyRequestForPersistentLedger(input)
	if err != nil || verified.RequestHash != vectorRequestHash {
		t.Fatalf("ledger verification=%#v err=%v", verified, err)
	}

	tampered := input
	tampered.Body = []byte(`{"handoffId":"tampered"}`)
	if _, err := VerifyRequestForPersistentLedger(tampered); !errors.Is(err, ErrBodyHashMismatch) {
		t.Fatalf("ledger verification accepted body tampering: %v", err)
	}
	tampered = input
	tampered.Headers = input.Headers.Clone()
	tampered.Headers.Set(HeaderSignature, strings.Repeat("A", 86))
	if _, err := VerifyRequestForPersistentLedger(tampered); !errors.Is(err, ErrInvalidSignature) {
		t.Fatalf("ledger verification accepted signature tampering: %v", err)
	}
}

func TestVerifyRequestFailsClosedForTamperingAndClockSkew(t *testing.T) {
	tests := []struct {
		name   string
		mutate func(*VerifyInput)
		want   error
	}{
		{
			name:   "body",
			mutate: func(input *VerifyInput) { input.Body = []byte(`{"handoffId":"other"}`) },
			want:   ErrBodyHashMismatch,
		},
		{
			name:   "authorization token",
			mutate: func(input *VerifyInput) { input.Headers.Set("Authorization", "AiCRM-Handoff other.token.value") },
			want:   ErrInvalidSignature,
		},
		{
			name:   "authorization scheme",
			mutate: func(input *VerifyInput) { input.AllowedAuthorizationSchemes = []string{"AiCRM-Claim"} },
			want:   ErrAuthorizationScheme,
		},
		{
			name:   "method",
			mutate: func(input *VerifyInput) { input.Method = "GET" },
			want:   ErrInvalidSignature,
		},
		{
			name:   "path",
			mutate: func(input *VerifyInput) { input.RequestTarget = strings.TrimSuffix(vectorPath, "/claim") + "/proof" },
			want:   ErrInvalidSignature,
		},
		{
			name:   "query string",
			mutate: func(input *VerifyInput) { input.RequestTarget = vectorPath + "?token=forbidden" },
			want:   ErrInvalidCanonicalPath,
		},
		{
			name:   "body digest header",
			mutate: func(input *VerifyInput) { input.Headers.Set(HeaderContentSHA256, strings.Repeat("0", 64)) },
			want:   ErrBodyHashMismatch,
		},
		{
			name:   "signature",
			mutate: func(input *VerifyInput) { input.Headers.Set(HeaderSignature, strings.Repeat("A", 86)) },
			want:   ErrInvalidSignature,
		},
		{
			name:   "different device",
			mutate: func(input *VerifyInput) { input.Headers.Set(HeaderDeviceID, strings.Repeat("0", 64)) },
			want:   ErrDeviceIDMismatch,
		},
		{
			name: "expired timestamp",
			mutate: func(input *VerifyInput) {
				input.Now = time.UnixMilli(vectorTimestamp).Add(ClockWindow + time.Millisecond)
			},
			want: ErrTimestampOutsideWindow,
		},
		{
			name: "future timestamp",
			mutate: func(input *VerifyInput) {
				input.Now = time.UnixMilli(vectorTimestamp).Add(-ClockWindow - time.Millisecond)
			},
			want: ErrTimestampOutsideWindow,
		},
		{
			name:   "duplicate nonce header",
			mutate: func(input *VerifyInput) { input.Headers.Add(HeaderNonce, vectorNonce) },
			want:   ErrInvalidHeader,
		},
		{
			name:   "duplicate authorization header",
			mutate: func(input *VerifyInput) { input.Headers.Add("Authorization", "AiCRM-Handoff "+vectorToken) },
			want:   ErrInvalidHeader,
		},
	}

	for _, testCase := range tests {
		t.Run(testCase.name, func(t *testing.T) {
			input := vectorVerifyInput()
			testCase.mutate(&input)
			if _, err := VerifyRequest(input); !errors.Is(err, testCase.want) {
				t.Fatalf("got %v, want %v", err, testCase.want)
			}
		})
	}

	for _, now := range []time.Time{
		time.UnixMilli(vectorTimestamp).Add(-ClockWindow),
		time.UnixMilli(vectorTimestamp).Add(ClockWindow),
	} {
		input := vectorVerifyInput()
		input.Now = now
		if _, err := VerifyRequest(input); err != nil {
			t.Fatalf("inclusive five-minute boundary rejected: %v", err)
		}
	}
}

func TestProofHeadersRejectNonCanonicalRepresentations(t *testing.T) {
	tests := []struct {
		name   string
		header string
		value  string
	}{
		{"uppercase device ID", HeaderDeviceID, strings.ToUpper(vectorDeviceID)},
		{"leading-zero timestamp", HeaderTimestamp, "01783814400123"},
		{"padded nonce", HeaderNonce, vectorNonce + "=="},
		{"short nonce", HeaderNonce, "AAECAw"},
		{"leading-zero sequence", HeaderSequence, "042"},
		{"zero sequence", HeaderSequence, "0"},
		{"uppercase digest", HeaderContentSHA256, strings.ToUpper(vectorBodyHash)},
		{"padded signature", HeaderSignature, vectorSignature + "="},
	}
	for _, testCase := range tests {
		t.Run(testCase.name, func(t *testing.T) {
			headers := vectorHeaders()
			headers.Set(testCase.header, testCase.value)
			if _, err := ParseProofHeaders(headers); !errors.Is(err, ErrInvalidHeader) {
				t.Fatalf("got %v", err)
			}
		})
	}
}

func TestAuthorizationTokenHashRequiresExactSafeHeaderAndEndpointScheme(t *testing.T) {
	if value, err := AuthorizationTokenHash("", nil); err != nil || value != "" {
		t.Fatalf("empty authorization mismatch: value=%q err=%v", value, err)
	}
	for _, header := range []string{
		"Bearer",
		" Bearer token",
		"Bearer token ",
		"Bearer  token",
		"Bearer token\nother",
		"Bearer töken",
	} {
		if _, err := AuthorizationTokenHash(header, []string{"Bearer"}); !errors.Is(err, ErrInvalidAuthorization) {
			t.Errorf("header %q was not rejected: %v", header, err)
		}
	}
	if _, err := AuthorizationTokenHash("Bearer token", nil); !errors.Is(err, ErrAuthorizationScheme) {
		t.Fatalf("missing scheme allowlist was not rejected: %v", err)
	}
}

func TestLedgerDecisionFollowsSequenceFirstReplayContract(t *testing.T) {
	request := vectorLedgerRequest()
	record := LedgerRecord{LedgerRequest: request, ResponseReference: "response_authsession_1"}

	decision, err := DecideLedgerRequest(request, LedgerState{
		Existing:             &record,
		NonceAlreadyUsed:     true,
		LastAcceptedSequence: 99,
	})
	if err != nil {
		t.Fatal(err)
	}
	if decision.Action != LedgerReturnRecorded || decision.ResponseReference != record.ResponseReference || decision.FailureCode != "" {
		t.Fatalf("exact replay did not return recorded response: %+v", decision)
	}

	for name, mutate := range map[string]func(*LedgerRequest){
		"request hash": func(value *LedgerRequest) { value.RequestHash = strings.Repeat("0", 64) },
		"nonce":        func(value *LedgerRequest) { value.Nonce = "AQIDBAUGBwgJCgsMDQ4PEA" },
		"token hash":   func(value *LedgerRequest) { value.AuthorizationTokenHash = strings.Repeat("f", 64) },
	} {
		t.Run(name, func(t *testing.T) {
			changed := request
			mutate(&changed)
			decision, err := DecideLedgerRequest(changed, LedgerState{Existing: &record})
			if err != nil {
				t.Fatal(err)
			}
			assertReplayRejected(t, decision, ReplayReasonSequenceConflict)
		})
	}

	decision, err = DecideLedgerRequest(request, LedgerState{NonceAlreadyUsed: true, LastAcceptedSequence: 41})
	if err != nil {
		t.Fatal(err)
	}
	assertReplayRejected(t, decision, ReplayReasonNonceConflict)

	decision, err = DecideLedgerRequest(request, LedgerState{LastAcceptedSequence: 42})
	if err != nil {
		t.Fatal(err)
	}
	assertReplayRejected(t, decision, ReplayReasonSequenceNotIncreasing)

	decision, err = DecideLedgerRequest(request, LedgerState{LastAcceptedSequence: 41})
	if err != nil {
		t.Fatal(err)
	}
	if decision != (LedgerDecision{Action: LedgerAcceptNew}) {
		t.Fatalf("new monotonic request was not accepted: %+v", decision)
	}
}

func TestLedgerDecisionRejectsInvalidInputOrMismatchedLookupState(t *testing.T) {
	request := vectorLedgerRequest()
	invalid := request
	invalid.Sequence = 0
	if _, err := DecideLedgerRequest(invalid, LedgerState{}); !errors.Is(err, ErrInvalidLedgerInput) {
		t.Fatalf("invalid input error mismatch: %v", err)
	}

	record := LedgerRecord{LedgerRequest: request, ResponseReference: "response_authsession_1"}
	record.KeyGeneration++
	if _, err := DecideLedgerRequest(request, LedgerState{Existing: &record}); !errors.Is(err, ErrInvalidLedgerState) {
		t.Fatalf("mismatched lookup state error mismatch: %v", err)
	}

	record = LedgerRecord{LedgerRequest: request}
	if _, err := DecideLedgerRequest(request, LedgerState{Existing: &record}); !errors.Is(err, ErrInvalidLedgerState) {
		t.Fatalf("missing response reference error mismatch: %v", err)
	}
}

func vectorHeaders() http.Header {
	headers := make(http.Header)
	headers.Set(HeaderDeviceID, vectorDeviceID)
	headers.Set(HeaderTimestamp, "1783814400123")
	headers.Set(HeaderNonce, vectorNonce)
	headers.Set(HeaderSequence, "42")
	headers.Set(HeaderContentSHA256, vectorBodyHash)
	headers.Set(HeaderSignature, vectorSignature)
	headers.Set("Authorization", "AiCRM-Handoff "+vectorToken)
	return headers
}

func vectorVerifyInput() VerifyInput {
	return VerifyInput{
		PublicKey:                   vectorPublicKey,
		Method:                      "POST",
		RequestTarget:               vectorPath,
		Headers:                     vectorHeaders(),
		Body:                        []byte(vectorBody),
		AllowedAuthorizationSchemes: []string{"AiCRM-Handoff"},
		Now:                         time.UnixMilli(vectorTimestamp),
	}
}

func vectorLedgerRequest() LedgerRequest {
	return LedgerRequest{
		DeviceID:               vectorDeviceID,
		KeyGeneration:          1,
		Sequence:               42,
		Nonce:                  vectorNonce,
		RequestHash:            vectorRequestHash,
		AuthorizationTokenHash: vectorTokenHash,
	}
}

func assertReplayRejected(t *testing.T, decision LedgerDecision, reason ReplayReason) {
	t.Helper()
	if decision.Action != LedgerRejectReplay || decision.FailureCode != DeviceProofReplayedCode || decision.Reason != reason || decision.ResponseReference != "" {
		t.Fatalf("unexpected replay decision: %+v", decision)
	}
}
