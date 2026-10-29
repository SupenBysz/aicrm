import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,statSync,writeFileSync,symlinkSync,chmodSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {FileProtectedStorage} from './file-protected-storage.ts';
test('local AES-GCM persists across instances, rejects tampering and never accepts legacy OS ciphertext',()=>{
 const root=mkdtempSync(join(tmpdir(),'kycrm-file-vault-'));
 try{
  const first=new FileProtectedStorage(root);const encrypted=first.encryptString('test fixture secret');
  assert.equal(encrypted.includes(Buffer.from('test fixture secret')),false);
  const second=new FileProtectedStorage(root);assert.equal(second.decryptString(encrypted),'test fixture secret');
  const changed=Buffer.from(encrypted);changed[changed.length-1]^=1;assert.throws(()=>second.decryptString(changed));
  assert.throws(()=>second.decryptString(Buffer.from('old-system-ciphertext')),/no_keychain_migration/);
  if(process.platform!=='win32'){assert.equal(statSync(root).mode&0o777,0o700);assert.equal(statSync(join(root,'master.key')).mode&0o777,0o600);}
 }finally{rmSync(root,{recursive:true,force:true});}
});
test('key symlinks and permissive files are rejected without replacement',()=>{
 if(process.platform==='win32')return;
 const root=mkdtempSync(join(tmpdir(),'kycrm-file-vault-'));const outside=join(root,'outside');
 try{writeFileSync(outside,Buffer.alloc(32),{mode:0o600});symlinkSync(outside,join(root,'master.key'));assert.equal(new FileProtectedStorage(root).isEncryptionAvailable(),false);rmSync(join(root,'master.key'));writeFileSync(join(root,'master.key'),Buffer.alloc(32),{mode:0o600});chmodSync(join(root,'master.key'),0o644);assert.equal(new FileProtectedStorage(root).isEncryptionAvailable(),false);}finally{rmSync(root,{recursive:true,force:true});}
});
