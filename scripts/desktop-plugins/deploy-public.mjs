/** 在服务器既有 Codex 会话执行；只部署已验签公共产物。 */
import {readFile,mkdir,writeFile,rename,chmod} from 'node:fs/promises';import {resolve,join} from 'node:path';
import {parse,policy,index,bundle,sha} from './package-format.mjs';
import {ensure} from '../../packages/desktop-plugin-contracts/src/index.ts';
const source=resolve(process.argv[2]??'');const destination='/data/kww.org.cn/runtime/www/ky-admin-host/desktop-plugin-releases/dev';
try{ensure(process.argv.length===3);const build=parse(await readFile(new URL('../../apps/aicrm-desktop/resources/desktop-plugin-dev-policy.json',import.meta.url)));const pb=await readFile(join(source,'policy.json')),ib=await readFile(join(source,'index.json'));const p=policy(pb,build.publicKey),i=index(ib,build.publicKey,p),bb=await readFile(join(source,i.fileName));const pkg=bundle(bb,build.publicKey);ensure(pkg.digest===i.packageSha256&&bb.length===i.packageBytes&&pkg.manifest.version===i.version&&!p.revokedPackageDigests.includes(pkg.digest));await mkdir(destination,{recursive:true,mode:0o755});
for(const [name,data] of [[i.fileName,bb],['policy.json',pb],['index.json',ib]]){const temp=join(destination,name+'.next');await writeFile(temp,data,{mode:0o644});await chmod(temp,0o644);await rename(temp,join(destination,name));}
console.log(JSON.stringify({结果:'公共产物验签并部署',版本:i.version,序号:i.releaseSequence,digest:pkg.digest,目录:destination}));
}catch{console.error('公共产物验证或部署失败，未输出原始异常');process.exitCode=1;}
