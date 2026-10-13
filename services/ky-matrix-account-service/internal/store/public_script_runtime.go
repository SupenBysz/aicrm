package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strconv"
	"strings"
)

var (
	ErrPublicDependencyMissing = errors.New("public_dependency_missing")
	ErrPublicDependencyCycle   = errors.New("public_dependency_cycle")
)

const (
	maxBusinessPublicDependencies = 32
	maxBusinessPublicMethods      = 32
	maxBusinessPublicDeclaration  = 16 << 10
)

// BusinessPublicDependency 是业务 JavaScript 顶部声明的公共模块及其必需导出。
type BusinessPublicDependency struct {
	Identifier string   `json:"identifier"`
	Methods    []string `json:"methods"`
}

// PublicDependencyDeclarationError 不包含源码，只报告可定位的依赖标识符或方法名。
type PublicDependencyDeclarationError struct {
	Identifier string
	Method     string
	Reason     string
}

func (e *PublicDependencyDeclarationError) Error() string {
	if e.Method != "" {
		return fmt.Sprintf("invalid public dependency %s method %s: %s", e.Identifier, e.Method, e.Reason)
	}
	if e.Identifier != "" {
		return fmt.Sprintf("invalid public dependency %s: %s", e.Identifier, e.Reason)
	}
	return "invalid public dependency declaration: " + e.Reason
}

// ParseBusinessPublicDependencies reads the single-line executable JSON declaration at
// the beginning of a business script. Comments are allowed before it; absent declarations
// preserve old scripts and mean no source-declared public dependencies.
func ParseBusinessPublicDependencies(source string) ([]BusinessPublicDependency, error) {
	const declaration = "const KWW_PUBLIC_DEPENDENCIES"
	code := maskBusinessScriptNonCode(source)
	var dependencies []BusinessPublicDependency
	found := false
	for searchFrom := 0; searchFrom < len(source); {
		relative := strings.Index(source[searchFrom:], declaration)
		if relative < 0 {
			break
		}
		start := searchFrom + relative
		searchFrom = start + len(declaration)
		if !isBusinessScriptCode(code, start, len(declaration)) || (searchFrom < len(source) && isJSIdentifierByte(source[searchFrom])) {
			continue
		}
		if found {
			return nil, &PublicDependencyDeclarationError{Reason: "只能声明一次公共依赖数组"}
		}
		found = true
		cursor := searchFrom
		for cursor < len(source) && (source[cursor] == ' ' || source[cursor] == '\t') {
			cursor++
		}
		if cursor >= len(source) || source[cursor] != '=' {
			return nil, &PublicDependencyDeclarationError{Reason: "声明格式应为 JSON 数组赋值"}
		}
		cursor++
		lineEnd := strings.IndexByte(source[cursor:], '\n')
		if lineEnd < 0 {
			lineEnd = len(source)
		} else {
			lineEnd += cursor
		}
		rest := strings.TrimSpace(strings.TrimSuffix(source[cursor:lineEnd], "\r"))
		if len(rest) > maxBusinessPublicDeclaration {
			return nil, &PublicDependencyDeclarationError{Reason: "声明超过长度限制"}
		}
		decoder := json.NewDecoder(strings.NewReader(rest))
		decoder.DisallowUnknownFields()
		if err := decoder.Decode(&dependencies); err != nil {
			return nil, &PublicDependencyDeclarationError{Reason: "声明必须是单行有效 JSON 数组"}
		}
		consumed := decoder.InputOffset()
		if strings.TrimSpace(rest[consumed:]) != ";" {
			return nil, &PublicDependencyDeclarationError{Reason: "声明必须以分号结束"}
		}
	}
	if !found {
		return nil, nil
	}
	return normalizeBusinessPublicDependencies(dependencies)
}

