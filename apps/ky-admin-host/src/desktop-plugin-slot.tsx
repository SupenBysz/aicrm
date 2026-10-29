import { useEffect, useState } from 'react';
import { getDesktopBridge } from './desktop-client';
import { ClientVersion } from './client-version';
import type { DesktopPluginSnapshot } from '../../aicrm-desktop/src/shared/types';
/** 单一 UI 订阅：先订阅缓冲，再以序号快照收敛。 */
export function DesktopPluginSlot(){const [snapshot,setSnapshot]=useState<DesktopPluginSnapshot|null>(null);
useEffect(()=>{const bridge=getDesktopBridge()?.desktopPlugins;if(!bridge)return;let live=true,started=false;let latest:DesktopPluginSnapshot|null=null;let buffered:DesktopPluginSnapshot[]=[];
const epochs=new Set<string>();const apply=(s:DesktopPluginSnapshot)=>{if(!live)return;if(!latest){epochs.add(s.runtimeEpoch);}else if(s.runtimeEpoch!==latest.runtimeEpoch){if(epochs.has(s.runtimeEpoch))return;epochs.add(s.runtimeEpoch);}else if(s.nativeSequence<latest.nativeSequence)return;latest=s;setSnapshot(s);};
const off=bridge.onChanged(s=>{if(!started){buffered.push(s);if(buffered.length>64)buffered=buffered.slice(-1);return;}if(latest&&s.runtimeEpoch===latest.runtimeEpoch&&s.nativeSequence>latest.nativeSequence+1){void bridge.getSnapshot().then(apply).catch(()=>{});return;}apply(s);});
void bridge.registerUi({uiApiVersion:'1.0.0',slots:['statusBar.right']}).then(s=>{apply(s);started=true;buffered.forEach(apply);buffered=[];}).catch(()=>{});
return()=>{live=false;off();void bridge.unregisterUi().catch(()=>{});};},[]);
useEffect(()=>{if(snapshot?.confirmation)void getDesktopBridge()?.desktopPlugins?.ackRendered(snapshot.confirmation).catch(()=>{});},[snapshot]);
if(!snapshot?.items.length)return <ClientVersion/>;
return <><ClientVersion/>{snapshot.items.map(item=>item.type==='button'?<button className="desktop-plugin-item" key={item.id} title={item.title} onClick={()=>void getDesktopBridge()?.desktopPlugins?.action({actionId:item.actionId!,activeRevision:snapshot.activeRevision}).catch(()=>{})}>{item.text}</button>:<span className="desktop-plugin-item" key={item.id} title={item.title}>{item.text}</span>)}</>;
}
