package store

import "context"

// ScopeFilter is the resolved member-list data-scope restriction for a caller.
type ScopeFilter struct {
	Unrestricted     bool
	SelfMembershipID string
	DepartmentIDs    []string
	TeamIDs          []string
}

// hasAnyTarget reports whether the filter restricts to at least one concrete target.
func (f ScopeFilter) hasAnyTarget() bool {
	return f.SelfMembershipID != "" || len(f.DepartmentIDs) > 0 || len(f.TeamIDs) > 0
}

// ResolveMemberScope computes the effective member-list scope for a caller in
// the current workspace, taking the most-permissive union across the caller's
// roles. department/team (non-specified) are relative to the caller's own
// department/team assignments; department_tree expands via the department tree.
func (s *Store) ResolveMemberScope(ctx context.Context, callerMembershipID, wsType, wsID string) (ScopeFilter, error) {
	scopes, err := s.DataScopesForMembership(ctx, callerMembershipID)
	if err != nil {
		return ScopeFilter{}, err
	}

	currentScope := "current_" + wsType // current_agency / current_enterprise
	var f ScopeFilter
	deptSet := map[string]struct{}{}
	teamSet := map[string]struct{}{}

	var ownDepts, ownTeams []string
	ownLoaded := false
	loadOwn := func() error {
		if ownLoaded {
			return nil
		}
		var e error
		if ownDepts, e = s.callerDepartmentIDs(ctx, callerMembershipID); e != nil {
			return e
		}
		if ownTeams, e = s.callerTeamIDs(ctx, callerMembershipID); e != nil {
			return e
		}
		ownLoaded = true
		return nil
	}

	for _, sc := range scopes {
		switch sc.ScopeType {
		case "all", currentScope:
			return ScopeFilter{Unrestricted: true}, nil
		case "self":
			f.SelfMembershipID = callerMembershipID
		case "department":
			if err := loadOwn(); err != nil {
				return ScopeFilter{}, err
			}
			addAll(deptSet, ownDepts)
		case "department_tree":
			if err := loadOwn(); err != nil {
				return ScopeFilter{}, err
			}
			sub, err := s.departmentSubtree(ctx, ownDepts)
			if err != nil {
				return ScopeFilter{}, err
			}
			addAll(deptSet, sub)
		case "specified_department":
			addAll(deptSet, sc.DepartmentIDs)
		case "team":
			if err := loadOwn(); err != nil {
				return ScopeFilter{}, err
			}
			addAll(teamSet, ownTeams)
		case "specified_team":
			addAll(teamSet, sc.TeamIDs)
		case "custom":
			addAll(deptSet, sc.DepartmentIDs)
			addAll(teamSet, sc.TeamIDs)
		case "specified_agency", "specified_enterprise":
			// Not applicable to the member list surface in Phase 1.13.
		}
	}

	f.DepartmentIDs = keys(deptSet)
	f.TeamIDs = keys(teamSet)
	return f, nil
}

func (s *Store) callerDepartmentIDs(ctx context.Context, membershipID string) ([]string, error) {
	return s.queryIDs(ctx, `SELECT department_id FROM ky_membership_department WHERE membership_id=$1`, membershipID)
}

func (s *Store) callerTeamIDs(ctx context.Context, membershipID string) ([]string, error) {
	return s.queryIDs(ctx, `SELECT team_id FROM ky_membership_team WHERE membership_id=$1`, membershipID)
}

// departmentSubtree expands the given department ids to include all descendants.
func (s *Store) departmentSubtree(ctx context.Context, baseIDs []string) ([]string, error) {
	if len(baseIDs) == 0 {
		return []string{}, nil
	}
	placeholders, args := inPlaceholders(0, baseIDs)
	return s.queryIDs(ctx, `
		WITH RECURSIVE subtree AS (
			SELECT id FROM ky_department WHERE id IN (`+placeholders+`) AND deleted_at IS NULL
			UNION
			SELECT d.id FROM ky_department d JOIN subtree s ON d.parent_id = s.id WHERE d.deleted_at IS NULL
		)
		SELECT id FROM subtree
	`, args...)
}

// inPlaceholders builds "$start+1,$start+2,..." and the matching args slice.
func inPlaceholders(start int, ids []string) (string, []any) {
	parts := make([]string, len(ids))
	args := make([]any, len(ids))
	for i, id := range ids {
		parts[i] = "$" + itoa(start+i+1)
		args[i] = id
	}
	return joinComma(parts), args
}

func joinComma(parts []string) string {
	out := ""
	for i, p := range parts {
		if i > 0 {
			out += ","
		}
		out += p
	}
	return out
}

func (s *Store) queryIDs(ctx context.Context, query string, args ...any) ([]string, error) {
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

// VisibleMembershipIDs materializes the membership ids in the workspace that
// fall within the scope filter. Returns an empty slice when the restricted
// filter has no targets (caller sees no members).
func (s *Store) VisibleMembershipIDs(ctx context.Context, wsType, wsID string, scope ScopeFilter) ([]string, error) {
	where := []string{"m.workspace_type=$1", "m.workspace_id=$2", "m.deleted_at IS NULL"}
	args := []any{wsType, wsID}

	ors := []string{}
	if scope.SelfMembershipID != "" {
		args = append(args, scope.SelfMembershipID)
		ors = append(ors, "m.id=$"+itoa(len(args)))
	}
	if len(scope.DepartmentIDs) > 0 {
		ph, a := inPlaceholders(len(args), scope.DepartmentIDs)
		args = append(args, a...)
		ors = append(ors, "EXISTS (SELECT 1 FROM ky_membership_department md WHERE md.membership_id=m.id AND md.department_id IN ("+ph+"))")
	}
	if len(scope.TeamIDs) > 0 {
		ph, a := inPlaceholders(len(args), scope.TeamIDs)
		args = append(args, a...)
		ors = append(ors, "EXISTS (SELECT 1 FROM ky_membership_team mt WHERE mt.membership_id=m.id AND mt.team_id IN ("+ph+"))")
	}
	if len(ors) == 0 {
		return []string{}, nil
	}
	where = append(where, "("+joinComma2(ors, " OR ")+")")

	return s.queryIDs(ctx, `SELECT m.id FROM ky_membership m WHERE `+joinComma2(where, " AND "), args...)
}

// joinComma2 joins parts with an explicit separator.
func joinComma2(parts []string, sep string) string {
	out := ""
	for i, p := range parts {
		if i > 0 {
			out += sep
		}
		out += p
	}
	return out
}

func addAll(set map[string]struct{}, ids []string) {
	for _, id := range ids {
		if id != "" {
			set[id] = struct{}{}
		}
	}
}

func keys(set map[string]struct{}) []string {
	out := make([]string, 0, len(set))
	for k := range set {
		out = append(out, k)
	}
	return out
}