// maskBusinessScriptNonCode 忽略注释和字符串/模板字符串，避免示例文本意外加载依赖。
// 声明可位于插入的源码块中段，不要求处于文件偏移量零的位置。
func maskBusinessScriptNonCode(source string) []bool {
	const (
		normal = iota
		singleQuoted
		doubleQuoted
		templateQuoted
		lineComment
		blockComment
	)
	code := make([]bool, len(source))
	state := normal
	escaped := false
	for i := 0; i < len(source); i++ {
		current := source[i]
		next := byte(0)
		if i+1 < len(source) {
			next = source[i+1]
		}
		switch state {
		case normal:
			switch {
			case current == '/' && next == '/':
				state = lineComment
				i++
			case current == '/' && next == '*':
				state = blockComment
				i++
			case current == '\'':
				state = singleQuoted
			case current == '"':
				state = doubleQuoted
			case current == '`':
				state = templateQuoted
			default:
				code[i] = true
			}
		case lineComment:
			if current == '\n' {
				state = normal
			}
		case blockComment:
			if current == '*' && next == '/' {
				state = normal
				i++
			}
		case singleQuoted, doubleQuoted, templateQuoted:
			quote := byte('\'')
			if state == doubleQuoted {
				quote = '"'
			} else if state == templateQuoted {
				quote = '`'
			}
			if escaped {
				escaped = false
			} else if current == '\\' {
				escaped = true
			} else if current == quote {
				state = normal
			}
		}
	}
	return code
}

func isBusinessScriptCode(mask []bool, start, length int) bool {
	if start < 0 || length < 0 || start+length > len(mask) {
		return false
	}
	for _, isCode := range mask[start : start+length] {
		if !isCode {
			return false
		}
	}
	return true
}

func isJSIdentifierByte(value byte) bool {
	return value == '_' || value == '$' || value >= '0' && value <= '9' || value >= 'a' && value <= 'z' || value >= 'A' && value <= 'Z'
}

func normalizeBusinessPublicDependencies(dependencies []BusinessPublicDependency) ([]BusinessPublicDependency, error) {
	positions := make(map[string]int, len(dependencies))
	out := make([]BusinessPublicDependency, 0, len(dependencies))
	for _, dependency := range dependencies {
		if !validPublicScriptIdentifier(dependency.Identifier) {
			return nil, &PublicDependencyDeclarationError{Identifier: dependency.Identifier, Reason: "标识符格式无效"}
		}
		index, exists := positions[dependency.Identifier]
		if !exists {
			if len(out) >= maxBusinessPublicDependencies {
				return nil, &PublicDependencyDeclarationError{Identifier: dependency.Identifier, Reason: "公共依赖数量超过 32 项"}
			}
			index = len(out)
			positions[dependency.Identifier] = index
			out = append(out, BusinessPublicDependency{Identifier: dependency.Identifier, Methods: []string{}})
		}
		methodSet := make(map[string]struct{}, len(out[index].Methods))
		for _, method := range out[index].Methods {
			methodSet[method] = struct{}{}
		}
		for _, method := range dependency.Methods {
			if !validPublicDependencyMethod(method) {
				return nil, &PublicDependencyDeclarationError{Identifier: dependency.Identifier, Method: method, Reason: "方法名格式无效"}
			}
			if _, duplicate := methodSet[method]; duplicate {
				continue
			}
			if len(methodSet) >= maxBusinessPublicMethods {
				return nil, &PublicDependencyDeclarationError{Identifier: dependency.Identifier, Method: method, Reason: "必需方法数量超过 32 项"}
			}
			methodSet[method] = struct{}{}
			out[index].Methods = append(out[index].Methods, method)
		}
	}
	return out, nil
}

