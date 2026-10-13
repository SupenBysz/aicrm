package server

import (
	"context"
	"crypto/rand"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/Kysion/KyaiCRM/services/ky-org-service/internal/store"
	"github.com/minio/minio-go/v7"
	"github.com/minio/minio-go/v7/pkg/credentials"
)

var storageProviders = map[string]struct{}{"local": {}, "minio": {}, "oss": {}}

func validStorageProvider(key string) bool { _, ok := storageProviders[key]; return ok }

func ensureLocalStorageDirectory(path string) error {
	if err := os.MkdirAll(path, 0750); err != nil {
		return fmt.Errorf("目录创建失败: %w", err)
	}
	probe, err := os.CreateTemp(path, ".kww-storage-permission-")
	if err != nil {
		return fmt.Errorf("目录无读写权限: %w", err)
	}
	probeName := probe.Name()
	if err := probe.Close(); err != nil {
		_ = os.Remove(probeName)
		return fmt.Errorf("目录写入检查失败: %w", err)
	}
	if err := os.Remove(probeName); err != nil {
		return fmt.Errorf("目录清理检查失败: %w", err)
	}
	return nil
}

func (s *Server) getStorageSetting(w http.ResponseWriter, r *http.Request, wc wsContext) {
	settings, err := s.store.GetStorageSettings(r.Context())
	if err != nil {
		writeStoreError(w, r, err)
		return
	}
	writeData(w, r, settings)
}

type storageSettingInput struct {
	ProviderKey     string `json:"providerKey"`
	LocalDirectory  string `json:"localDirectory"`
	Endpoint        string `json:"endpoint"`
	Region          string `json:"region"`
	Bucket          string `json:"bucket"`
	BucketPrivate   bool   `json:"bucketPrivate"`
	ForcePathStyle  bool   `json:"forcePathStyle"`
	Prefix          string `json:"prefix"`
	PublicDomain    string `json:"publicDomain"`
	AccessKeyID     string `json:"accessKeyId"`
	SecretAccessKey string `json:"secretAccessKey"`
}

