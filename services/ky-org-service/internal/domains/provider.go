package domains

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/Kysion/KyaiCRM/shared/domainentry"
	"golang.org/x/net/publicsuffix"
	"io"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

type Provider struct {
	InstanceID                                      string
	verifyIngress                                   func(context.Context, Binding) error
	lookupTXT                                       func(context.Context, string) ([]string, error)
	probe                                           func(context.Context, Binding) bool
	AllowZoneCreate                                 bool
	Token, AccountID, TunnelID, Origin, ProbeSecret string
	HTTP                                            *http.Client
	APIBase                                         string
	Resolver                                        *net.Resolver
}

func (p Provider) call(ctx context.Context, method, path string, body, out any) error {
	base := p.APIBase
	if base == "" {
		base = "https://api.cloudflare.com/client/v4"
	}
	if p.Token == "" {
		return errors.New("Cloudflare受限凭据尚未配置")
	}
	raw, _ := json.Marshal(body)
	req, e := http.NewRequestWithContext(ctx, method, base+path, bytes.NewReader(raw))
	if e != nil {
		return e
	}
	req.Header.Set("Authorization", "Bearer "+p.Token)
	req.Header.Set("Content-Type", "application/json")
	c := &http.Client{Timeout: 10 * time.Second}
	if p.HTTP != nil {
		*c = *p.HTTP
	}
	c.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	res, e := c.Do(req)
	if e != nil {
		return errors.New("Cloudflare暂时不可达，稍后自动重试")
	}
	defer res.Body.Close()
	if res.StatusCode == 429 {
		if retry, ok := ctx.Value(retryKey{}).(*int); ok {
			seconds, err := strconv.Atoi(res.Header.Get("Retry-After"))
			if err != nil {
				if date, e := http.ParseTime(res.Header.Get("Retry-After")); e == nil {
					seconds = int(time.Until(date).Seconds())
				}
			}
			if seconds > 3600 {
				seconds = 3600
			}
			if seconds > 0 {
				*retry = seconds
			}
		}
		return errors.New("Cloudflare请求限流，稍后自动重试")
	}
	if res.StatusCode < 200 || res.StatusCode >= 300 {

		return fmt.Errorf("Cloudflare操作未完成（%d），请联系管理员核对权限或资源状态", res.StatusCode)
	}
	var env struct {
		Success bool            `json:"success"`
		Result  json.RawMessage `json:"result"`
	}
	if json.NewDecoder(io.LimitReader(res.Body, 1<<20)).Decode(&env) != nil || !env.Success {
		return errors.New("Cloudflare返回异常，请稍后重试")
	}
	if out != nil {
		return json.Unmarshal(env.Result, out)
	}
	return nil
}
func (p Provider) resolver() *net.Resolver {
	if p.Resolver != nil {
		return p.Resolver
	}
	return net.DefaultResolver
}

type retryKey struct{}

func (p Provider) Observe(ctx context.Context, b Binding) (out Observation) {
	retry := new(int)
	ctx = context.WithValue(ctx, retryKey{}, retry)
	defer func() { out.RetryAfterSeconds = *retry }()
	o := Observation{ProviderID: b.ProviderID, Records: []Record{{Type: "TXT", Name: "_kycrm." + b.Hostname, Value: b.Challenge}}}
	cleanup := b.State == "detaching" || b.State == "detached"
	// A platform-authorized managed zone can bootstrap its own challenge.
	// Active bindings still verify public TXT first; missing ownership is never self-healed.
	if !cleanup && b.Mode == "managed" && (b.State == "awaiting_verification" || b.State == "awaiting_dns" || b.State == "provisioning" || b.State == "ready") {
		if !b.ExpiresAt.After(time.Now()) {
			o.Message = "验证已过期，请更新验证后继续"
			return o
		}
		return p.managed(ctx, b, o, false)
	}
	if !cleanup {
		lookup := p.lookupTXT
		if lookup == nil {
			lookup = p.resolver().LookupTXT
		}
		txt, e := lookup(ctx, "_kycrm."+b.Hostname)
		if e != nil {
			o.Message = "尚未检测到所有权TXT，请检查记录后等待生效"
			return o
		}
		for _, v := range txt {
			if v == b.Challenge {
				o.Verified = true
			}
		}
		if !o.Verified {
			o.OwnershipLost = true
			o.Message = "所有权TXT记录不匹配，请检查记录值"
			return o
		}
		if b.State != "active" && b.State != "degraded" && !b.ExpiresAt.After(time.Now()) {
			o.Verified = false
			o.Message = "所有权验证已过期，请更新验证记录"
			return o
		}
	}
	if b.Mode == "managed" {
		return p.managed(ctx, b, o, cleanup)
	}
	o.Message = "unsupported mode"
	return o
}

