import { DESKTOP_APPLICATION_VERSION } from "../shared/constants";
import { getPluginHost } from "./desktop-plugin-host/host";
import { loadDesktopConfig } from "./config";
import { BrowserWindow, dialog } from "electron";
import { Menu, app } from "electron";
import { isDesktopDebugMode } from "./runtime-mode";

export function installApplicationMenu() {
  const viewSubmenu: Electron.MenuItemConstructorOptions[] = [
    { role: "reload", label: "重新加载" },
    ...(isDesktopDebugMode() ? [{ role: "toggleDevTools" as const, label: "开发者工具" }] : []),
    { type: "separator" },
    { role: "resetZoom", label: "实际大小" },
    { role: "zoomIn", label: "放大" },
    { role: "zoomOut", label: "缩小" },
    { type: "separator" },
    { role: "togglefullscreen", label: "全屏" }
  ];

  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: app.name,
      submenu: [{ role: "about" }, { type: "separator" }, { role: "quit", label: "退出" }]
    },
    {
      label: "编辑",
      submenu: [
        { role: "undo", label: "撤销" },
        { role: "redo", label: "重做" },
        { type: "separator" },
        { role: "cut", label: "剪切" },
        { role: "copy", label: "复制" },
        { role: "paste", label: "粘贴" },
        { role: "selectAll", label: "全选" }
      ]
    },
    {
      label: "视图",
      submenu: viewSubmenu
    }
  ];

  if (getPluginHost()?.enabled) template.push({ label: "客户端插件", submenu: [
    { label: "插件安全状态", click: () => { const h=getPluginHost();const s=h?.snapshot();const result={宿主版本:DESKTOP_APPLICATION_VERSION,PID:process.pid,插件版本:s?.pluginVersion,digest:s?.digest,phase:s?.phase,revision:s?.activeRevision,更新启用:h?.enabled};console.info(JSON.stringify(result));void dialog.showMessageBox({type:"info",title:"客户端插件状态",message:JSON.stringify(result,null,2)}); } },
    { label: "检查插件更新", click: () => { void getPluginHost()?.checkUpdate().catch(() => console.info("插件更新失败")); } },
    { label: "回滚插件", click: () => { void getPluginHost()?.rollback().catch(() => console.info("插件回滚失败")); } },
    { label: "故障验收暂停点", submenu: ["verified","activating","probation","stable"].map(phase => ({label:phase,click:()=>{const h=getPluginHost();if(h)h.pauseAt=phase;}})) },
    { label: "继续验收暂停点", click:()=>getPluginHost()?.resumeCheckpoint?.() },
    { label: "验收：终止候选渲染进程", click:()=>{const h=getPluginHost();if(h?.candidate&&!h.candidate.win.isDestroyed())h.candidate.win.webContents.forcefullyCrashRenderer();} },
    { label: "重试后台连接", click: () => { const w=BrowserWindow.getFocusedWindow(); if(w&&!getPluginHost()?.instances.has(w.webContents))void w.loadURL(loadDesktopConfig().webUrl); } }
  ] });
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
