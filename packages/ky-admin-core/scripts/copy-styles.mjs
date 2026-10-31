import {readdirSync,mkdirSync,copyFileSync} from 'node:fs';
import {resolve,relative,dirname,join} from 'node:path';
const source=resolve(import.meta.dirname,'../src');
const output=resolve(import.meta.dirname,'../dist');
let count=0;
function copyDirectory(directory){
 for(const entry of readdirSync(directory,{withFileTypes:true})){
  const path=join(directory,entry.name);
  if(entry.isDirectory())copyDirectory(path);
  else if(entry.isFile()&&entry.name.endsWith('.css')){
   const target=join(output,relative(source,path));
   mkdirSync(dirname(target),{recursive:true});
   copyFileSync(path,target);
   count++;
  }
 }
}
copyDirectory(source);
console.log(`Copied ${count} Core stylesheet(s) into dist`);