func (p Provider) managed(ctx context.Context, b Binding, o Observation, cleanup bool) Observation {
	if p.AccountID == "" || p.TunnelID == "" || p.Origin == "" || p.InstanceID == "" {
		o.PlatformPending = true
		o.Message = "平台CF托管接入尚未配置，请联系管理员"
		return o
	}
	root, e := publicsuffix.EffectiveTLDPlusOne(b.Hostname)
	if e != nil {
		o.Message = "无法识别根域名"
		return o
	}
	var zones []struct {
		ID      string   `json:"id"`
		Status  string   `json:"status"`
		NS      []string `json:"name_servers"`
		Name    string   `json:"name"`
		Account struct {
			ID string `json:"id"`
		} `json:"account"`
	}
	path := "/zones?name=" + url.QueryEscape(root) + "&account.id=" + url.QueryEscape(p.AccountID)
	if e = p.call(ctx, "GET", path, nil, &zones); e != nil {
		o.Message = e.Error()
		return o
	}
	if len(zones) == 0 && cleanup {
		o.PlatformPending = true
		o.Message = "当前授权范围无法确认原资源，清理暂停，请管理员核对；不会释放域名占用"
		return o
	}

	if len(zones) == 0 {
		ns, err := p.resolver().LookupNS(ctx, root)
		if err != nil {
			o.Message = "当前NS暂时无法确认，请稍后重试"
			return o
		}
		for _, v := range ns {
			if strings.HasSuffix(strings.ToLower(v.Host), ".ns.cloudflare.com.") {
				o.Message = "域名不在当前CF授权账号范围内，请联系平台管理员核对授权，系统不会另建站点"
				return o
			}
		}
		if !p.AllowZoneCreate {
			o.Message = "域名尚未加入平台CF，请联系管理员开通受限站点创建能力"
			return o
		}
		var created struct {
			ID      string   `json:"id"`
			Status  string   `json:"status"`
			NS      []string `json:"name_servers"`
			Name    string   `json:"name"`
			Account struct {
				ID string `json:"id"`
			} `json:"account"`
		}
		if e = p.call(ctx, "POST", "/zones", map[string]any{"name": root, "account": map[string]string{"id": p.AccountID}, "type": "full"}, &created); e != nil {
			o.Message = e.Error()
			return o
		}
		zones = append(zones, created)
	}
	if len(zones) != 1 {
		o.PlatformPending = true
		o.Message = "CF站点身份不唯一，请管理员核对"
		return o
	}
	z := zones[0]
	if z.Name != root || z.Account.ID != p.AccountID || (b.ProviderID != "" && z.ID != b.ProviderID) {
		o.PlatformPending = true
		o.Message = "CF站点身份与绑定不匹配，请管理员核对"
		return o
	}
	o.Nameservers = z.NS
	o.ProviderID = z.ID
	if !cleanup { // Bootstrap the challenge only inside the authorized managed zone.
		var txt []struct {
			Content string `json:"content"`
		}
		tp := "/zones/" + url.PathEscape(z.ID) + "/dns_records"
		if e = p.call(ctx, "GET", tp+"?type=TXT&name="+url.QueryEscape("_kycrm."+b.Hostname), nil, &txt); e != nil {
			o.Message = e.Error()
			return o
		}
		matched := false
		for _, v := range txt {
			if v.Content == b.Challenge {
				matched = true
			}
		}
		if !matched {
			if e = p.call(ctx, "POST", tp, map[string]any{"type": "TXT", "name": "_kycrm." + b.Hostname, "content": b.Challenge, "ttl": 1, "comment": "kycrm-binding:" + p.InstanceID + ":" + b.ID}, nil); e != nil {
				o.Message = e.Error()
				return o
			}
		}
	}
	if !cleanup && z.Status != "active" {
		o.NameserverChangeRequired = true
		o.Message = "等待注册商处的名称服务器修改生效，请核对原站点与邮件记录"
		return o
	}
	if !cleanup {
		if !o.Verified {
			lookup := p.lookupTXT
			if lookup == nil {
				lookup = p.resolver().LookupTXT
			}
			values, err := lookup(ctx, "_kycrm."+b.Hostname)
			if err == nil {
				for _, value := range values {
					if value == b.Challenge {
						o.Verified = true
					}
				}
			}
			if !o.Verified {
				o.Message = "验证记录已由平台自动配置，正在等待DNS生效，无需手动添加TXT"
				return o
			}
		}
		if err := p.requireTunnel(ctx, b); err != nil {
			o.PlatformPending = true
			o.Message = "托管已确认，平台隧道配置待准备。原因：" + err.Error()
			return o
		}
	}
	target := p.TunnelID + ".cfargotunnel.com"
	var records []struct {
		ID      string `json:"id"`
		Type    string `json:"type"`
		Content string `json:"content"`
		Comment string `json:"comment"`
	}
	dnsPath := "/zones/" + url.PathEscape(z.ID) + "/dns_records"
	if e = p.call(ctx, "GET", dnsPath+"?name="+url.QueryEscape(b.Hostname), nil, &records); e != nil {
		o.Message = e.Error()
		return o
	}
	o.Records = append(o.Records, Record{"CNAME", b.Hostname, target})
	marker := "kycrm-binding:" + p.InstanceID + ":" + b.ID
	found := false
	for _, r := range records {
		if r.Comment == marker {
			found = true
			if cleanup {
				if e = p.call(ctx, "DELETE", dnsPath+"/"+url.PathEscape(r.ID), nil, nil); e != nil {
					o.Message = e.Error()
					return o
				}
			} else if r.Type != "CNAME" || r.Content != target {
				o.Message = "平台创建的DNS记录已被修改，请核对后重试"
				return o
			}
		} else if !cleanup {
			o.Message = "目标域名存在其他DNS记录，系统不会覆盖；请由域名管理员处理冲突"
			return o
		}
	}
	if !cleanup && !found {
		if e = p.call(ctx, "POST", dnsPath, map[string]any{"type": "CNAME", "name": b.Hostname, "content": target, "proxied": true, "ttl": 1, "comment": marker}, nil); e != nil {
			o.Message = e.Error()
			return o
		}
	}
	// Per-domain routing is owned by the existing verified loopback gateway.
	// The worker never rewrites the shared Tunnel configuration during binding/cleanup.
	if cleanup {
		var txt []struct {
			ID      string `json:"id"`
			Content string `json:"content"`
			Comment string `json:"comment"`
		}
		if e = p.call(ctx, "GET", dnsPath+"?type=TXT&name="+url.QueryEscape("_kycrm."+b.Hostname), nil, &txt); e != nil {
			o.Message = e.Error()
			return o
		}
		for _, r := range txt {
			if r.Comment == marker {
				if e = p.call(ctx, "DELETE", dnsPath+"/"+url.PathEscape(r.ID), nil, nil); e != nil {
					o.Message = e.Error()
					return o
				}
			}
		}
		o.Deleted = true
		o.Message = "本绑定入口解析已清理，原隧道和CF站点保留；本绑定验证TXT已清理"
		return o
	}

	o.RouteReady = p.Probe(ctx, b)
	o.DNSReady = o.RouteReady
	o.TLSReady = o.RouteReady
	o.Message = "等待DNS和HTTPS入口生效"
	if o.RouteReady {
		o.Message = "CF托管入口验证通过"
	}
	return o
}
func ProbeDigest(b Binding) string {
	h := sha256.Sum256([]byte(b.ID + ":" + fmt.Sprint(b.Generation) + ":" + b.Hostname))
	return hex.EncodeToString(h[:])
}
func (p Provider) Probe(ctx context.Context, b Binding) bool {
	if p.probe != nil {
		return p.probe(ctx, b)
	}
	if len(p.ProbeSecret) < 32 {
		return false
	}
	dialer := &net.Dialer{Timeout: 4 * time.Second}
	transport := &http.Transport{DialContext: func(ctx context.Context, network, addr string) (net.Conn, error) {
		h, port, e := net.SplitHostPort(addr)
		if e != nil || h != b.Hostname || port != "443" {
			return nil, errors.New("invalid probe")
		}
		ips, e := p.resolver().LookupIPAddr(ctx, h)
		if e != nil {
			return nil, e
		}
		for _, ip := range ips {
			if !publicProbeIP(ip.IP) {
				return nil, errors.New("private probe denied")
			}
		}
		for _, ip := range ips {
			c, e := dialer.DialContext(ctx, network, net.JoinHostPort(ip.IP.String(), port))
			if e == nil {
				return c, nil
			}
		}
		return nil, errors.New("probe unavailable")
	}}
	defer transport.CloseIdleConnections()
	c := http.Client{Timeout: 6 * time.Second, Transport: transport, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	req, e := http.NewRequestWithContext(ctx, "GET", "https://"+b.Hostname+"/.well-known/kycrm-entry", nil)
	if e != nil {
		return false
	}
	req.Header.Set("X-KY-Domain-Probe", domainentry.ProbeProof(p.ProbeSecret, b.Hostname, time.Now()))
	res, e := c.Do(req)
	if e != nil {
		return false
	}
	defer res.Body.Close()
	raw, e := io.ReadAll(io.LimitReader(res.Body, 256))
	return e == nil && res.StatusCode == 200 && strings.TrimSpace(string(raw)) == ProbeDigest(b)
}

func publicProbeIP(ip net.IP) bool {
	if ip == nil || !ip.IsGlobalUnicast() || ip.IsPrivate() || ip.IsLoopback() || ip.IsLinkLocalUnicast() {
		return false
	}
	for _, cidr := range []string{"0.0.0.0/8", "100.64.0.0/10", "192.0.0.0/24", "192.0.2.0/24", "198.18.0.0/15", "198.51.100.0/24", "203.0.113.0/24", "240.0.0.0/4", "2001::/23", "2001:db8::/32", "2002::/16"} {
		_, block, _ := net.ParseCIDR(cidr)
		if block.Contains(ip) {
			return false
		}
	}
	if ip.To4() == nil {
		_, global, _ := net.ParseCIDR("2000::/3")
		return global.Contains(ip)
	}
	return true
}

// requireTunnel proves there is no public-IP origin in the configured ingress chain.
// Hostname routing remains in the gateway, so customer binding never edits shared ingress.
func (p Provider) requireTunnel(ctx context.Context, b Binding) error {
	if p.verifyIngress != nil {
		return p.verifyIngress(ctx, b)
	}
	u, e := url.Parse(p.Origin)
	if e != nil || u.Scheme != "http" || (u.Hostname() != "127.0.0.1" && u.Hostname() != "::1") || u.Port() == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || u.Path != "" {
		return errors.New("仅支持隧道到回环网关，禁止公网IP回源")
	}
	if p.AccountID == "" || p.TunnelID == "" {
		return errors.New("平台隧道身份尚未配置")
	}
	var tunnel struct {
		Config struct {
			Ingress []struct {
				Hostname string `json:"hostname"`
				Service  string `json:"service"`
				Origin   struct {
					Host string `json:"httpHostHeader"`
				} `json:"originRequest"`
			} `json:"ingress"`
			Origin struct {
				Host string `json:"httpHostHeader"`
			} `json:"originRequest"`
		} `json:"config"`
	}
	if e = p.call(ctx, "GET", "/accounts/"+url.PathEscape(p.AccountID)+"/cfd_tunnel/"+url.PathEscape(p.TunnelID)+"/configurations", nil, &tunnel); e != nil {
		return e
	}
	matched := false
	for _, rule := range tunnel.Config.Ingress {
		match := rule.Hostname == b.Hostname || rule.Hostname == "" || strings.HasPrefix(rule.Hostname, "*.") && strings.HasSuffix(b.Hostname, rule.Hostname[1:])
		if !match {
			continue
		}
		if rule.Service != p.Origin || rule.Origin.Host != "" || tunnel.Config.Origin.Host != "" {
			return errors.New("隧道路由或Host传递未满足机构入口要求")
		}
		matched = true
		break
	}
	if !matched {
		return errors.New("隧道缺少可识别机构域名的回环网关路由")
	}
	return nil
}
