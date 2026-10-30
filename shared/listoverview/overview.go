// Package listoverview contains transport and bounded aggregate helpers only.
// Business filters, table names, authorization and metric semantics stay in services.
package listoverview

import (
	"context"
	"database/sql"
	"errors"
	"net/url"
	"strings"
	"time"
	"unicode/utf8"
)

type Metric struct {
	Key   string `json:"key"`
	Count int64  `json:"count"`
}
type Scope struct {
	Basis          string            `json:"basis"`
	IgnoredFilters []string          `json:"ignoredFilters"`
	Filters        map[string]string `json:"filters"`
	Timezone       string            `json:"timezone"`
	Start          *string           `json:"start"`
	End            *string           `json:"end"`
}
type Result struct {
	SchemaVersion int       `json:"schemaVersion"`
	Scope         Scope     `json:"scope"`
	AsOf          time.Time `json:"asOf"`
	Total         int64     `json:"total"`
	Metrics       []Metric  `json:"metrics"`
}
type Queryer interface {
	QueryRowContext(context.Context, string, ...any) *sql.Row
}

// Validate only accepts a single value per explicitly registered parameter.
// A nil enum means bounded free text; ignored status filters are still validated.
func Validate(q url.Values, spec map[string][]string) error {
	for key, values := range q {
		allowed, ok := spec[key]
		if !ok || len(values) != 1 || !utf8.ValidString(values[0]) || utf8.RuneCountInString(values[0]) > 256 {
			return errors.New("invalid overview query")
		}
		if values[0] != "" && allowed != nil {
			found := false
			for _, v := range allowed {
				if values[0] == v {
					found = true
					break
				}
			}
			if !found {
				return errors.New("invalid overview filter")
			}
		}
	}
	return nil
}
func (r *Result) SetScope(q url.Values, ignored ...string) {
	r.Scope = Scope{Basis: "search_without_status", IgnoredFilters: ignored, Filters: map[string]string{}, Timezone: "Asia/Shanghai"}
	for key := range q {
		skip := false
		for _, v := range ignored {
			if key == v {
				skip = true
			}
		}
		if !skip && q.Get(key) != "" {
			r.Scope.Filters[key] = q.Get(key)
		}
	}
	if v := q.Get("startAt"); v != "" {
		r.Scope.Start = &v
	}
	if v := q.Get("endBefore"); v != "" {
		r.Scope.End = &v
	}
}

// Count executes one service-owned aggregate with a bounded lifetime. First
// selected column is total, followed by one count per key. No SQL is client-owned.
func Count(ctx context.Context, db Queryer, statement string, args []any, keys ...string) (Result, error) {
	ctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	r := Result{SchemaVersion: 1, AsOf: time.Now().UTC(), Metrics: []Metric{}}
	counts := make([]int64, len(keys)+1)
	dest := make([]any, len(counts))
	for i := range counts {
		dest[i] = &counts[i]
	}
	if err := db.QueryRowContext(ctx, statement, args...).Scan(dest...); err != nil {
		return r, err
	}
	for _, n := range counts {
		if n < 0 || n > 9007199254740991 {
			return r, errors.New("overview count out of range")
		}
	}
	r.Total = counts[0]
	for i, key := range keys {
		r.Metrics = append(r.Metrics, Metric{key, counts[i+1]})
	}
	return r, nil
}

// StatusSQL receives only static service-owned SQL fragments, never query values.
func StatusSQL(from, clause, column string, statuses []string) (string, []string) {
	fields := []string{"count(*)"}
	quoted := []string{}
	keys := append([]string{}, statuses...)
	for _, status := range statuses {
		quoted = append(quoted, "'"+status+"'")
		fields = append(fields, "count(*) FILTER (WHERE "+column+"='"+status+"')")
	}
	fields = append(fields, "count(*) FILTER (WHERE "+column+" IS NULL OR "+column+" NOT IN ("+strings.Join(quoted, ",")+"))")
	keys = append(keys, "unclassified")
	return "SELECT " + strings.Join(fields, ",") + " FROM " + from + " WHERE " + clause, keys
}
