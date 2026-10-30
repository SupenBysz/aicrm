#!/usr/bin/env python3
"""Real HTTP acceptance on an owned disposable loopback PostgreSQL database.
Requires KY_LIST_OVERVIEW_TEST_DATABASE_URL pointing to a local test cluster,
with no embedded password, and a test role allowed to create databases.
No production credentials, OS keychain, external provider calls or user sessions.
"""
import base64, hashlib, hmac, json, os, secrets, socket, subprocess, tempfile, time
from pathlib import Path
from urllib.parse import urlparse, urlunparse, urlencode
from urllib.request import Request, build_opener, ProxyHandler, HTTPRedirectHandler
from urllib.error import HTTPError

ROOT=Path(__file__).resolve().parents[1]
class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self,*args,**kwargs):return None

def run(cmd,**kwargs):
    result=subprocess.run(cmd,text=True,capture_output=True,**kwargs)
    if result.returncode:raise RuntimeError(f'{cmd[0]} failed: {result.stderr[-1800:]}')
    return result.stdout

def main():
    base=os.environ.get('KY_LIST_OVERVIEW_TEST_DATABASE_URL','')
    if not base:raise SystemExit('An isolated local test DSN is required')
    parsed=urlparse(base)
    assert parsed.hostname in ('127.0.0.1','localhost') and not parsed.password
    assert parsed.path.endswith('_test') or parsed.path.startswith('/kycrm_test_')
    name='kycrm_test_overviews_http_'+str(time.time_ns())
    dsn=urlunparse(parsed._replace(path='/'+name))
    processes=[];created=False;temp=tempfile.TemporaryDirectory(prefix='kycrm-overview-http-')
    tmp=Path(temp.name);key=secrets.token_hex(32);ports={};opener=build_opener(ProxyHandler({}),NoRedirect())
    def sql(statement):return run(['psql',dsn,'-X','-v','ON_ERROR_STOP=1','-At'],input=statement)
    def token(user,session):
        payload={'userId':user,'sessionId':session,'exp':int(time.time())+3600}
        b64=lambda b:base64.urlsafe_b64encode(b).decode().rstrip('=')
        body=b64(json.dumps(payload,separators=(',',':')).encode())
        return body+'.'+b64(hmac.new(key.encode(),body.encode(),hashlib.sha256).digest())
    def request(service,path,actor='owner',ws='platform',wid='platform_root',want=200):
        headers={'X-KY-Workspace-Type':ws,'X-KY-Workspace-Id':wid,'X-KY-Request-Id':'overview-isolated-http'}
        if actor:headers['Authorization']='Bearer '+actors[actor]
        req=Request('http://127.0.0.1:'+str(ports[service])+path,headers=headers)
        try:
            with opener.open(req,timeout=8) as r:status,raw=r.status,r.read()
        except HTTPError as e:status,raw=e.code,e.read()
        assert status==want,(service,path,status,raw[:250])
        return json.loads(raw).get('data') if raw.startswith(b'{') else None
    try:
        run(['createdb','--maintenance-db='+base,name]);created=True
        env={**os.environ,'KY_TENANT_DATABASE_URL':dsn,'KY_EXECUTE_DATABASE_DEPLOY':'1'}
        run(['bash',str(ROOT/'scripts/deploy_database.sh')],env=env,cwd=ROOT)
        sql("""INSERT INTO ky_user(id,username,display_name) VALUES('ov_denied','ov_denied','Denied'),('ov_self','ov_self','Self'),('ov_agency','ov_agency','Agency');
INSERT INTO ky_membership(id,user_id,workspace_type,workspace_id,display_name) VALUES('ov_denied','ov_denied','platform','platform_root','Denied'),('ov_self','ov_self','platform','platform_root','Self'),('ov_agency','ov_agency','agency','ov_a','Agency');
INSERT INTO ky_role(id,workspace_type,workspace_id,name,code) VALUES('ov_self_role','platform','platform_root','Self','ov_self'),('ov_agency_role','agency','ov_a','Agency','ov_agency');
INSERT INTO ky_membership_role(id,membership_id,role_id,workspace_type,workspace_id) VALUES('ov_mr1','ov_self','ov_self_role','platform','platform_root'),('ov_mr2','ov_agency','ov_agency_role','agency','ov_a');
INSERT INTO ky_role_permission(id,role_id,permission_id) SELECT 'ov_rp_'||id,'ov_self_role',id FROM ky_permission WHERE code IN ('platform.members.view','platform.invitations.view');
INSERT INTO ky_role_permission(id,role_id,permission_id) SELECT 'ov_ar_'||id,'ov_agency_role',id FROM ky_permission WHERE code='agency.enterprises.view';
INSERT INTO ky_role_data_scope(id,role_id,scope_type) VALUES('ov_scope','ov_self_role','self');
INSERT INTO ky_user_session(id,user_id,token_id,expires_at) VALUES('ov_owner','user_platform_owner','ov_owner',now()+interval '1 hour'),('ov_denied','ov_denied','ov_denied',now()+interval '1 hour'),('ov_self','ov_self','ov_self',now()+interval '1 hour'),('ov_agency','ov_agency','ov_agency',now()+interval '1 hour');
INSERT INTO ky_agency(id,name,code,status) VALUES('ov_a','OverviewFixture A','ov_a','normal'),('ov_b','OverviewFixture B','ov_b','disabled');
INSERT INTO ky_enterprise(id,name,code,agency_id,status) VALUES('ov_ea','OverviewFixture A','ov_ea','ov_a','normal'),('ov_eb','OverviewFixture B','ov_eb','ov_b','disabled');
INSERT INTO ky_qualification(id,target_type,target_id,qualification_type,status) VALUES('ov_q','agency','ov_a','test','submitted');
INSERT INTO ky_invitation(id,workspace_type,workspace_id,invited_by_membership_id,token,status,expires_at) VALUES('ov_future','platform','platform_root','ov_self','ov_future','pending',now()+interval '1 day'),('ov_expired','platform','platform_root','ov_self','ov_expired','pending',now()-interval '1 day'),('ov_other','platform','platform_root','mem_platform_owner','ov_other','pending',now()+interval '1 day');
INSERT INTO ky_matrix_account(id,workspace_type,workspace_id,platform,display_name,status,login_status) VALUES('ov_m1','platform','platform_root','douyin','OverviewFixture 1','normal','online'),('ov_m2','platform','platform_root','douyin','OverviewFixture 2','normal','expired'),('ov_m3','platform','platform_root','douyin','OverviewFixture 3','disabled','expired');
INSERT INTO ky_login_log(id,login_account,result,created_at) VALUES('ov_l1','Alice','success','2026-01-01T00:00:00Z'),('ov_l2','Alice','failed','2026-01-01T01:00:00Z'),('ov_l3','Alice','failed','2026-01-01T02:00:00Z'),('ov_l4','alice','failed','2026-01-01T03:00:00Z'),('ov_l5','Alice','success','2026-01-02T00:00:00Z');
""")
        actors={'owner':token('user_platform_owner','ov_owner'),'denied':token('ov_denied','ov_denied'),'self':token('ov_self','ov_self'),'agency':token('ov_agency','ov_agency')}
        services=['auth','org','membership','matrix-account']
        for service in services:
            run(['go','build','-o',str(tmp/service),'./services/ky-'+service+'-service/cmd/server'],cwd=ROOT)
            with socket.socket() as sock:sock.bind(('127.0.0.1',0));ports[service]=sock.getsockname()[1]
        for service in services:
            env={**os.environ,'KY_RUNTIME_ENV_FILE':'','KY_NATS_URL':'','KY_REDIS_URL':'','KY_AI_MODEL_SERVICE_URL':'http://127.0.0.1:1','KY_TENANT_DATABASE_URL':dsn,'KY_AUTH_TOKEN_SECRET':key,'KY_SECRET_KEY':secrets.token_hex(16),'KY_DOMAIN_ENTRY_ENABLED':'0','KY_DOMAIN_MANAGED_ENABLED':'0','KY_DOMAIN_AUTOMATION_READY':'0','KY_DOMAIN_ORIGIN_ISOLATED':'0','KY_INTERNAL_SERVICE_TOKEN':secrets.token_hex(24)}
            for other in services:env['KY_'+other.upper().replace('-','_')+'_SERVICE_URL']='http://127.0.0.1:'+str(ports[other])
            env['KY_'+service.upper().replace('-','_')+'_SERVICE_HTTP_ADDR']='127.0.0.1:'+str(ports[service])
            log=open(tmp/(service+'.log'),'w');processes.append(subprocess.Popen([str(tmp/service)],env=env,cwd=tmp,stdout=log,stderr=subprocess.STDOUT))
        for _ in range(60):
            try:
                for service in services:request(service,'/readyz',actor=None)
                break
            except Exception:time.sleep(.2)
        else:raise AssertionError('Isolated services did not become ready')
        window=urlencode({'startAt':'2026-01-01T00:00:00Z','endBefore':'2026-01-02T00:00:00Z'})
        endpoints=[('org','/api/v1/platform/agencies/summary'),('org','/api/v1/platform/enterprises/summary'),('org','/api/v1/platform/qualifications/summary'),('membership','/api/v1/workspace/members/summary'),('membership','/api/v1/invitations/summary'),('matrix-account','/api/v1/matrix-accounts/summary'),('auth','/api/v1/login-logs/summary?'+window)]
        for service,path in endpoints:
            data=request(service,path);assert data['schemaVersion']==1
            request(service,path,actor=None,want=401);request(service,path,actor='denied',want=403)
            request(service,path,wid='unrelated',want=403)
            request(service,path+('&' if '?' in path else '?')+'page=1',want=400)
        a=request('org','/api/v1/platform/agencies/summary?keyword=OverviewFixture');assert a['total']==2
        d=request('org','/api/v1/platform/agencies?keyword=OverviewFixture&status=disabled&page=1&pageSize=1');assert d['pagination']['total']==1
        assert request('org','/api/v1/agency/enterprises/summary',actor='agency',ws='agency',wid='ov_a')['total']==1
        request('org','/api/v1/agency/enterprises/summary?agencyId=ov_b',actor='agency',ws='agency',wid='ov_a',want=400)
        assert request('membership','/api/v1/workspace/members/summary',actor='self')['total']==1
        inv=request('membership','/api/v1/invitations/summary',actor='self');assert inv['total']==2
        inv=request('membership','/api/v1/invitations?effectiveStatus=expired&page=1&pageSize=10',actor='self');assert inv['filterVersion']==1 and inv['pagination']['total']==1 and inv['items'][0]['effectiveStatus']=='expired' and inv['items'][0]['status']=='pending'
        assert sql("SELECT status FROM ky_invitation WHERE id='ov_expired'").strip()=='pending'
        request('membership','/api/v1/invitations?status=pending&effectiveStatus=expired',want=400)
        request('membership','/api/v1/invitations?status=&effectiveStatus=expired',want=400)
        mat=request('matrix-account','/api/v1/matrix-accounts?platform=douyin&attention=required&page=1&pageSize=10');assert mat['filterVersion']==1 and mat['pagination']['total']==1
        request('matrix-account','/api/v1/matrix-accounts?attention=required&status=disabled',want=400)
        log=request('auth','/api/v1/login-logs/summary?'+window);counts={x['key']:x['count'] for x in log['metrics']};assert log['total']==4 and counts['failed']==3 and counts['failedAccounts']==2
        rows=request('auth','/api/v1/login-logs?'+window+'&result=failed&page=1&pageSize=1');assert rows['filterVersion']==1 and rows['pagination']['total']==3 and len(rows['items'])==1
        old=request('auth','/api/v1/login-logs?startAt=2026-01-01T00:00:00Z&endAt=2026-01-02T00:00:00Z');assert old['pagination']['total']==5
        request('auth','/api/v1/login-logs/summary?startAt=2026-01-01T00:00:00Z&endBefore=2026-03-01T00:00:00Z',want=400)
        sql("UPDATE ky_user_session SET status='revoked' WHERE id='ov_denied'")
        for service,path in endpoints:request(service,path,actor='denied',want=401)
        # Component-center permission is a page binding on one existing menu group.
        menu_path='/api/v1/menu-directory/management/visible'
        visible=request('membership',menu_path)
        nodes=[x for x in visible['items'] if x['menuKey']=='ky-component-center.catalog']
        assert len(nodes)==1 and nodes[0]['parentKey']=='group.ky-system-settings'
        assert not any(x['menuKey']=='ky-component-center.catalog' for x in request('membership',menu_path,actor='self')['items'])
        assert not any(x['menuKey']=='ky-component-center.catalog' for x in request('membership',menu_path,actor='agency',ws='agency',wid='ov_a')['items'])
        sql("UPDATE ky_menu_directory SET status='disabled' WHERE menu_key='ky-component-center.catalog'")
        assert not any(x['menuKey']=='ky-component-center.catalog' for x in request('membership',menu_path)['items'])
        sql("UPDATE ky_menu_directory SET status='active' WHERE menu_key='ky-component-center.catalog'")
        request('membership',menu_path,actor=None,want=401)
        print('PASS: component-center owner menu, denied identity, agency scope, disabled menu and anonymous rejection')
        # Local 10k-row sample only, not a claim about production load or concurrency.
        sql("INSERT INTO ky_agency(id,name,code,status) SELECT 'ov_bulk_'||n,'BulkFixture '||n,'ov_bulk_'||n,'normal' FROM generate_series(1,10000) n")
        durations=[]
        for _ in range(100):
            start=time.perf_counter();request('org','/api/v1/platform/agencies/summary');durations.append((time.perf_counter()-start)*1000)
        print('PASS: seven HTTP summaries, authentication/permissions/workspace denial, self/inviter/agency scope, query rejection, effective expiry read-only, list filter versions, log boundaries and revocation')
        print('LOCAL PERFORMANCE ONLY: 100 sequential samples, 10002+ agency rows, P95_ms=%.2f'%sorted(durations)[94])
    finally:
        for p in processes:p.terminate()
        for p in processes:
            try:p.wait(timeout=5)
            except subprocess.TimeoutExpired:p.kill();p.wait()
        if created:run(['dropdb','--maintenance-db='+base,name])
        temp.cleanup()
if __name__=='__main__':main()
