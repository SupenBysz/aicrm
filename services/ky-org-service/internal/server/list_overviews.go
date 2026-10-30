package server

import (
	o "github.com/Kysion/KyaiCRM/shared/listoverview"
	"net/http"
	"strings"
)

func (s *Server) organizationOverview(w http.ResponseWriter, r *http.Request, wc wsContext) {
	q := r.URL.Query()
	kind := "agencies"
	spec := map[string][]string{"keyword": nil, "status": {"normal", "disabled", "frozen", "pending"}}
	if strings.Contains(r.URL.Path, "/enterprises/") {
		kind = "enterprises"
		spec["agencyId"] = nil
	}
	if strings.Contains(r.URL.Path, "/qualifications/") {
		kind = "qualifications"
		spec = map[string][]string{"status": {"submitted", "approved", "rejected"}}
	}
	if wc.WorkspaceType == "agency" {
		delete(spec, "agencyId")
	}
	if o.Validate(q, spec) != nil {
		writeError(w, r, 400, "validation_error", "概览查询条件无效，不接受分页或排序")
		return
	}
	var result o.Result
	var err error
	switch kind {
	case "agencies":
		result, err = s.store.AgencyOverview(r.Context(), strings.TrimSpace(q.Get("keyword")))
	case "enterprises":
		scope := ""
		if wc.WorkspaceType == "agency" {
			scope = wc.WorkspaceID
		}
		result, err = s.store.EnterpriseOverview(r.Context(), strings.TrimSpace(q.Get("keyword")), q.Get("agencyId"), scope)
	case "qualifications":
		result, err = s.store.QualificationOverview(r.Context())
	}
	if err != nil {
		writeError(w, r, 503, "statistics_unavailable", "概览暂不可用，请重试")
		return
	}
	result.SetScope(q, "status")
	writeData(w, r, result)
}
