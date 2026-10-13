export const pluginName = "ky-script-management";
export const scriptManagementPermissions = {
  view: "platform.matrix_account_douyin_scripts.view",
  contentView: "platform.matrix_account_douyin_scripts.content_view",
  create: "platform.matrix_account_douyin_scripts.create",
  update: "platform.matrix_account_douyin_scripts.update",
  release: "platform.matrix_account_douyin_scripts.release",
  activate: "platform.matrix_account_douyin_scripts.activate",
  archive: "platform.matrix_account_douyin_scripts.archive",
  menu: "menu.platform.matrix_account_douyin_scripts"
} as const;
export const publicStylePermissions = { view: "platform.matrix_account_public_styles.view", manage: "platform.matrix_account_public_styles.manage" } as const;
export const permissions = [...Object.values(scriptManagementPermissions), ...Object.values(publicStylePermissions)];
