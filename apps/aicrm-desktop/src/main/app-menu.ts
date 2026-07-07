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

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
