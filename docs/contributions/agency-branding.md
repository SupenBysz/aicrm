# 机构品牌发布与继承

依赖系统设置版权增量。平台通过独立品牌抽屉管理草稿、应用名称、独立图标文字、PNG图标/透明文字LOGO、版权主体和风格；留空字段在有效配置中继承平台，未发布机构使用平台品牌。版权主体来自平台资料，无真实公司默认值。应用图标仅供Web品牌资产，未引入客户端安装分发或原生图标签名。

## 权限与API

`platform.agency_branding.view/update/publish`分别控制查看、编辑和发布，迁移只注册权限，不自动授予角色。路由前缀 `/api/v1/platform/agencies/{id}/branding`：GET读取，POST draft（expectedRevision,draft），POST assets（kind,pngBase64），GET assets/{assetId}鉴权预览，POST publish（expectedRevision,rollbackVersion），GET history（最近100个可选历史版本）。字段长度、PNG4MB/像素预算、素材机构归属由后端检查。版本冲突409，输入保留。

`/api/v1/organizations/current/branding`仅根据服务端已验证工作区获取机构或企业的有效品牌，不接受客户端机构ID。Host加载时显示中性状态，作用域变化丢弃旧响应；失败可重试。平台Profile不再竞争写入document.title，工作区或登录页持有标题。初始HTML标题为中性文案。

`/api/v1/public/brand-assets/{assetId}`只读取已发布过、所属机构仍有效的素材。草稿不能通过可猜ID公开读取。鉴权草稿预览不缓存；公开不可变素材可缓存。历史发布资产仍公开，品牌素材不作为业务机密存储。

发布快照不可变，回滚产生新版本。有效fingerprint包含当前继承后的配置，平台字段变化会使继承结果失效，但不改写历史版本。发布和草稿更新均与Org持久变更记录同事务。发布URL默认同源相对路径，可用 `KY_BRAND_PUBLIC_URL` 指定受控HTTPS素材源；不得配置客户环境或生产凭据到模板。

## 部署与回退

依次迁移100、102，按示例授予Org表权限并由管理员分配操作权限，然后部署Org、Host和插件。没有新增跨所有者外键或写权限。回退保留素材、快照和记录；旧Host会忽略机构品牌，不应作为已开放机构入口的回退方案。公开机构登录品牌由后续域名PR实现，本批不通过URL参数猜测机构。

## 验证

构建、类型检查和Org测试；独立数据库验证素材归属、草稿不可公开、CAS、发布/回滚和审计失败回滚。预览与Host共享实际尺寸、曲线与调色变量，外层浅灰。真实浏览器的慢请求、窄屏、图片失败和工作区切换仍需验收，不能以编译代替。
