#!/usr/bin/env python3
"""Explicit local test DSN only. Creates/drops owned databases; never reads secrets."""
import os, subprocess, tempfile, shutil, time
from pathlib import Path
from urllib.parse import urlparse, urlunparse
ROOT=Path(__file__).resolve().parents[1]
def run(cmd,**kwargs):
 r=subprocess.run(cmd,text=True,capture_output=True,**kwargs)
 if r.returncode:raise RuntimeError(r.stderr[-2000:])
 return r.stdout

def main():
 base=os.environ.get('KY_COMPONENT_TEST_DATABASE_URL','');u=urlparse(base)
 if u.hostname not in ('localhost','127.0.0.1') or u.password or not(u.path.endswith('_test') or u.path.startswith('/kycrm_test_')):raise SystemExit('Set a password-free loopback test DSN, explicitly named *_test / kycrm_test_*')
 with tempfile.TemporaryDirectory(prefix='kycrm-component-db-') as folder:
  tmp=Path(folder);(tmp/'scripts').mkdir();(tmp/'ops/db').mkdir(parents=True);shutil.copy(ROOT/'scripts/deploy_database.sh',tmp/'scripts')
  for p in (ROOT/'ops/db').glob('[0-9][0-9][0-9]_*.sql'):
   if int(p.name[:3])<=110:shutil.copy(p,tmp/'ops/db')
  for mode in ('fresh','upgrade'):
   name='kycrm_test_components_'+mode+'_'+str(time.time_ns());dsn=urlunparse(u._replace(path='/'+name));created=False
   def sql(text):return run(['psql',dsn,'-XAt','-v','ON_ERROR_STOP=1'],input=text).strip()
   try:
    run(['createdb','--maintenance-db='+base,name]);created=True
    env={**os.environ,'KY_TENANT_DATABASE_URL':dsn,'KY_EXECUTE_DATABASE_DEPLOY':'1'}
    if mode=='upgrade':
     run(['bash',str(tmp/'scripts/deploy_database.sh')],env=env)
     sql("INSERT INTO ky_menu_directory(directory_type,menu_key,node_type,parent_key,name,icon,permission_code,workspace_types,route_key,route_path,page_type,status,sort_order,permission_bindings,source_version) VALUES('management','ky-component-center.catalog','leaf','group.ky-system-settings','自定义组件入口','AppstoreOutlined','','[\"platform\"]','ky-component-center.catalog','/system/components','internal','disabled',77,'{\"platform\":[\"platform.component_center.view\"]}',1);")
    for _ in range(2):run(['bash',str(ROOT/'scripts/deploy_database.sh')],env=env)
    assert sql("SELECT category||'|'||workspace_types::text FROM ky_permission WHERE code='platform.component_center.view'")=='page|["platform"]'
    assert sql("SELECT count(*) FROM ky_role_permission rp JOIN ky_permission p ON p.id=rp.permission_id WHERE p.code='platform.component_center.view'")=='1'
    assert sql("SELECT r.code FROM ky_role_permission rp JOIN ky_permission p ON p.id=rp.permission_id JOIN ky_role r ON r.id=rp.role_id WHERE p.code='platform.component_center.view'")=='platform_owner'
    assert sql("SELECT count(*) FROM ky_menu_directory WHERE menu_key='group.ky-component-center'")=='0'
    assert sql("SELECT parent_key||'|'||permission_bindings::text FROM ky_menu_directory WHERE menu_key='ky-component-center.catalog'")=='group.ky-system-settings|{"platform": ["platform.component_center.view"]}'
    if mode=='upgrade':assert sql("SELECT name||'|'||status||'|'||sort_order FROM ky_menu_directory WHERE menu_key='ky-component-center.catalog'")=='自定义组件入口|disabled|77'
    assert sql("SELECT count(*) FROM ky_schema_migration WHERE filename='111_component_center.sql'")=='1'
    print('PASS:',mode,'migration, idempotency, owner-only grant and menu preservation',flush=True)
   finally:
    if created:run(['dropdb','--maintenance-db='+base,name])
if __name__=='__main__':main()
