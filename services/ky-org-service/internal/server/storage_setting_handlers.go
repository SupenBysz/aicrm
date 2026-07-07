package server

import (
	"context"
	"net/http"
	"strings"
	"time"

	"github.com/Kysion/KyaiCRM/services/ky-org-service/internal/store"
	"github.com/minio/minio-go/v7"
	"github.com/minio/minio-go/v7/pkg/credentials"
)

func (s *Server) getStorageSetting(w http.ResponseWriter, r *http.Request, wc wsContext) {
	st, err := s.store.GetStorageSetting(r.Context())
	if err != nil {
		writeStoreError(w, r, err)
		return
	}
	writeData(w, r, st) // SecretEncrypted is json:"-"; only hasSecret is exposed
}

type storageSettingInput struct {
	ProviderKey     string `json:"providerKey"`
	Endpoint        string `json:"endpoint"`
	Region          string `json:"region"`
	Bucket          string `json:"bucket"`
	BucketPrivate   bool   `json:"bucketPrivate"`
	ForcePathStyle  bool   `json:"forcePathStyle"`
	Prefix          string `json:"prefix"`
	PublicDomain    string `json:"publicDomain"`
	AccessKeyID     string `json:"accessKeyId"`
	SecretAccessKey string `json:"secretAccessKey"` // optional; empty keeps existing
}

func (s *Server) updateStorageSetting(w http.ResponseWriter, r *http.Request, wc wsContext) {
	var in storageSettingInput
	if !decodeJSON(w, r, &in) {
		return
	}
	provider := strings.TrimSpace(in.ProviderKey)
	if provider == "" {
		provider = "s3"
	}
	secretEnc := ""
	if strings.TrimSpace(in.SecretAccessKey) != "" {
		if s.cipher == nil {
			writeError(w, r, http.StatusServiceUnavailable, "secret_unconfigured", "密钥服务未启用,无法保存密钥")
			return
		}
		enc, err := s.cipher.Encrypt(strings.TrimSpace(in.SecretAccessKey))
		if err != nil {
			writeError(w, r, http.StatusInternalServerError, "internal_error", "密钥加密失败")
			return
		}
		secretEnc = enc
	}
	st := store.StorageSetting{
		ProviderKey: provider, Endpoint: strings.TrimSpace(in.Endpoint), Region: strings.TrimSpace(in.Region),
		Bucket: strings.TrimSpace(in.Bucket), BucketPrivate: in.BucketPrivate, ForcePathStyle: in.ForcePathStyle,
		Prefix: strings.TrimSpace(in.Prefix), PublicDomain: strings.TrimSpace(in.PublicDomain),
		AccessKeyID: strings.TrimSpace(in.AccessKeyID),
	}
	if err := s.store.UpsertStorageSetting(r.Context(), st, secretEnc, wc.UserID); err != nil {
		writeStoreError(w, r, err)
		return
	}
	s.audit(r.Context(), r, wc, "storage_setting.updated", "storage_setting", "default", nil)
	out, err := s.store.GetStorageSetting(r.Context())
	if err != nil {
		writeStoreError(w, r, err)
		return
	}
	writeData(w, r, out)
}

type rotateSecretInput struct {
	SecretAccessKey string `json:"secretAccessKey"`
}

func (s *Server) rotateStorageSecret(w http.ResponseWriter, r *http.Request, wc wsContext) {
	var in rotateSecretInput
	if !decodeJSON(w, r, &in) {
		return
	}
	if strings.TrimSpace(in.SecretAccessKey) == "" {
		writeError(w, r, http.StatusBadRequest, "validation_error", "secretAccessKey 不能为空")
		return
	}
	if s.cipher == nil {
		writeError(w, r, http.StatusServiceUnavailable, "secret_unconfigured", "密钥服务未启用")
		return
	}
	enc, err := s.cipher.Encrypt(strings.TrimSpace(in.SecretAccessKey))
	if err != nil {
		writeError(w, r, http.StatusInternalServerError, "internal_error", "密钥加密失败")
		return
	}
	if err := s.store.RotateStorageSecret(r.Context(), enc, wc.UserID); err != nil {
		writeStoreError(w, r, err)
		return
	}
	s.audit(r.Context(), r, wc, "storage_setting.secret_rotated", "storage_setting", "default", nil)
	writeData(w, r, map[string]any{"hasSecret": true})
}

type storageTestResult struct {
	OK           bool   `json:"ok"`
	LatencyMs    int64  `json:"latencyMs"`
	ErrorMessage string `json:"errorMessage,omitempty"`
}

func (s *Server) testStorageSetting(w http.ResponseWriter, r *http.Request, wc wsContext) {
	st, err := s.store.GetStorageSetting(r.Context())
	if err != nil {
		writeStoreError(w, r, err)
		return
	}
	result := s.runStorageTest(r.Context(), st)
	status := "failed"
	if result.OK {
		status = "success"
	}
	_ = s.store.RecordStorageTest(r.Context(), status, result.ErrorMessage)
	s.audit(r.Context(), r, wc, "storage_setting.tested", "storage_setting", "default", map[string]any{"ok": result.OK})
	writeData(w, r, result)
}

func (s *Server) runStorageTest(ctx context.Context, st store.StorageSetting) storageTestResult {
	if st.Endpoint == "" || st.Bucket == "" {
		return storageTestResult{ErrorMessage: "请先填写 Endpoint 与 Bucket"}
	}
	if st.AccessKeyID == "" || st.SecretEncrypted == "" {
		return storageTestResult{ErrorMessage: "请先配置 AccessKey / SecretKey"}
	}
	if s.cipher == nil {
		return storageTestResult{ErrorMessage: "密钥服务未启用,无法测试"}
	}
	secret, err := s.cipher.Decrypt(st.SecretEncrypted)
	if err != nil {
		return storageTestResult{ErrorMessage: "SecretKey 解密失败,请重新配置"}
	}

	endpoint := st.Endpoint
	secure := true
	if strings.HasPrefix(endpoint, "https://") {
		endpoint = strings.TrimPrefix(endpoint, "https://")
	} else if strings.HasPrefix(endpoint, "http://") {
		endpoint = strings.TrimPrefix(endpoint, "http://")
		secure = false
	}
	endpoint = strings.TrimRight(endpoint, "/")

	client, err := minio.New(endpoint, &minio.Options{
		Creds:        credentials.NewStaticV4(st.AccessKeyID, secret, ""),
		Secure:       secure,
		Region:       st.Region,
		BucketLookup: bucketLookup(st.ForcePathStyle),
	})
	if err != nil {
		return storageTestResult{ErrorMessage: "客户端初始化失败:" + err.Error()}
	}
	reqCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	start := time.Now()
	exists, err := client.BucketExists(reqCtx, st.Bucket)
	latency := time.Since(start).Milliseconds()
	if err != nil {
		return storageTestResult{LatencyMs: latency, ErrorMessage: "连接失败:" + err.Error()}
	}
	if !exists {
		return storageTestResult{LatencyMs: latency, ErrorMessage: "凭据有效,但 Bucket 不存在或无权限"}
	}
	return storageTestResult{OK: true, LatencyMs: latency}
}

func bucketLookup(forcePathStyle bool) minio.BucketLookupType {
	if forcePathStyle {
		return minio.BucketLookupPath
	}
	return minio.BucketLookupAuto
}
