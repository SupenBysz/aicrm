package server

import "net/http"

func (s *Server) platformWorkbench(w http.ResponseWriter, r *http.Request, wc wsContext) {
	sum, err := s.store.PlatformWorkbenchSummary(r.Context())
	if err != nil {
		writeStoreError(w, r, err)
		return
	}
	writeData(w, r, sum)
}

func (s *Server) agencyWorkbench(w http.ResponseWriter, r *http.Request, wc wsContext) {
	sum, err := s.store.OrgWorkbenchSummary(r.Context(), wc.WorkspaceType, wc.WorkspaceID)
	if err != nil {
		writeStoreError(w, r, err)
		return
	}
	writeData(w, r, sum)
}

func (s *Server) enterpriseWorkbench(w http.ResponseWriter, r *http.Request, wc wsContext) {
	sum, err := s.store.OrgWorkbenchSummary(r.Context(), wc.WorkspaceType, wc.WorkspaceID)
	if err != nil {
		writeStoreError(w, r, err)
		return
	}
	writeData(w, r, sum)
}
