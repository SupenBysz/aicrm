package store

import "errors"

// DouyinMatchRule 保留旧脚本 CRUD/兼容 API 的类型名。
type DouyinMatchRule = RuntimeMatchRule

func normalizeDouyinMatchRules(rules []RuntimeMatchRule, legacyType, legacyURL string) ([]RuntimeMatchRule, error) {
	out, err := normalizeRuntimeMatchRules(rules, legacyType, legacyURL)
	if err == nil {
		return out, nil
	}
	var ruleErr *ScriptRuntimeMatchRuleError
	if errors.As(err, &ruleErr) {
		return nil, &DouyinScriptInputError{Field: ruleErr.Field, Message: ruleErr.Message}
	}
	return nil, err
}

func encodeDouyinMatchRules(rules []RuntimeMatchRule) ([]byte, error) {
	return encodeRuntimeMatchRules(rules)
}

func decodeDouyinMatchRules(raw []byte, legacyType, legacyURL string) ([]RuntimeMatchRule, error) {
	return decodeRuntimeMatchRules(raw, legacyType, legacyURL)
}

func matchDouyinRules(rules []RuntimeMatchRule, legacyType, legacyURL, candidate string) (bool, error) {
	return matchRuntimeRules(rules, legacyType, legacyURL, candidate)
}

func normalizeDouyinRulesForInput(in DouyinScriptInput) (DouyinScriptInput, error) {
	rules, err := normalizeDouyinMatchRules(in.MatchRules, in.MatchType, in.MatchURL)
	if err != nil {
		return in, err
	}
	in.MatchRules = rules
	// 旧字段始终镜像第一条规则，确保旧 API 和数据库查询继续可用。
	in.MatchType = rules[0].MatchType
	in.MatchURL = rules[0].Pattern
	return in, nil
}

func mustEncodeDouyinRules(rules []DouyinMatchRule) []byte {
	b, err := encodeDouyinMatchRules(rules)
	if err != nil {
		panic(err)
	}
	return b
}