func (s *Server) updateStorageSetting(w http.ResponseWriter, r *http.Request, wc wsContext) {
	var in storageSettingInput
	if !decodeJSON(w, r, &in) {
		return
	}
	provider := strings.TrimSpace(in.ProviderKey)
	if provider == "s3" {
		provider = "minio"
	}
	if !validStorageProvider(provider) {
		writeError(w, r, http.StatusBadRequest, "validation_error", "存储类型无效")
		return
	}
	if provider == "local" {
		if strings.TrimSpace(in.LocalDirectory) == "" {
			writeError(w, r, http.StatusBadRequest, "validation_error", "请输入存储目录")
			return
		}
		if err := ensureLocalStorageDirectory(strings.TrimSpace(in.LocalDirectory)); err != nil {
			writeError(w, r, http.StatusBadRequest, "storage_directory_unavailable", err.Error())
			return
		}
	} else if strings.TrimSpace(in.Endpoint) == "" || strings.TrimSpace(in.Bucket) == "" {
		writeError(w, r, http.StatusBadRequest, "validation_error", "请输入 Endpoint 与 Bucket")
		return
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
	st := store.StorageSetting{ProviderKey: provider, LocalDirectory: strings.TrimSpace(in.LocalDirectory), Endpoint: strings.TrimSpace(in.Endpoint), Region: strings.TrimSpace(in.Region), Bucket: strings.TrimSpace(in.Bucket), BucketPrivate: in.BucketPrivate, ForcePathStyle: in.ForcePathStyle, Prefix: strings.TrimSpace(in.Prefix), PublicDomain: strings.TrimSpace(in.PublicDomain), AccessKeyID: strings.TrimSpace(in.AccessKeyID)}
	if err := s.store.UpsertStorageSetting(r.Context(), st, secretEnc, wc.UserID); err != nil {
		writeStoreError(w, r, err)
		return
	}
	s.audit(r.Context(), r, wc, "storage_setting.updated", "storage_setting", provider, nil)
	s.writeStorageSettings(w, r)
}

func (s *Server) writeStorageSettings(w http.ResponseWriter, r *http.Request) {
	settings, err := s.store.GetStorageSettings(r.Context())
	if err != nil {
		writeStoreError(w, r, err)
		return
	}
	writeData(w, r, settings)
}

func (s *Server) activateStorageProvider(w http.ResponseWriter, r *http.Request, wc wsContext) {
	var in struct {
		ProviderKey string `json:"providerKey"`
	}
	if !decodeJSON(w, r, &in) || !validStorageProvider(in.ProviderKey) {
		writeError(w, r, http.StatusBadRequest, "validation_error", "存储类型无效")
		return
	}
	settings, err := s.store.GetStorageSettings(r.Context())
	if err != nil {
		writeStoreError(w, r, err)
		return
	}
	st := settings.Providers[in.ProviderKey]
	if in.ProviderKey == "local" && strings.TrimSpace(st.LocalDirectory) == "" || in.ProviderKey != "local" && (st.Endpoint == "" || st.Bucket == "" || st.AccessKeyID == "" || !st.HasSecret) {
		writeError(w, r, http.StatusBadRequest, "validation_error", "请先完整保存当前存储配置")
		return
	}
	if st.LastTestStatus != "success" || st.ConfigFingerprint == "" || st.TestFingerprint == "" || st.ConfigFingerprint != st.TestFingerprint {
		writeError(w, r, http.StatusBadRequest, "storage_not_tested", "请先测试连接成功后再设为当前存储")
		return
	}
	if in.ProviderKey == "local" {
		if err := ensureLocalStorageDirectory(st.LocalDirectory); err != nil {
			writeError(w, r, http.StatusBadRequest, "storage_directory_unavailable", err.Error())
			return
		}
	}
	if err := s.store.SetActiveStorageProvider(r.Context(), in.ProviderKey, wc.UserID); err != nil {
		writeStoreError(w, r, err)
		return
	}
	s.audit(r.Context(), r, wc, "storage_setting.activated", "storage_setting", in.ProviderKey, nil)
	s.writeStorageSettings(w, r)
}

type rotateSecretInput struct {
	ProviderKey     string `json:"providerKey"`
	SecretAccessKey string `json:"secretAccessKey"`
}

func (s *Server) rotateStorageSecret(w http.ResponseWriter, r *http.Request, wc wsContext) {
	var in rotateSecretInput
	if !decodeJSON(w, r, &in) || !validStorageProvider(in.ProviderKey) || in.ProviderKey == "local" || strings.TrimSpace(in.SecretAccessKey) == "" {
		writeError(w, r, http.StatusBadRequest, "validation_error", "请输入有效的云存储类型和新密钥")
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
	if err := s.store.RotateStorageSecret(r.Context(), in.ProviderKey, enc, wc.UserID); err != nil {
		writeStoreError(w, r, err)
		return
	}
	s.audit(r.Context(), r, wc, "storage_setting.secret_rotated", "storage_setting", in.ProviderKey, nil)
	writeData(w, r, map[string]any{"hasSecret": true})
}

type storageTestResult struct {
	OK           bool   `json:"ok"`
	LatencyMs    int64  `json:"latencyMs"`
	ErrorCode    string `json:"errorCode,omitempty"`
	ErrorMessage string `json:"errorMessage,omitempty"`
}

func (s *Server) testStorageSetting(w http.ResponseWriter, r *http.Request, wc wsContext) {
	var in struct {
		ProviderKey string `json:"providerKey"`
	}
	if !decodeJSON(w, r, &in) || !validStorageProvider(in.ProviderKey) {
		writeError(w, r, http.StatusBadRequest, "validation_error", "请选择存储类型")
		return
	}
	st, err := s.store.GetStorageSetting(r.Context(), in.ProviderKey)
	if err != nil {
		writeStoreError(w, r, err)
		return
	}
	result := s.runStorageTest(r.Context(), st)
	status := "failed"
	if result.OK {
		status = "success"
	}
	_ = s.store.RecordStorageTest(r.Context(), in.ProviderKey, status, result.ErrorMessage)
	s.audit(r.Context(), r, wc, "storage_setting.tested", "storage_setting", in.ProviderKey, map[string]any{"ok": result.OK})
	writeData(w, r, result)
}

func (s *Server) runStorageTest(ctx context.Context, st store.StorageSetting) storageTestResult {
	start := time.Now()
	if st.ProviderKey == "local" {
		if st.LocalDirectory == "" {
			return storageTestResult{ErrorCode: "directory_missing", ErrorMessage: "请先填写存储目录"}
		}
		if err := ensureLocalStorageDirectory(st.LocalDirectory); err != nil {
			return storageTestResult{ErrorCode: "write_failed", ErrorMessage: err.Error()}
		}
		var token [16]byte
		_, _ = rand.Read(token[:])
		path := filepath.Join(st.LocalDirectory, ".kww-write-test-"+fmt.Sprintf("%x", token))
		if err := os.WriteFile(path, []byte("kww-storage-test"), 0600); err != nil {
			return storageTestResult{ErrorCode: "write_failed", ErrorMessage: "测试写入失败"}
		}
		_ = os.Remove(path)
		return storageTestResult{OK: true, LatencyMs: time.Since(start).Milliseconds()}
	}
	if st.Endpoint == "" || st.Bucket == "" {
		return storageTestResult{ErrorCode: "config_missing", ErrorMessage: "请先填写 Endpoint 与 Bucket"}
	}
	if st.AccessKeyID == "" || st.SecretEncrypted == "" {
		return storageTestResult{ErrorCode: "secret_missing", ErrorMessage: "请先配置 AccessKey 与密钥"}
	}
	if s.cipher == nil {
		return storageTestResult{ErrorCode: "secret_unconfigured", ErrorMessage: "密钥服务未启用,无法测试"}
	}
	secret, err := s.cipher.Decrypt(st.SecretEncrypted)
	if err != nil {
		return storageTestResult{ErrorCode: "secret_invalid", ErrorMessage: "密钥解密失败,请重新配置"}
	}
	endpoint := strings.TrimRight(strings.TrimPrefix(strings.TrimPrefix(st.Endpoint, "https://"), "http://"), "/")
	client, err := minio.New(endpoint, &minio.Options{Creds: credentials.NewStaticV4(st.AccessKeyID, secret, ""), Secure: strings.HasPrefix(st.Endpoint, "https://"), Region: st.Region, BucketLookup: bucketLookup(st.ForcePathStyle)})
	if err != nil {
		return storageTestResult{ErrorCode: "connection_failed", ErrorMessage: "连接初始化失败"}
	}
	reqCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	exists, err := client.BucketExists(reqCtx, st.Bucket)
	if err != nil {
		return storageTestResult{LatencyMs: time.Since(start).Milliseconds(), ErrorCode: "connection_failed", ErrorMessage: "连接失败或无权限"}
	}
	if !exists {
		return storageTestResult{LatencyMs: time.Since(start).Milliseconds(), ErrorCode: "bucket_missing", ErrorMessage: "Bucket 不存在"}
	}
	return storageTestResult{OK: true, LatencyMs: time.Since(start).Milliseconds()}
}

func bucketLookup(forcePathStyle bool) minio.BucketLookupType {
	if forcePathStyle {
		return minio.BucketLookupPath
	}
	return minio.BucketLookupAuto
}
