/**
 * 剪映专用 a11y steps 构造
 * Phase C P0：打开剪映 + 导出到指定路径（含文件名）
 * Phase C P1：打开剪映 + 开始创作 + 导入本地视频 + 导出
 * 说明：剪映启动后在首页，无「导出」按钮；需先「开始创作」进入编辑界面
 */

export type JianyingStep =
  | { type: "open_app"; app: string }
  | { type: "click"; name: string }
  | { type: "type"; text: string }
  | { type: "keys"; keys: string }
  | { type: "wait"; ms: number };

/** 剪映编辑界面加载所需等待时间（ms） */
const JIANYING_EDITOR_LOAD_MS = 3500;

/** 导入文件对话框弹出/关闭等待（ms） */
const JIANYING_IMPORT_DIALOG_MS = 1500;

/** 弹窗内点击「开始创作」的步骤名（用于 runA11ySequence 识别并走 dismissJianyingProjectModal） */
export const CLICK_JIANYING_MODAL_START = "开始创作(弹窗)";

/**
 * 构建「打开剪映 + 导出」最小 steps（无导入）
 * @param outputFilename 导出文件名（如 output.mp4，默认 导出视频.mp4）
 * @param wantsDesktop 是否保存到桌面
 * @param skipEnterEditor 若为 true，跳过「开始创作」步骤（假定已在编辑界面）
 */
export function buildJianyingExportSteps(
  outputFilename?: string,
  wantsDesktop = true,
  skipEnterEditor = false
): JianyingStep[] {
  const filename = (outputFilename ?? "导出视频.mp4").trim();
  const steps: JianyingStep[] = [{ type: "open_app", app: "剪映" }];
  if (!skipEnterEditor) {
    steps.push(
      { type: "click", name: "开始创作" },
      { type: "wait", ms: JIANYING_EDITOR_LOAD_MS },
      { type: "click", name: CLICK_JIANYING_MODAL_START },
      { type: "wait", ms: 1000 }
    );
  }
  steps.push({ type: "click", name: "导出" });
  if (wantsDesktop) steps.push({ type: "click", name: "桌面" });
  steps.push({ type: "type", text: filename }, { type: "click", name: "导出" });
  return steps;
}

/**
 * 构建「打开剪映 + 开始创作 + 导入本地视频 + 导出」完整 steps
 * 流程：打开剪映（若已运行则仅置顶）→ 开始创作 → 导入（左下素材区）→ 选文件 → 导出
 * @param importPath 本地视频绝对路径（如 C:\\Users\\xxx\\Videos\\a.mp4）
 * @param outputFilename 导出文件名，默认 output.mp4
 * @param wantsDesktop 是否保存到桌面
 */
export function buildJianyingImportAndExportSteps(
  importPath: string,
  outputFilename?: string,
  wantsDesktop = true
): JianyingStep[] {
  const path = (importPath ?? "").trim();
  const filename = (outputFilename ?? "output.mp4").trim();
  const steps: JianyingStep[] = [
    { type: "open_app", app: "剪映" },
    { type: "click", name: "开始创作" },
    { type: "wait", ms: JIANYING_EDITOR_LOAD_MS },
    { type: "click", name: CLICK_JIANYING_MODAL_START },
    { type: "wait", ms: 1000 },
    { type: "click", name: "导入" },
    { type: "wait", ms: JIANYING_IMPORT_DIALOG_MS },
    { type: "type", text: path },
    { type: "keys", keys: "{ENTER}" },
    { type: "wait", ms: 1200 },
    { type: "click", name: "导出" },
  ];
  if (wantsDesktop) steps.push({ type: "click", name: "桌面" });
  steps.push({ type: "type", text: filename }, { type: "click", name: "导出" });
  return steps;
}
