package matcher

import (
	"errors"
	"net"
	"net/url"
	"regexp"
	"strings"
	"unicode/utf8"
)

const (
	MaxPatternLength = 2048
	MaxWildcardCount = 32
)

var (
	ErrEmptyURL       = errors.New("url is empty")
	ErrInvalidURL     = errors.New("url is invalid")
	ErrInvalidPattern = errors.New("url pattern is invalid")
)

// Normalize converts an absolute HTTP(S) URL into the matching form. Scheme
// and hostname are lower-cased, default ports are removed, an empty path is
// represented as "/", and the raw path/query are otherwise preserved.
// Fragments and userinfo are rejected because they are not request targets.
func Normalize(raw string) (string, error) {
	return normalize(raw)
}

// Validate checks and normalizes an exact or wildcard pattern without
// interpreting user text as a regular expression.
func Validate(matchType, raw string) (string, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return "", ErrEmptyURL
	}
	if len(raw) > MaxPatternLength || !utf8.ValidString(raw) || hasControl(raw) {
		return "", ErrInvalidPattern
	}
	switch matchType {
	case "exact":
		if strings.ContainsRune(raw, '*') {
			return "", ErrInvalidPattern
		}
		value, err := Normalize(raw)
		if err != nil {
			return "", ErrInvalidPattern
		}
		return value, nil
	case "wildcard":
		count := strings.Count(raw, "*")
		if count > MaxWildcardCount {
			return "", ErrInvalidPattern
		}
		// wildcard 不含星号时按规范化后的完整 URL 字面量匹配，
		// 这样历史配置和用户输入的完整 URL 都能安全保存。
		if count == 0 {
			value, err := Normalize(raw)
			if err != nil {
				return "", ErrInvalidPattern
			}
			return value, nil
		}
		const marker = "kwwwildcardmarker"
		value, err := normalize(strings.ReplaceAll(raw, "*", marker))
		if err != nil {
			return "", ErrInvalidPattern
		}
		return strings.ReplaceAll(value, marker, "*"), nil
	default:
		return "", ErrInvalidPattern
	}
}

// ValidateRule 校验多规则中的 URL 模式。prefix 使用规范化 URL 的字面前缀匹配。
func ValidateRule(matchType, raw string) (string, error) {
	if matchType == "prefix" {
		raw = strings.TrimSpace(raw)
		if raw == "" || len(raw) > MaxPatternLength || !utf8.ValidString(raw) || hasControl(raw) || strings.ContainsRune(raw, '*') {
			return "", ErrInvalidPattern
		}
		return Normalize(raw)
	}
	return Validate(matchType, raw)
}

// MatchRule 在 exact/prefix/wildcard 三种受限语法中匹配 URL，不接受正则表达式。
func MatchRule(matchType, pattern, candidate string, ignoreQuery bool) (bool, error) {
	stored, err := ValidateRule(matchType, pattern)
	if err != nil {
		return false, err
	}
	actual, err := Normalize(candidate)
	if err != nil {
		return false, ErrInvalidURL
	}
	if ignoreQuery {
		if index := strings.IndexByte(stored, '?'); index >= 0 {
			stored = stored[:index]
		}
		if index := strings.IndexByte(actual, '?'); index >= 0 {
			actual = actual[:index]
		}
	}
	if matchType == "prefix" {
		return strings.HasPrefix(actual, stored), nil
	}
	return Match(matchType, stored, actual)
}

// Match validates both sides and compares a normalized request URL to a
// stored pattern. Wildcards match any sequence of URL characters; the
// resulting regular expression is built only from escaped literals.
func Match(matchType, pattern, candidate string) (bool, error) {
	stored, err := Validate(matchType, pattern)
	if err != nil {
		return false, err
	}
	actual, err := Normalize(candidate)
	if err != nil {
		return false, ErrInvalidURL
	}
	if matchType == "exact" {
		return stored == actual, nil
	}
	parts := strings.Split(stored, "*")
	var b strings.Builder
	b.WriteString("^")
	for i, part := range parts {
		if i > 0 {
			b.WriteString(".*")
		}
		b.WriteString(regexp.QuoteMeta(part))
	}
	b.WriteString("$")
	re, err := regexp.Compile(b.String())
	if err != nil {
		return false, ErrInvalidPattern
	}
	return re.MatchString(actual), nil
}

func normalize(raw string) (string, error) {
	if raw == "" {
		return "", ErrEmptyURL
	}
	u, err := url.Parse(raw)
	if err != nil || u.Scheme == "" || u.Host == "" {
		return "", ErrInvalidURL
	}
	scheme := strings.ToLower(u.Scheme)
	if scheme != "http" && scheme != "https" || u.User != nil || u.Fragment != "" {
		return "", ErrInvalidURL
	}
	hostname := strings.ToLower(u.Hostname())
	if hostname == "" || strings.ContainsAny(hostname, " \t\r\n") {
		return "", ErrInvalidURL
	}
	port := u.Port()
	if (scheme == "http" && port == "80") || (scheme == "https" && port == "443") {
		port = ""
	}
	host := hostname
	if strings.Contains(hostname, ":") {
		if port == "" {
			host = "[" + hostname + "]"
		} else {
			host = net.JoinHostPort(hostname, port)
		}
	} else if port != "" {
		host += ":" + port
	}
	path := u.EscapedPath()
	if path == "" {
		path = "/"
	}
	return scheme + "://" + host + path + querySuffix(u.RawQuery), nil
}

func querySuffix(raw string) string {
	if raw == "" {
		return ""
	}
	return "?" + raw
}

func hasControl(value string) bool {
	for _, r := range value {
		if r < 0x20 || r == 0x7f {
			return true
		}
	}
	return false
}
