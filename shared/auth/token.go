// Package auth is the single source of truth for KyaiCRM's HMAC-SHA256 bearer
// token: ky-auth-service signs (SignToken); all services verify (VerifyToken).
package auth

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"strings"
	"time"
)

// TokenPayload is the claim set signed into the bearer token.
type TokenPayload struct {
	UserID    string `json:"userId"`
	SessionID string `json:"sessionId"`
	Exp       int64  `json:"exp"`
}

// SignToken produces "<base64url(payload)>.<base64url(hmac)>".
func SignToken(secret string, payload TokenPayload) (string, error) {
	if secret == "" {
		return "", errors.New("token secret is required")
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return "", err
	}
	bodyPart := base64.RawURLEncoding.EncodeToString(body)
	sig := sign(secret, bodyPart)
	return bodyPart + "." + sig, nil
}

// VerifyToken validates the signature and expiry and returns the payload.
func VerifyToken(secret string, token string) (TokenPayload, error) {
	var payload TokenPayload
	if secret == "" {
		return payload, errors.New("token secret is required")
	}
	bodyPart, sigPart, ok := strings.Cut(token, ".")
	if !ok {
		return payload, errors.New("invalid token")
	}
	if !hmac.Equal([]byte(sign(secret, bodyPart)), []byte(sigPart)) {
		return payload, errors.New("invalid token signature")
	}
	body, err := base64.RawURLEncoding.DecodeString(bodyPart)
	if err != nil {
		return payload, err
	}
	if err := json.Unmarshal(body, &payload); err != nil {
		return payload, err
	}
	if payload.Exp <= time.Now().Unix() {
		return payload, errors.New("token expired")
	}
	return payload, nil
}

func sign(secret string, bodyPart string) string {
	mac := hmac.New(sha256.New, []byte(secret))
	_, _ = mac.Write([]byte(bodyPart))
	return base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}