func validPublicDependencyMethod(method string) bool {
	if method == "" || len(method) > 64 || !((method[0] >= 'A' && method[0] <= 'Z') || (method[0] >= 'a' && method[0] <= 'z') || method[0] == '_' || method[0] == '$') {
		return false
	}
	for _, r := range method[1:] {
		if !((r >= 'A' && r <= 'Z') || (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') || r == '_' || r == '$') {
			return false
		}
	}
	return true
}

// RuntimePublicDependencyRoots combines source-declared dependencies with the
// legacy publicIdentifiers request field, then returns deterministic unique roots.
func RuntimePublicDependencyRoots(assets []RuntimeAsset, legacy []string) ([]string, error) {
	seen := make(map[string]struct{}, len(legacy))
	for _, identifier := range legacy {
		if !validPublicScriptIdentifier(identifier) {
			return nil, &PublicDependencyDeclarationError{Identifier: identifier, Reason: "旧版公共脚本选择标识符格式无效"}
		}
		seen[identifier] = struct{}{}
	}
	for _, asset := range assets {
		if asset.AssetType != "script" && asset.Kind != "script" {
			continue
		}
		dependencies, err := ParseBusinessPublicDependencies(asset.SourceContent)
		if err != nil {
			return nil, err
		}
		for _, dependency := range dependencies {
			seen[dependency.Identifier] = struct{}{}
			if len(seen) > maxBusinessPublicDependencies {
				return nil, &PublicDependencyDeclarationError{Identifier: dependency.Identifier, Reason: "合并后的公共依赖数量超过 32 项"}
			}
		}
	}
	roots := make([]string, 0, len(seen))
	for identifier := range seen {
		roots = append(roots, identifier)
	}
	sort.Strings(roots)
	return roots, nil
}

// PublicRuntimeScript 是运行时可安全返回的公共脚本；只包含已启用源码和依赖快照。
type PublicRuntimeScript struct {
	ID                  string                   `json:"id"`
	Identifier          string                   `json:"identifier"`
	Platform            string                   `json:"platform"`
	Version             string                   `json:"version"`
	Source              string                   `json:"source"`
	SourceBytes         int                      `json:"sourceBytes"`
	SourceChars         int                      `json:"sourceChars"`
	SourceSHA256        string                   `json:"sourceSha256"`
	Dependencies        []PublicScriptDependency `json:"dependencies"`
	NetworkCapabilities []string                 `json:"networkCapabilities"`
}

// OrderPublicScriptDependencies 校验公共脚本只能依赖公共脚本，并按依赖优先拓扑排序。
func OrderPublicScriptDependencies(items []PublicRuntimeScript, roots []string) ([]PublicRuntimeScript, error) {
	byID := make(map[string]PublicRuntimeScript, len(items))
	for _, item := range items {
		if !validPublicScriptIdentifier(item.Identifier) {
			return nil, ErrValidation
		}
		byID[item.Identifier] = item
	}
	if len(roots) == 0 {
		roots = make([]string, 0, len(items))
		for _, item := range items {
			roots = append(roots, item.Identifier)
		}
		sort.Strings(roots)
	}
	state := make(map[string]uint8, len(byID))
	out := make([]PublicRuntimeScript, 0, len(roots))
	var visit func(string) error
	visit = func(id string) error {
		switch state[id] {
		case 1:
			return ErrPublicDependencyCycle
		case 2:
			return nil
		}
		item, ok := byID[id]
		if !ok {
			return fmt.Errorf("%w:%s", ErrPublicDependencyMissing, id)
		}
		state[id] = 1
		for _, dep := range item.Dependencies {
			if err := visit(dep.Identifier); err != nil {
				return err
			}
		}
		state[id] = 2
		out = append(out, item)
		return nil
	}
	for _, root := range roots {
		if err := visit(root); err != nil {
			return nil, err
		}
	}
	return out, nil
}

// ResolvePublicScripts 按工作区和平台读取可供页面 SDK 注册的已启用公共脚本。
func (s *Store) ResolvePublicScripts(ctx context.Context, wsType, wsID, platform string, roots []string) ([]PublicRuntimeScript, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT id,identifier,platform,revision,source_content,source_chars,source_bytes,source_sha256,COALESCE(dependencies,'[]'::jsonb) FROM ky_matrix_account_public_script WHERE workspace_type=$1 AND workspace_id=$2 AND platform=$3 AND enabled AND deleted_at IS NULL ORDER BY identifier,id`, wsType, wsID, platform)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := make([]PublicRuntimeScript, 0)
	for rows.Next() {
		var item PublicRuntimeScript
		var revision int
		var raw []byte
		if err := rows.Scan(&item.ID, &item.Identifier, &item.Platform, &revision, &item.Source, &item.SourceChars, &item.SourceBytes, &item.SourceSHA256, &raw); err != nil {
			return nil, err
		}
		item.Version = strconv.Itoa(revision)
		item.Dependencies = decodePublicScriptDependencies(raw)
		item.NetworkCapabilities = DefaultNetworkCapabilities()
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return OrderPublicScriptDependencies(items, roots)
}

func isPublicDependencyError(err error) bool {
	return errors.Is(err, ErrPublicDependencyMissing) || errors.Is(err, ErrPublicDependencyCycle)
}
