export interface LogWindow {startAt:string;endBefore:string}
export function recentLogWindow(now=Date.now()):LogWindow{return {startAt:new Date(now-86400000).toISOString(),endBefore:new Date(now).toISOString()};}
export function validLogWindow(range:LogWindow):boolean{
 const start=Date.parse(range.startAt),end=Date.parse(range.endBefore);
 return Number.isFinite(start)&&Number.isFinite(end)&&end>start&&end-start<=31*86400000;
}
export function shanghaiInput(iso:string):string{const time=Date.parse(iso);return Number.isFinite(time)?new Date(time+8*3600000).toISOString().slice(0,19):"";}
export function inputToTimestamp(local:string):string{return local?`${local}+08:00`:"";}
