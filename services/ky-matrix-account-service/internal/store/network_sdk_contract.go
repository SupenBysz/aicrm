package store

import (
	"sort"
	"strings"
)

const MaxNetworkCapabilities = 6

const (
	NetworkCapabilitySubscribeRequest  = "subscribeRequest"
	NetworkCapabilitySubscribeResponse = "subscribeResponse"
	NetworkCapabilityWaitForRequest    = "waitForRequest"
	NetworkCapabilityWaitForResponse   = "waitForResponse"
	NetworkCapabilityInterceptRequest  = "interceptRequest"
	NetworkCapabilityInterceptResponse = "interceptResponse"
)

var networkCapabilityOrder = []string{
	NetworkCapabilitySubscribeRequest,
	NetworkCapabilitySubscribeResponse,
	NetworkCapabilityWaitForRequest,
	NetworkCapabilityWaitForResponse,
	NetworkCapabilityInterceptRequest,
	NetworkCapabilityInterceptResponse,
}

// DefaultNetworkCapabilities 只授予只读订阅和等待能力，拦截能力必须由服务端显式声明。
func DefaultNetworkCapabilities() []string {
	return append([]string(nil), []string{
		NetworkCapabilitySubscribeRequest,
		NetworkCapabilitySubscribeResponse,
		NetworkCapabilityWaitForRequest,
		NetworkCapabilityWaitForResponse,
	}...)
}

// NormalizeNetworkCapabilities 规范化服务端能力声明，拒绝未知项、空项和重复项。
func NormalizeNetworkCapabilities(values []string) ([]string, error) {
	if len(values) == 0 {
		return DefaultNetworkCapabilities(), nil
	}
	if len(values) > MaxNetworkCapabilities {
		return nil, ErrValidation
	}
	allowed := make(map[string]struct{}, len(networkCapabilityOrder))
	for _, item := range networkCapabilityOrder {
		allowed[item] = struct{}{}
	}
	seen := make(map[string]struct{}, len(values))
	for _, value := range values {
		value = strings.TrimSpace(value)
		if value == "" {
			return nil, ErrValidation
		}
		if _, ok := allowed[value]; !ok {
			return nil, ErrValidation
		}
		if _, ok := seen[value]; ok {
			return nil, ErrValidation
		}
		seen[value] = struct{}{}
	}
	out := make([]string, 0, len(seen))
	for _, item := range networkCapabilityOrder {
		if _, ok := seen[item]; ok {
			out = append(out, item)
		}
	}
	return out, nil
}

// ServerNetworkCapabilities 是唯一允许进入运行时响应的服务端边界。
// 当前没有持久化的拦截授权来源，因此空声明只能得到观察能力；未来显式授权
// 必须从服务端配置或数据库读取后传入，不能使用请求体中的客户端值。
func ServerNetworkCapabilities(declared []string) ([]string, error) {
	return NormalizeNetworkCapabilities(declared)
}

// HasNetworkCapability 用于执行边界再次校验，调用方不得把客户端请求当作授权来源。
func HasNetworkCapability(capabilities []string, capability string) bool {
	for _, item := range capabilities {
		if item == capability {
			return true
		}
	}
	return false
}

func sortNetworkCapabilities(values []string) []string {
	out := append([]string(nil), values...)
	sort.SliceStable(out, func(i, j int) bool {
		return networkCapabilityRank(out[i]) < networkCapabilityRank(out[j])
	})
	return out
}

func networkCapabilityRank(value string) int {
	for index, item := range networkCapabilityOrder {
		if item == value {
			return index
		}
	}
	return len(networkCapabilityOrder)
}
