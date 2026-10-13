export type BusinessScriptInitTemplate = {
  registryKey: string;
  text: string;
  cursorOffset: number;
};

export type TemplateEditorContext = {
  language: "JavaScript" | "CSS";
  editable: boolean;
  scriptId?: string | null;
};

export type TemplateInsertionPlan = {
  startOffset: number;
  endOffset: number;
  text: string;
  cursorOffset: number;
  resultingValue: string;
};

const TODO_MARKER = "// TODO: 在此编写业务逻辑";

function serializeJavaScriptString(value: string): string {
  return JSON.stringify(value).replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

export function canInsertBusinessScriptTemplate(context: TemplateEditorContext): boolean {
  return context.language === "JavaScript"
    && context.editable
    && typeof context.scriptId === "string"
    && context.scriptId.trim().length > 0;
}

export function createBusinessScriptInitTemplate(scriptId: string): BusinessScriptInitTemplate {
  if (typeof scriptId !== "string" || scriptId.trim().length === 0) {
    throw new TypeError("业务脚本 ID 不能为空");
  }

  const registryKey = `kww.business-script.${scriptId}`;
  const text = [
    "const KWW_PUBLIC_DEPENDENCIES = [];",
    "// 公共依赖只在这里以单行 JSON 数组声明；服务端读取并准备所需模块。默认空数组，不加载公共脚本。",
    "// 启用依赖时，请将第一行空数组替换为所需的一行声明；不要同时保留多个可执行声明。",
    "// COMMON_FUN 只放跨业务通用工具，不放抖店选择器或登录业务函数；按需启用并替换为其真实导出方法。",
    '// const KWW_PUBLIC_DEPENDENCIES = [{"identifier":"COMMON_FUN","methods":["yourCommonHelper"]}];',
    "// COMMON_DOUYIN 是抖店通用公共脚本，放可供多个抖店业务复用的能力，不限定登录流程。",
    "// 下方方法名是占位示例；启用前请替换成 COMMON_DOUYIN 实际导出的方法。",
    '// const KWW_PUBLIC_DEPENDENCIES = [{"identifier":"COMMON_DOUYIN","methods":["yourDouyinHelper"]}];',
    "// 多模块示例：合并到同一数组，只保留本业务实际需要的标识符和方法。",
    '// const KWW_PUBLIC_DEPENDENCIES = [{"identifier":"COMMON_FUN","methods":["yourCommonHelper"]},{"identifier":"COMMON_DOUYIN","methods":["yourDouyinHelper"]}];',
    "",
    "(async () => {",
    `  const instanceKey = Symbol.for(${serializeJavaScriptString(registryKey)});`,
    "  let instanceMarked = false;",
    "  try {",
    "    const jssdk = window.jssdk;",
    "    if (!jssdk) {",
    '      console.info("JSSDK 当前不可用，已跳过初始化。");',
    "      return;",
    "    }",
    "",
    "    if (!Array.isArray(KWW_PUBLIC_DEPENDENCIES)) {",
    '      throw new Error("公共脚本依赖声明无效：必须是数组。");',
    "    }",
    "    const requiredPublicModules = new Map();",
    "    for (const dependency of KWW_PUBLIC_DEPENDENCIES) {",
    "      const identifier = dependency?.identifier;",
    "      const methods = dependency?.methods;",
    '      if (typeof identifier !== "string" || !/^[A-Z][A-Z0-9_]{0,63}$/.test(identifier) || !Array.isArray(methods)) {',
    '        throw new Error(`公共脚本依赖声明无效：${String(identifier || "未知标识符")}`);',
    "      }",
    '      const module = requiredPublicModules.get(identifier) ?? (typeof jssdk.public?.get === "function" ? jssdk.public.get(identifier) : undefined);',
    "      if (!module) throw new Error(`公共脚本依赖未就绪：${identifier}`);",
    "      for (const method of methods) {",
    '        if (typeof method !== "string" || typeof module[method] !== "function") {',
    '          throw new Error(`公共脚本方法未导出：${identifier}.${String(method)}`);',
    "        }",
    "      }",
    '      if (!requiredPublicModules.has(identifier) && requiredPublicModules.size >= 32) throw new Error("公共脚本依赖声明无效：最多支持 32 个不同标识符。");',
    "      requiredPublicModules.set(identifier, module);",
    "    }",
    "",
    "    const publicModules = requiredPublicModules; // TODO: 仅在本业务需要时读取 publicModules.get(\"COMMON_FUN\") 或 publicModules.get(\"COMMON_DOUYIN\")。",
    "    // 手动复制到其他业务脚本时，请检查并修改此注册表键。",
    "    if (window[instanceKey]) return;",
    "    window[instanceKey] = true;",
    "    instanceMarked = true;",
    "",
    `    ${TODO_MARKER}`,
    "    ",
    "  } catch (error) {",
    "    if (instanceMarked) delete window[instanceKey];",
    '    const reason = error instanceof Error ? error.message : "UNKNOWN";',
    '    console.error("脚本初始化失败，可修复依赖或业务代码后重试。", reason);',
    "  }",
    "})();"
  ].join("\n");
  const todoLineEnd = text.indexOf(TODO_MARKER) + TODO_MARKER.length;
  const nextLineStart = text.indexOf("\n", todoLineEnd) + 1;

  return { registryKey, text, cursorOffset: nextLineStart + 4 };
}

export function planBusinessScriptTemplateInsertion(
  source: string,
  startOffset: number,
  endOffset: number,
  template: BusinessScriptInitTemplate
): TemplateInsertionPlan {
  if (!Number.isInteger(startOffset) || !Number.isInteger(endOffset)
    || startOffset < 0 || endOffset < startOffset || endOffset > source.length) {
    throw new RangeError("模板插入选区无效");
  }

  return {
    startOffset,
    endOffset,
    text: template.text,
    cursorOffset: startOffset + template.cursorOffset,
    resultingValue: source.slice(0, startOffset) + template.text + source.slice(endOffset)
  };
}
