package auth

import (
	"testing"
	"time"
)

func TestSignVerify_RoundTrip(t *testing.T) {
	secret := "test-secret"
	token, err := SignToken(secret, TokenPayload{UserID: "user_1", SessionID: "sess_1", Exp: time.Now().Add(time.Hour).Unix()})
	if err != nil {
		t.Fatalf("sign: %v", err)
	}
	got, err := VerifyToken(secret, token)
	if err != nil {
		t.Fatalf("verify: %v", err)
	}
	if got.UserID != "user_1" || got.SessionID != "sess_1" {
		t.Fatalf("unexpected payload: %+v", got)
	}
}

func TestVerifyToken_Expired(t *testing.T) {
	secret := "test-secret"
	token, _ := SignToken(secret, TokenPayload{UserID: "user_1", SessionID: "sess_1", Exp: time.Now().Add(-time.Minute).Unix()})
	if _, err := VerifyToken(secret, token); err == nil {
		t.Fatal("expected expired error")
	}
}

func TestVerifyToken_BadSignature(t *testing.T) {
	token, _ := SignToken("secret-a", TokenPayload{UserID: "u", SessionID: "s", Exp: time.Now().Add(time.Hour).Unix()})
	if _, err := VerifyToken("secret-b", token); err == nil {
		t.Fatal("expected signature error")
	}
}

func TestVerifyToken_MissingSecret(t *testing.T) {
	if _, err := VerifyToken("", "x.y"); err == nil {
		t.Fatal("expected missing-secret error")
	}
}

func TestVerifyToken_Malformed(t *testing.T) {
	if _, err := VerifyToken("s", "no-dot-here"); err == nil {
		t.Fatal("expected malformed-token error")
	}
}
