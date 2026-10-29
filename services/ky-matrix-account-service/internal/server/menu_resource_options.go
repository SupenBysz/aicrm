package server

import (
	"net/http"
	"regexp"
)

var menuResourcePlatform = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]{0,31}$`)

func (s *Server) listMenuResourceOptions(w http.ResponseWriter, r *http.Request, wc wsContext) {
	platform := r.URL.Query().Get("platform")
	if !menuResourcePlatform.MatchString(platform) {
		writeError(w, r, 400, "validation_error", "资源平台无效")
		return
	}
	options, err := s.store.ListMenuResourceOptions(r.Context(), wc.WorkspaceType, wc.WorkspaceID, platform)
	if err != nil {
		writeStoreError(w, r, err)
		return
	}
	writeData(w, r, options)
}
