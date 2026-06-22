package store

import "context"

// OrgScope is the resolved department/team data-scope visibility for a caller.
//
// NOTE: This is a focused port of the resolver in ky-membership-service
// (department/team dimensions only). Extracting a shared module is registered
// tech debt (Phase 1.13c).
type OrgScope struct {
	Unrestricted  bool
	DepartmentIDs []string
	TeamIDs       []string
}

// ResolveOrgScope computes the caller's visible department/team sets in the
// current workspace, taking the most-permissive union across the caller's
// roles. department/team (non-specified) and self are relative to the caller's
// own assignments; department_tree expands via the department tree.
func (s *Store) ResolveOrgScope(ctx context.Context, callerMembershipID, wsType, wsID string) (OrgScope, error) {
	scopes, err := s.dataScopesForMembership(ctx, callerMembershipID)
	if err != nil {
		return OrgScope{}, err
	}

	currentScope := "current_" + wsType
	deptSet := map[string]struct{}{}
	teamSet := map[string]struct{}{}

	var ownDepts, ownTeams []string
	ownLoaded := false
	loadOwn := func() error {
		if ownLoaded {
			return nil
		}
		var e error
		if ownDepts, e = s.scopeIDs(ctx, `SELECT department_id FROM ky_membership_department WHERE membership_id=$1`, callerMembershipID); e != nil {
			return e
		}
		if ownTeams, e = s.scopeIDs(ctx, `SELECT team_id FROM ky_membership_team WHERE membership_id=$1`, callerMembershipID); e != nil {
			return e
		}
		ownLoaded = true
		return nil
	}

	for _, sc := range scopes {
		switch sc.ScopeType {
		case "all", currentScope:
			return OrgScope{Unrestricted: true}, nil
		case "self":
			if err := loadOwn(); err != nil {
				return OrgScope{}, err
			}
			scopeAddAll(deptSet, ownDepts)
			scopeAddAll(teamSet, ownTeams)
		case "department":
			if err := loadOwn(); err != nil {
				return OrgScope{}, err
			}
			scopeAddAll(deptSet, ownDepts)
		case "department_tree":
			if err := loadOwn(); err != nil {
				return OrgScope{}, err
			}
			sub, err := s.departmentSubtree(ctx, ownDepts)
			if err != nil {
				return OrgScope{}, err
			}
			scopeAddAll(deptSet, sub)
		case "specified_department":
			scopeAddAll(deptSet, sc.DepartmentIDs)
		case "team":
			if err := loadOwn(); err != nil {
				return OrgScope{}, err
			}
			scopeAddAll(teamSet, ownTeams)
		case "specified_team":
			scopeAddAll(teamSet, sc.TeamIDs)
		case "custom":
			scopeAddAll(deptSet, sc.DepartmentIDs)
			scopeAddAll(teamSet, sc.TeamIDs)
		case "specified_agency", "specified_enterprise":
			// Not applicable to the department/team surface.
		}
	}
	return OrgScope{DepartmentIDs: scopeKeys(deptSet), TeamIDs: scopeKeys(teamSet)}, nil
}

type dataScopeRow struct {
	ScopeType     string
	DepartmentIDs []string
	TeamIDs       []string
}

func (s *Store) dataScopesForMembership(ctx context.Context, membershipID string) ([]dataScopeRow, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT DISTINCT rds.scope_type, rds.department_ids, rds.team_ids
		FROM ky_membership_role mr
		JOIN ky_role r ON r.id = mr.role_id
		JOIN ky_role_data_scope rds ON rds.role_id = r.id
		WHERE mr.membership_id = $1 AND r.status='normal' AND r.deleted_at IS NULL
	`, membershipID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []dataScopeRow{}
	for rows.Next() {
		var d dataScopeRow
		var deptB, teamB []byte
		if err := rows.Scan(&d.ScopeType, &deptB, &teamB); err != nil {
			return nil, err
		}
		d.DepartmentIDs = jsonToStrings(deptB)
		d.TeamIDs = jsonToStrings(teamB)
		out = append(out, d)
	}
	return out, rows.Err()
}

// departmentSubtree expands department ids to include all descendants.
func (s *Store) departmentSubtree(ctx context.Context, baseIDs []string) ([]string, error) {
	if len(baseIDs) == 0 {
		return []string{}, nil
	}
	ph, args := scopeInPlaceholders(0, baseIDs)
	return s.scopeIDs(ctx, `
		WITH RECURSIVE subtree AS (
			SELECT id FROM ky_department WHERE id IN (`+ph+`) AND deleted_at IS NULL
			UNION
			SELECT d.id FROM ky_department d JOIN subtree s ON d.parent_id = s.id WHERE d.deleted_at IS NULL
		)
		SELECT id FROM subtree
	`, args...)
}

func (s *Store) scopeIDs(ctx context.Context, query string, args ...any) ([]string, error) {
	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []string{}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out = append(out, id)
	}
	return out, rows.Err()
}
