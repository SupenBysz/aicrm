/** 本地开发签名 CLI；不输出私钥、签名原文或环境值。 */
import { readFile, writeFile, mkdir, lstat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { sha, parse, publicKey, bundle } from './package-format.mjs';
import { ensure, CAPABILITIES, PLUGIN_ID } from '../../packages/desktop-plugin-contracts/src/index.ts';
const args=process.argv.slice(2);const opts={};for(let i=1;i<args.length;i+=2){ensure(args[i]?.startsWith('--')&&args[i+1]);opts[args[i].slice(2)]=args[i+1];}
try {
ensure(args[0]==='release','用法：node scripts/desktop-plugins/sign.mjs release --private-key 路径 --public-key 路径 --source 目录 --output 目录 --sequence 整数');
const keyPath=resolve(opts['private-key']);const stat=await lstat(keyPath), parent=await lstat(dirname(keyPath));ensure(stat.isFile()&&!stat.isSymbolicLink()&&parent.isDirectory()&&!parent.isSymbolicLink()&&(stat.mode&0o777)===0o600&&(parent.mode&0o777)===0o700&&stat.uid===process.getuid?.(),'私钥权限或所有者无效');
const privateKey=createPrivateKey(await readFile(keyPath));ensure(privateKey.asymmetricKeyType==='ed25519');const pub=parse(await readFile(opts['public-key']),4096);const pk=publicKey(pub);ensure(createPublicKey(privateKey).export({format:'der',type:'spki'}).equals(pk.export({format:'der',type:'spki'})),'公私钥不一致');
const source=resolve(opts.source),output=resolve(opts.output);const man=parse(await readFile(source+'/manifest.json'),65536);const data=await readFile(source+'/plugin.js');const signed=(payload,domain)=>{const raw=Buffer.from(JSON.stringify(payload));return {schemaVersion:1,keyId:pub.keyId,signedMetadata:raw.toString('base64'),signature:sign(null,Buffer.concat([Buffer.from(domain+'\n'),raw]),privateKey).toString('base64')};};
const pkg={...signed({manifest:man,files:[{path:'plugin.js',size:data.length,sha256:sha(data)}]},'kww-desktop-plugin:v1'),files:[{path:'plugin.js',contentBase64:data.toString('base64')}]};const bytes=Buffer.from(JSON.stringify(pkg));bundle(bytes,pub);const filename=sha(bytes)+'.kwwplugin.json';const now=Date.now(), time=t=>new Date(t).toISOString().replace(/\.\d{3}Z$/,'Z');const expiry=time(now+30*86400000);const seq=Number(opts.sequence);ensure(Number.isSafeInteger(seq)&&seq>0);
const pol={schemaVersion:1,kind:'desktop-plugin-trust-policy',policyVersion:Number(opts['policy-version']??1),channel:'dev',keyId:pub.keyId,pluginId:PLUGIN_ID,capabilities:[...CAPABILITIES],notBefore:time(now-60000),expiresAt:expiry,revokedPackageDigests:[]};
await mkdir(output,{recursive:true});
// 同版本策略复用精确字节，不能每次发布改有效期造成同序号异内容。
let policyBytes;try {policyBytes=await readFile(output+'/policy.json');const old=parse(Buffer.from(parse(policyBytes).signedMetadata,'base64'));ensure(old.policyVersion===pol.policyVersion&&Date.parse(old.expiresAt)>now,'策略版本冲突或过期');pol.expiresAt=old.expiresAt;}catch(e){if(e.code!=='ENOENT')throw e;policyBytes=Buffer.from(JSON.stringify(signed(pol,'kww-desktop-plugin-policy:v1')));}
await writeFile(output+'/'+filename,bytes,{flag:'wx'}).catch(e=>{if(e.code!=='EEXIST')throw e;});await writeFile(output+'/policy.json',policyBytes);
const idx={schemaVersion:1,kind:'desktop-plugin-release-index',channel:'dev',pluginId:PLUGIN_ID,policyVersion:pol.policyVersion,releaseSequence:seq,version:man.version,packageSha256:sha(bytes),packageBytes:bytes.length,fileName:filename,expiresAt:pol.expiresAt};await writeFile(output+'/index.json',JSON.stringify(signed(idx,'kww-desktop-plugin-index:v1')));console.log(JSON.stringify({结果:'签名完成',插件版本:man.version,序号:seq,包:filename,目录:output}));
}catch{console.error('签名失败：请检查参数、专用密钥权限、公私钥一致性及策略版本；未输出原始异常。');process.exitCode=1;}
