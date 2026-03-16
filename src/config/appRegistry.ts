/**
 * 专属应用/网页注册表：名称 → URL 或本地 exe 路径
 * 后续可在此填写真实路径，Jarvis 通过 open_target 统一解析并打开
 */
export const APP_REGISTRY: Record<string, string> = {
  // 网页（用默认浏览器打开，供 open_app 操作）
  百度: "https://www.baidu.com",
  豆包: "https://www.doubao.com",
  通义万相: "https://tongyi.aliyun.com/wanxiang/generate/image/text-to-image",
  Gemini: "https://gemini.google.com",
  可灵: "https://klingai.kuaishou.com",
  即梦: "https://jimeng.jianying.com",
  nanobanana: "https://...", // 作图工具网页，请替换为真实 URL
  grok: "https://...",       // 视频生成网页，请替换为真实 URL

  // 本地应用（.exe 路径请用双反斜杠，如 "D:\\weixin\\Weixin.exe"）
  微信: "D:\\weixin\\Weixin.exe",
  WeChat: "D:\\weixin\\Weixin.exe",
  剪映: "%LOCALAPPDATA%\\JianyingPro\\Apps\\JianyingPro.exe",

  // 系统常用（Windows 可直接用名称启动）
  记事本: "notepad",
  计算器: "calc",
  画图: "mspaint",
  资源管理器: "explorer",

  // Phase B 扩展：Excel、WPS、剪映、Word
  Excel: "excel",
  excel: "excel",
  WPS: "wps",
  wps: "wps",
  CapCut: "%LOCALAPPDATA%\\CapCut\\Apps\\CapCut.exe",

  // Microsoft Word（多种称呼统一解析）
  Word: "%ProgramFiles%\\Microsoft Office\\root\\Office16\\WINWORD.EXE",
  word: "%ProgramFiles%\\Microsoft Office\\root\\Office16\\WINWORD.EXE",
  "Microsoft Word": "%ProgramFiles%\\Microsoft Office\\root\\Office16\\WINWORD.EXE",
  WINWORD: "%ProgramFiles%\\Microsoft Office\\root\\Office16\\WINWORD.EXE",
};

/** 展开路径中的 %ENV% 为当前用户环境变量（如 %LOCALAPPDATA% → C:\Users\xxx\AppData\Local） */
function expandEnvPath(value: string): string {
  return value.replace(/%([^%]+)%/g, (_, key) => process.env[key] ?? `%${key}%`);
}

/**
 * 模糊匹配 targetName，返回注册表中的 URL 或 exe 路径；未匹配返回 undefined
 * 返回值中的 %LOCALAPPDATA% 等环境变量会被展开为当前用户路径
 */
export function resolveTarget(targetName: string): string | undefined {
  const t = targetName.trim();
  if (!t) return undefined;

  const keys = Object.keys(APP_REGISTRY);
  const lower = t.toLowerCase();

  // 1) 精确匹配（忽略大小写对英文 key）
  for (const k of keys) {
    if (k === t || k.toLowerCase() === lower) return expandEnvPath(APP_REGISTRY[k]);
  }

  // 2) key 包含 targetName（如 targetName="百度" 匹配 key="百度"）
  for (const k of keys) {
    if (k.includes(t) || t.includes(k)) return expandEnvPath(APP_REGISTRY[k]);
  }

  // 3) 英文 key 与 targetName 忽略大小写包含
  for (const k of keys) {
    if (k.toLowerCase().includes(lower) || lower.includes(k.toLowerCase())) return expandEnvPath(APP_REGISTRY[k]);
  }

  return undefined;
}
