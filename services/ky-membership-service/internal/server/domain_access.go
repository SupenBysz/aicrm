package server

import (
	"github.com/Kysion/KyaiCRM/shared/domainentry"
	"net/http"
)

func (s *Server) domainAccess(w http.ResponseWriter, r *http.Request) {
	if !domainentry.Internal(r, s.cfg.InternalToken) {
		writeError(w, r, 401, "unauthorized", "内部认证失败")
		return
	}
	var in struct {
		AgencyIDs     []string `json:"agencyIds"`
		ActorID       string   `json:"actorId"`
		AgencyID      string   `json:"agencyId"`
		Permission    string   `json:"permission"`
		WorkspaceID   string   `json:"workspaceId"`
		WorkspaceType string   `json:"workspaceType"`
	}
	if !decodeJSON(w, r, &in) {
		return
	}
	if s.store == nil || !opaqueReferencePattern.MatchString(in.ActorID) || (!opaqueReferencePattern.MatchString(in.AgencyID) && len(in.AgencyIDs) == 0) {
		writeError(w, r, 400, "validation_error", "无效范围")
		return
	}
	if r.URL.Path == "/internal/v1/domains/operator-access" {
		if in.Permission != "platform.agency_domains.view" && in.Permission != "platform.agency_domains.manage" && in.Permission != "platform.agency_domains.activate" {
			writeError(w, r, 400, "validation_error", "无效权限")
			return
		}
		ready, err := s.accountReady(r, in.ActorID)
		if err != nil {
			writeError(w, r, 503, "unavailable", "账号状态不可确认")
			return
		}
		if !ready {
			writeData(w, r, map[string]any{"allowed": false, "ids": []string{}})
			return
		}
		mid, e := s.store.ActiveMembershipID(r.Context(), in.ActorID, "platform", in.WorkspaceID)
		allowed := false
		if e == nil && mid != "" {
			allowed, e = s.store.HasAny(r.Context(), mid, []string{in.Permission})
			if e == nil && allowed {
				if len(in.AgencyIDs) > 0 {
					if len(in.AgencyIDs) > 100 {
						writeError(w, r, 400, "validation_error", "机构数量超限")
						return
					}
					ids := []string{}
					for _, id := range in.AgencyIDs {
						if !opaqueReferencePattern.MatchString(id) {
							writeError(w, r, 400, "validation_error", "机构引用无效")
							return
						}
						ok, err := s.store.EnterpriseScopeAllowed(r.Context(), mid, "", id)
						if err != nil {
							writeError(w, r, 503, "unavailable", "范围不可确认")
							return
						}
						if ok {
							ids = append(ids, id)
						}
					}
					writeData(w, r, map[string]any{"ids": ids})
					return
				}
				allowed, e = s.store.EnterpriseScopeAllowed(r.Context(), mid, "", in.AgencyID)
			}
		}
		if e != nil {
			writeError(w, r, 503, "unavailable", "权限不可确认")
			return
		}
		if len(in.AgencyIDs) > 0 {
			writeData(w, r, map[string]any{"ids": []string{}})
			return
		}
		writeData(w, r, map[string]bool{"allowed": allowed})
		return
	}
	refs, e := s.store.DomainWorkspaces(r.Context(), in.ActorID)
	if e != nil || len(refs) > 500 {
		writeError(w, r, 503, "unavailable", "身份不可确认")
		return
	}
	filtered := refs[:0]
	for _, v := range refs {
		if in.WorkspaceType == "" && in.WorkspaceID == "" || v.Type == in.WorkspaceType && v.ID == in.WorkspaceID {
			filtered = append(filtered, v)
		}
	}
	var out struct {
		Allowed    bool `json:"allowed"`
		Workspaces []struct {
			Type string `json:"type"`
			ID   string `json:"id"`
		} `json:"workspaces"`
	}
	if e = domainentry.Call(r.Context(), s.cfg.OrgServiceURL, s.cfg.InternalToken, "/internal/v1/domains/workspace-scope", map[string]any{"agencyId": in.AgencyID, "workspaces": filtered}, &out); e != nil {
		writeError(w, r, 503, "unavailable", "归属不可确认")
		return
	}
	writeData(w, r, out)
}

func (s *Server) accountReady(r *http.Request, user string) (bool, error) {
	var out struct {
		Ready bool `json:"ready"`
	}
	err := domainentry.Call(r.Context(), s.cfg.AuthServiceURL, s.cfg.InternalToken, "/internal/v1/domains/actor-status", map[string]string{"actorId": user}, &out)
	return out.Ready, err
}
