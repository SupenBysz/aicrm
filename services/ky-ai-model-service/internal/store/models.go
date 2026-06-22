package store

import (
	"encoding/json"
	"time"
)

type Provider struct {
	ID           string    `json:"id"`
	Name         string    `json:"name"`
	ProviderType string    `json:"providerType"`
	BaseURL      string    `json:"baseUrl"`
	HasAPIKey    bool      `json:"hasApiKey"`
	APIKeyMasked string    `json:"apiKeyMasked"`
	Status       string    `json:"status"`
	Remark       string    `json:"remark"`
	CreatedAt    time.Time `json:"createdAt"`
	UpdatedAt    time.Time `json:"updatedAt"`

	// APIKeyEncrypted is internal-only and never serialized to clients.
	APIKeyEncrypted string `json:"-"`
}

type Model struct {
	ID                string          `json:"id"`
	ProviderID        string          `json:"providerId"`
	Name              string          `json:"name"`
	ModelKey          string          `json:"modelKey"`
	ModelType         string          `json:"modelType"`
	ContextLength     int             `json:"contextLength"`
	DefaultParameters json.RawMessage `json:"defaultParameters"`
	Status            string          `json:"status"`
	Remark            string          `json:"remark"`
	CreatedAt         time.Time       `json:"createdAt"`
	UpdatedAt         time.Time       `json:"updatedAt"`
}

type Page struct {
	Page     int   `json:"page"`
	PageSize int   `json:"pageSize"`
	Total    int64 `json:"total"`
}
