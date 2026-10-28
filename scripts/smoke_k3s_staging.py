#!/usr/bin/env python3
"""Authenticated, non-destructive acceptance checks; never print credentials."""
import argparse,json,urllib.request,urllib.error
from pathlib import Path

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self,*args,**kwargs): return None

def main():
    p=argparse.ArgumentParser();p.add_argument('--credentials-file',required=True);args=p.parse_args()
    credentials=json.loads(Path(args.credentials_file).read_text())
    password=credentials.get('password') or credentials['admin_password']
    base='https://console.kysion.com'
    opener=urllib.request.build_opener(NoRedirect)
    token=None
    def call(method,path,data=None,workspace=True,expected=(200,)):
        headers={'User-Agent':'KyCRM-Deployment-Acceptance/1.0','Accept':'application/json'}
        if token:headers['Authorization']='Bearer '+token
        if workspace:headers.update({'X-KY-Workspace-Type':'platform','X-KY-Workspace-Id':'platform_root'})
        if data is not None:headers['Content-Type']='application/json'
        r=urllib.request.Request(base+path,headers=headers,data=json.dumps(data).encode() if data is not None else None,method=method)
        try:
            with opener.open(r,timeout=20) as f:status,raw=f.status,f.read()
        except urllib.error.HTTPError as e:status,raw=e.code,e.read()
        if status not in expected:raise RuntimeError(f'{method} {path}: HTTP {status}')
        print(f'{method} {path}: {status}')
        try:return json.loads(raw).get('data')
        except (ValueError,AttributeError):return None
    call('GET','/healthz',workspace=False)
    call('GET','/api/v1/auth/me',workspace=False,expected=(401,))
    call('GET','/internal/v1/access-decisions',workspace=False,expected=(404,))
    call('GET','/api/not-an-api',workspace=False,expected=(404,))
    token=call('POST','/api/v1/auth/login',{'account':'Super.Admin','password':password},False)['token']
    try:
        bootstrap=call('GET','/api/v1/auth/bootstrap',workspace=False)
        assert any(w['id']=='platform_root' and w['type']=='platform' for w in bootstrap['workspaces'])
        for path in ['/api/v1/roles','/api/v1/permissions','/api/v1/platform/agencies','/api/v1/platform/enterprises','/api/v1/platform/platform-profile','/api/v1/matrix-accounts','/api/v1/ai-models/providers']:
            call('GET',path)
        health=call('GET','/api/v1/platform/plugin-management/service-health')
        if not health or any(x['state']!='healthy' for x in health['services']):raise RuntimeError('plugin service health not healthy')
        call('GET','/api/v1/ai-executor-tasks',expected=(503,))
    finally:
        call('POST','/api/v1/auth/logout',{},False)
    call('GET','/api/v1/auth/me',workspace=False,expected=(401,))
    print('Authenticated API acceptance passed; test session revoked')

if __name__=='__main__':main()
