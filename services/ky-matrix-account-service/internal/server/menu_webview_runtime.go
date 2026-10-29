package server

import (
	"net/http"
	"net/url"
	"strings"

	"github.com/Kysion/KyaiCRM/services/ky-matrix-account-service/internal/store"
)

// resolveMenuWebViewRuntime is an authenticated, workspace-scoped desktop
// endpoint. It authorizes the active menu permission before resolving any
// private or public source assets.
func (s *Server) resolveMenuWebViewRuntime(w http.ResponseWriter, r *http.Request, wc wsContext) {
	directoryType, menuKey := r.PathValue("directoryType"), r.PathValue("menuKey")
	if directoryType != "management" && directoryType != "workbench" {
		writeError(w, r, http.StatusBadRequest, "validation_error", "菜单目录类型无效")
		return
	}
	config, err := s.store.ResolveMenuWebViewRuntimeConfig(r.Context(), wc.MembershipID, wc.WorkspaceType, wc.WorkspaceID, directoryType, menuKey)
	if err != nil {
		if err == store.ErrNotFound {
			writeError(w, r, http.StatusNotFound, "not_found", "菜单不可用或当前身份无权访问")
			return
		}
		if err == store.ErrValidation {
			writeError(w, r, http.StatusConflict, "menu_config_invalid", "菜单运行配置无效")
			return
		}
		writeStoreError(w, r, err)
		return
	}
	var request struct {
		URL string `json:"url"`
	}
	if !decodeScriptRuntimeJSON(w, r, &request) {
		return
	}
	requestedURL := strings.TrimSpace(request.URL)
	if requestedURL == "" {
		requestedURL = config.DefaultURL
	}
	parsedURL, parseErr := url.ParseRequestURI(requestedURL)
	if parseErr != nil || parsedURL == nil || parsedURL.Host == "" || parsedURL.User != nil || (parsedURL.Scheme != "http" && parsedURL.Scheme != "https") || !containsString(config.NavigationProtocols, parsedURL.Scheme) {
		writeError(w, r, http.StatusBadRequest, "INVALID_URL", "页面地址或导航协议未获准")
		return
	}
	in := store.ScriptRuntimeResolveRequest{
		Platform: config.Platform, URL: requestedURL,
		WorkspaceType: wc.WorkspaceType, WorkspaceID: wc.WorkspaceID,
		VersionPolicy: "latest_released", ScriptSelectors: selectors(config.Scripts),
		StyleSelectors: selectors(config.Styles), SkipUnselectedPublicStyles: true, AllowEmptyResult: true,
	}
	validated, code, message := validateScriptRuntimeRequest(in, wc)
	if code != "" {
		writeError(w, r, http.StatusConflict, "menu_config_invalid", message)
		return
	}
	if len(validated.ScriptSelectors) == 0 && len(validated.StyleSelectors) == 0 {
		writeScriptRuntimeData(w, r, map[string]any{"menu": config, "url": validated.URL, "assets": []store.RuntimeAsset{}, "public": []store.PublicRuntimeScript{}, "publicStyles": []store.PublicRuntimeStyle{}})
		return
	}
	s.resolveScriptRuntimeRequest(w, r, wc, validated, map[string]any{"menu": config})
}

func containsString(values []string, expected string) bool {
	for _, value := range values {
		if value == expected {
			return true
		}
	}
	return false
}

func selectors(values []store.RuntimeAssetSelector) []*store.RuntimeAssetSelector {
	out := make([]*store.RuntimeAssetSelector, 0, len(values))
	for index := range values {
		value := values[index]
		out = append(out, &value)
	}
	return out
}
