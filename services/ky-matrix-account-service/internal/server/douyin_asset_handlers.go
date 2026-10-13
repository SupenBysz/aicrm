package server

import (
	"log"
	"net/http"
	"strings"

	"github.com/Kysion/KyaiCRM/services/ky-matrix-account-service/internal/store"
)

func assetType(r *http.Request) string { return strings.TrimSpace(r.URL.Query().Get("assetType")) }

func (s *Server) listDouyinAssets(w http.ResponseWriter, r *http.Request, wc wsContext) {
	items, err := s.store.ListDouyinAssets(r.Context(), wc.WorkspaceType, wc.WorkspaceID, r.PathValue("id"), assetType(r))
	if err != nil {
		log.Printf("抖店资产列表查询失败 request=%s script=%s assetType=%s err=%v", requestID(r), r.PathValue("id"), assetType(r), err)
		writeStoreError(w, r, err)
		return
	}
	writeData(w, r, items)
}

func (s *Server) getDouyinAsset(w http.ResponseWriter, r *http.Request, wc wsContext) {
	content := r.URL.Query().Get("content") == "1"
	if content {
		ok, err := s.store.HasAny(r.Context(), wc.MembershipID, []string{"platform.matrix_account_douyin_scripts.content_view"})
		if err != nil || !ok {
			writeError(w, r, http.StatusForbidden, "permission_denied", "当前身份无权查看源码")
			return
		}
	}
	item, err := s.store.GetDouyinAsset(r.Context(), wc.WorkspaceType, wc.WorkspaceID, r.PathValue("id"), r.PathValue("assetId"), content)
	if err != nil {
		writeStoreError(w, r, err)
		return
	}
	writeData(w, r, item)
}

func (s *Server) createDouyinAsset(w http.ResponseWriter, r *http.Request, wc wsContext) {
	key, ok := scriptCommandKey(w, r)
	if !ok {
		return
	}
	var in store.DouyinAssetInput
	if !decodeJSON(w, r, &in) {
		return
	}
	item, err := s.store.CreateDouyinAsset(r.Context(), wc.WorkspaceType, wc.WorkspaceID, r.PathValue("id"), wc.UserID, key, in)
	if err != nil {
		writeStoreError(w, r, err)
		return
	}
	s.audit(r.Context(), r, wc, "matrix_account.douyin_asset_created", "matrix_account_douyin_script_asset_version", item.ID, map[string]any{"scriptId": item.ScriptID, "assetType": item.AssetType, "sourceSha256": item.SourceSHA256})
	writeData(w, r, item)
}

func (s *Server) copyDouyinAsset(w http.ResponseWriter, r *http.Request, wc wsContext) {
	key, ok := scriptCommandKey(w, r)
	if !ok {
		return
	}
	item, err := s.store.CopyDouyinAsset(r.Context(), wc.WorkspaceType, wc.WorkspaceID, r.PathValue("id"), r.PathValue("assetId"), wc.UserID, key)
	if err != nil {
		writeStoreError(w, r, err)
		return
	}
	s.audit(r.Context(), r, wc, "matrix_account.douyin_asset_copied", "matrix_account.douyin_script_asset_version", item.ID, map[string]any{"sourceAssetId": r.PathValue("assetId"), "assetType": item.AssetType})
	writeData(w, r, item)
}

func (s *Server) updateDouyinAsset(w http.ResponseWriter, r *http.Request, wc wsContext) {
	key, ok := scriptCommandKey(w, r)
	if !ok {
		return
	}
	rev, ok := expectedRevision(r)
	if !ok {
		writeError(w, r, http.StatusBadRequest, "validation_error", "缺少 expected revision")
		return
	}
	var in store.DouyinAssetInput
	if !decodeJSON(w, r, &in) {
		return
	}
	item, err := s.store.UpdateDouyinAsset(r.Context(), wc.WorkspaceType, wc.WorkspaceID, r.PathValue("id"), r.PathValue("assetId"), wc.UserID, key, rev, in)
	if err != nil {
		writeStoreError(w, r, err)
		return
	}
	s.audit(r.Context(), r, wc, "matrix_account.douyin_asset_updated", "matrix_account.douyin_script_asset_version", item.ID, map[string]any{"assetType": item.AssetType, "expectedRevision": rev, "sourceSha256": item.SourceSHA256})
	writeData(w, r, item)
}

func (s *Server) changeDouyinAssetState(w http.ResponseWriter, r *http.Request, wc wsContext, action string) {
	key, ok := scriptCommandKey(w, r)
	if !ok {
		return
	}
	rev, ok := expectedRevision(r)
	if !ok {
		writeError(w, r, http.StatusBadRequest, "validation_error", "缺少 expected revision")
		return
	}
	item, err := s.store.ChangeDouyinAssetState(r.Context(), wc.WorkspaceType, wc.WorkspaceID, r.PathValue("id"), r.PathValue("assetId"), wc.UserID, key, rev, action)
	if err != nil {
		writeStoreError(w, r, err)
		return
	}
	s.audit(r.Context(), r, wc, "matrix_account.douyin_asset_"+action, "matrix_account.douyin_script_asset_version", item.ID, map[string]any{"assetType": item.AssetType, "expectedRevision": rev})
	writeData(w, r, item)
}

func (s *Server) releaseDouyinAsset(w http.ResponseWriter, r *http.Request, wc wsContext) {
	s.changeDouyinAssetState(w, r, wc, "release")
}

func (s *Server) activateDouyinAsset(w http.ResponseWriter, r *http.Request, wc wsContext) {
	s.changeDouyinAssetState(w, r, wc, "activate")
}

func (s *Server) archiveDouyinAsset(w http.ResponseWriter, r *http.Request, wc wsContext) {
	s.changeDouyinAssetState(w, r, wc, "archive")
}
