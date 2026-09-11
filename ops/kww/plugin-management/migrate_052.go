package main

import (
 "context"
 "fmt"
 "os"
 "time"
 "github.com/jackc/pgx/v5"
)

func fail(message string) { fmt.Fprintln(os.Stderr, message); os.Exit(1) }
func main() {
 ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second); defer cancel()
 dsn := os.Getenv("KY_TENANT_DATABASE_URL"); if dsn == "" { fail("缺少服务器数据库配置") }
 c, err := pgx.Connect(ctx, dsn); if err != nil { fail("数据库连接失败，未输出连接凭据") }; defer c.Close(context.Background())
 counts := func(stage string) {
  var permissions, links, unexpected int
  err = c.QueryRow(ctx, `SELECT count(*) FROM ky_permission WHERE code IN ('menu.platform.plugin_management','platform.plugin_management.view')`).Scan(&permissions)
  if err != nil { fail("权限计数失败") }
  err = c.QueryRow(ctx, `SELECT count(*),count(*) FILTER (WHERE rp.role_id NOT IN ('role_platform_owner','role_platform_admin')) FROM ky_role_permission rp JOIN ky_permission p ON p.id=rp.permission_id WHERE p.code IN ('menu.platform.plugin_management','platform.plugin_management.view')`).Scan(&links,&unexpected)
  if err != nil || unexpected != 0 { fail("权限关联核对失败") }
  fmt.Printf("%s：权限=%d，角色关联=%d，非目标角色关联=%d\n",stage,permissions,links,unexpected)
  if stage != "执行前" && (permissions != 2 || links != 4) { fail("权限种子未达到预期数量") }
 }
 counts("执行前")
 if len(os.Args) == 2 && os.Args[1] == "--apply" {
  sql, err := os.ReadFile("/data/kww.org.cn/aicrm/ops/db/052_plugin_management_permissions.sql")
  if err != nil { fail("无法读取指定的 052 权限种子") }
  if _, err = c.Exec(ctx,string(sql)); err != nil { fail("052 权限种子执行失败，事务未完成") }
  counts("首次执行后")
  if _, err = c.Exec(ctx,string(sql)); err != nil { fail("052 幂等校验执行失败") }
  counts("幂等执行后")
 } else if len(os.Args) != 1 { fail("不支持的参数") }
}
