export const matrixAccountPermissions = {
  view: ["platform.matrix_accounts.view", "agency.matrix_accounts.view", "enterprise.matrix_accounts.view"],
  create: ["platform.matrix_accounts.create", "agency.matrix_accounts.create", "enterprise.matrix_accounts.create"],
  update: ["platform.matrix_accounts.update", "agency.matrix_accounts.update", "enterprise.matrix_accounts.update"],
  updateStatus: [
    "platform.matrix_accounts.update_status",
    "agency.matrix_accounts.update_status",
    "enterprise.matrix_accounts.update_status"
  ],
  delete: ["platform.matrix_accounts.delete", "agency.matrix_accounts.delete", "enterprise.matrix_accounts.delete"],
  login: ["platform.matrix_accounts.login", "agency.matrix_accounts.login", "enterprise.matrix_accounts.login"],
  open: ["platform.matrix_accounts.open", "agency.matrix_accounts.open", "enterprise.matrix_accounts.open"],
  check: ["platform.matrix_accounts.check", "agency.matrix_accounts.check", "enterprise.matrix_accounts.check"],
  clearSession: [
    "platform.matrix_accounts.clear_session",
    "agency.matrix_accounts.clear_session",
    "enterprise.matrix_accounts.clear_session"
  ],
  scriptsView: [
    "platform.matrix_account_scripts.view",
    "agency.matrix_account_scripts.view",
    "enterprise.matrix_account_scripts.view",
    "platform.matrix_account_login_scripts.view",
    "agency.matrix_account_login_scripts.view",
    "enterprise.matrix_account_login_scripts.view"
  ],
  scriptsManage: [
    "platform.matrix_account_scripts.manage",
    "agency.matrix_account_scripts.manage",
    "enterprise.matrix_account_scripts.manage",
    "platform.matrix_account_login_scripts.update",
    "agency.matrix_account_login_scripts.update",
    "enterprise.matrix_account_login_scripts.update"
  ],
  webSpacesDebug: [
    "platform.matrix_account_web_spaces.debug",
    "agency.matrix_account_web_spaces.debug",
    "enterprise.matrix_account_web_spaces.debug"
  ],
  sensitiveDebugView: [
    "platform.matrix_account_sensitive_debug.view",
    "agency.matrix_account_sensitive_debug.view",
    "enterprise.matrix_account_sensitive_debug.view"
  ],
  sensitiveDebugExport: [
    "platform.matrix_account_sensitive_debug.export",
    "agency.matrix_account_sensitive_debug.export",
    "enterprise.matrix_account_sensitive_debug.export"
  ],
  menu: ["menu.platform.matrix_accounts", "menu.agency.matrix_accounts", "menu.enterprise.matrix_accounts"]
};
