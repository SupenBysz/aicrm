package store

import (
	"encoding/json"
	"fmt"
	"strings"

	"github.com/Kysion/KyaiCRM/services/ky-matrix-account-service/internal/matcher"
)

const (
	maxRuntimeMatchRules    = 32
	maxRuntimeRuleRemark    = 200
	maxRuntimeRuleSortOrder = 1_000_000
)

// RuntimeMatchRule 是平台无关的 URL 匹配规则。
type RuntimeMatchRule struct {
	ID          string `json:"id"`
	MatchType   string `json:"matchType"`
	Pattern     string `json:"pattern"`
	IgnoreQuery bool   `json:"ignoreQuery"`
	Enabled     bool   `json:"enabled"`
	Remark      string `json:"remark"`
	SortOrder   int    `json:"sortOrder"`
}

// ScriptRuntimeMatchRuleError 是通用规则校验错误；旧接口在兼容层转换为原有错误类型。
type ScriptRuntimeMatchRuleError struct {
	Field   string
	Message string
}

func (e *ScriptRuntimeMatchRuleError) Error() string { return e.Message }
func (e *ScriptRuntimeMatchRuleError) Unwrap() error { return ErrValidation }

func normalizeRuntimeMatchRules(rules []RuntimeMatchRule, legacyType, legacyURL string) ([]RuntimeMatchRule, error) {
	if rules == nil {
		if legacyType == "" || legacyURL == "" {
			return nil, &ScriptRuntimeMatchRuleError{Field: "matchRules", Message: "至少需要一条启用的 URL 匹配规则"}
		}
		rules = []RuntimeMatchRule{{ID: "legacy", MatchType: legacyType, Pattern: legacyURL, Enabled: true, SortOrder: 0}}
	}
	if len(rules) == 0 || len(rules) > maxRuntimeMatchRules {
		return nil, &ScriptRuntimeMatchRuleError{Field: "matchRules", Message: "匹配规则数量必须在1至32条之间"}
	}
	seen := make(map[string]struct{}, len(rules))
	enabled := 0
	out := make([]RuntimeMatchRule, 0, len(rules))
	for i, rule := range rules {
		rule.ID = strings.TrimSpace(rule.ID)
		if rule.ID == "" {
			rule.ID = fmt.Sprintf("rule_%d", i+1)
		}
		if len(rule.ID) > 64 || strings.ContainsAny(rule.ID, " \t\r\n") {
			return nil, &ScriptRuntimeMatchRuleError{Field: fmt.Sprintf("matchRules[%d].id", i), Message: "匹配规则标识无效"}
		}
		rule.MatchType = strings.TrimSpace(rule.MatchType)
		rule.Pattern = strings.TrimSpace(rule.Pattern)
		rule.Remark = strings.TrimSpace(rule.Remark)
		if len([]rune(rule.Remark)) > maxRuntimeRuleRemark {
			return nil, &ScriptRuntimeMatchRuleError{Field: fmt.Sprintf("matchRules[%d].remark", i), Message: "匹配规则备注不能超过200个字符"}
		}
		if rule.SortOrder < -maxRuntimeRuleSortOrder || rule.SortOrder > maxRuntimeRuleSortOrder {
			return nil, &ScriptRuntimeMatchRuleError{Field: fmt.Sprintf("matchRules[%d].sortOrder", i), Message: "匹配规则排序值超出范围"}
		}
		if rule.MatchType != "exact" && rule.MatchType != "prefix" && rule.MatchType != "wildcard" {
			return nil, &ScriptRuntimeMatchRuleError{Field: fmt.Sprintf("matchRules[%d].matchType", i), Message: "匹配方式必须是 exact、prefix 或 wildcard"}
		}
		normalized, err := matcher.ValidateRule(rule.MatchType, rule.Pattern)
		if err != nil {
			return nil, &ScriptRuntimeMatchRuleError{Field: fmt.Sprintf("matchRules[%d].pattern", i), Message: "匹配规则 URL 无效"}
		}
		rule.Pattern = normalized
		key := fmt.Sprintf("%s\x00%s\x00%t", rule.MatchType, rule.Pattern, rule.IgnoreQuery)
		if _, exists := seen[key]; exists {
			return nil, &ScriptRuntimeMatchRuleError{Field: "matchRules", Message: "匹配规则不能重复"}
		}
		seen[key] = struct{}{}
		if rule.Enabled {
			enabled++
		}
		out = append(out, rule)
	}
	if enabled == 0 {
		return nil, &ScriptRuntimeMatchRuleError{Field: "matchRules", Message: "至少需要一条启用的 URL 匹配规则"}
	}
	return out, nil
}

func encodeRuntimeMatchRules(rules []RuntimeMatchRule) ([]byte, error) {
	return json.Marshal(rules)
}

func decodeRuntimeMatchRules(raw []byte, legacyType, legacyURL string) ([]RuntimeMatchRule, error) {
	var rules []RuntimeMatchRule
	if len(raw) > 0 && string(raw) != "null" {
		if err := json.Unmarshal(raw, &rules); err != nil {
			return nil, err
		}
	}
	if rules == nil && legacyType != "" && legacyURL != "" {
		rules = []RuntimeMatchRule{{ID: "legacy", MatchType: legacyType, Pattern: legacyURL, Enabled: true, SortOrder: 0}}
	}
	return rules, nil
}

func matchRuntimeRules(rules []RuntimeMatchRule, legacyType, legacyURL, candidate string) (bool, error) {
	if len(rules) == 0 {
		rules = []RuntimeMatchRule{{MatchType: legacyType, Pattern: legacyURL, Enabled: true}}
	}
	for _, rule := range rules {
		if !rule.Enabled {
			continue
		}
		matched, err := matcher.MatchRule(rule.MatchType, rule.Pattern, candidate, rule.IgnoreQuery)
		if err != nil {
			return false, err
		}
		if matched {
			return true, nil
		}
	}
	return false, nil
}
