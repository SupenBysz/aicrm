package store

import "context"

type DomainWorkspace struct {
	Type string `json:"type"`
	ID   string `json:"id"`
}

func (s *Store) DomainWorkspaces(ctx context.Context, user string) ([]DomainWorkspace, error) {
	rows, e := s.db.QueryContext(ctx, `SELECT workspace_type,workspace_id FROM ky_membership WHERE user_id=$1 AND status='active' AND deleted_at IS NULL AND workspace_type IN ('agency','enterprise') ORDER BY workspace_type,workspace_id LIMIT 501`, user)
	if e != nil {
		return nil, e
	}
	defer rows.Close()
	out := []DomainWorkspace{}
	for rows.Next() {
		var w DomainWorkspace
		if e = rows.Scan(&w.Type, &w.ID); e != nil {
			return nil, e
		}
		out = append(out, w)
	}
	return out, rows.Err()
}

func (s *Store) EnterpriseScopeAllowed(ctx context.Context, caller, enterpriseID, agencyID string) (bool, error) {
	scopes, err := s.DataScopesForMembership(ctx, caller)
	if err != nil {
		return false, err
	}
	for _, sc := range scopes {
		if sc.ScopeType == "all" {
			return true, nil
		}
		if sc.ScopeType == "specified_enterprise" && domainContains(sc.EnterpriseIDs, enterpriseID) {
			return true, nil
		}
		if sc.ScopeType == "specified_agency" && agencyID != "" && domainContains(sc.AgencyIDs, agencyID) {
			return true, nil
		}
	}
	return false, nil
}
func domainContains(ids []string, id string) bool {
	for _, v := range ids {
		if v == id {
			return true
		}
	}
	return false
}
