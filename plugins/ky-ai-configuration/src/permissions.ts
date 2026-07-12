export const pluginName = "ky-ai-configuration";

export const AI_CONFIGURATION_MENU_KEY = "menu.platform.ai_configuration";

export const AI_EXECUTOR_PERMISSIONS = {
  view: "platform.ai_executors.view",
  create: "platform.ai_executors.create",
  update: "platform.ai_executors.update",
  authorize: "platform.ai_executors.authorize",
  changeAccount: "platform.ai_executors.change_account",
  bindDevice: "platform.ai_executors.bind_device",
  rebindDevice: "platform.ai_executors.rebind_device",
  forceRevoke: "platform.ai_executors.force_revoke",
  taskView: "platform.ai_executor_tasks.view",
  taskCreate: "platform.ai_executor_tasks.create",
  taskCancel: "platform.ai_executor_tasks.cancel"
} as const;

export const permissions: string[] = Object.values(AI_EXECUTOR_PERMISSIONS);
