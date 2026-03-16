/**
 * 本地 OCR 桥接 — tesseract.js，0 Token，供 clickByName OCR 兜底与记忆写入
 */

import Tesseract from "tesseract.js";

export interface OcrWord {
  text: string;
  bbox: { x: number; y: number; width: number; height: number };
  /** tesseract 词级置信度 0–100，低于阈值视为噪声 */
  confidence?: number;
}

function extractWordsFromBlocks(blocks: Tesseract.Block[] | null): OcrWord[] {
  const words: OcrWord[] = [];
  if (!blocks) return words;
  for (const block of blocks) {
    for (const para of block.paragraphs ?? []) {
      for (const line of para.lines ?? []) {
        for (const w of line.words ?? []) {
          const bbox = w.bbox;
          if (bbox && w.text) {
            words.push({
              text: w.text.trim(),
              bbox: {
                x: bbox.x0,
                y: bbox.y0,
                width: bbox.x1 - bbox.x0,
                height: bbox.y1 - bbox.y0,
              },
              confidence: typeof w.confidence === "number" ? w.confidence : undefined,
            });
          }
        }
      }
    }
  }
  return words;
}

/** 复用 Worker 避免每次创建/销毁（首次加载语言包 ~2s，后续 ~200ms） */
let cachedWorker: Tesseract.Worker | null = null;
let cachedLang = "";

async function getWorker(lang: string): Promise<Tesseract.Worker> {
  if (cachedWorker && cachedLang === lang) return cachedWorker;
  if (cachedWorker) {
    await cachedWorker.terminate();
    cachedWorker = null;
  }
  cachedWorker = await Tesseract.createWorker(lang, 1, { logger: () => {} });
  cachedLang = lang;
  return cachedWorker;
}

/** 预加载语言包（可选，在 Learn UI / Jarvis 启动时调用，降低首次 OCR 延迟） */
export async function preloadOcrWorker(lang = "chi_sim+eng"): Promise<void> {
  try {
    await getWorker(lang);
    console.log("[ocrBridge] 语言包预加载完成:", lang);
  } catch (e) {
    console.warn("[ocrBridge] 预加载失败:", (e as Error)?.message ?? e);
  }
}

/** 识别 PNG base64 图像中的文字，返回带 bbox 的词列表（坐标相对于图像） */
export async function recognize(base64Image: string, lang = "chi_sim+eng"): Promise<OcrWord[]> {
  try {
    const worker = await getWorker(lang);
    const result = await worker.recognize(`data:image/png;base64,${base64Image}`, {}, {
      blocks: true,
    });
    return extractWordsFromBlocks(result.data.blocks);
  } catch (e) {
    console.warn("[ocrBridge] recognize 失败:", (e as Error)?.message ?? e);
    return [];
  }
}

/** 置信度阈值：低于此值的识别结果视为噪声，避免误点 */
const OCR_CONFIDENCE_MIN = 70;

/** 模糊匹配关键词，返回最佳命中及其 bbox 中心（图像坐标）；过滤低置信度词 */
export function findBestMatch(
  keywords: string[],
  words: OcrWord[]
): { text: string; centerX: number; centerY: number } | null {
  if (!keywords.length || !words.length) return null;
  const keys = keywords.map((k) => k.trim().toLowerCase()).filter(Boolean);
  const inputBoxHints = ["输入", "请输入", "消息", "输入框", "type", "message"];
  const filtered = words.filter(
    (w) => (w.confidence ?? 100) >= OCR_CONFIDENCE_MIN
  );
  let best: { word: OcrWord; score: number } | null = null;
  for (const w of filtered) {
    const t = w.text.toLowerCase();
    for (let i = 0; i < keys.length; i++) {
      if (t.includes(keys[i]) || keys[i].includes(t)) {
        let score = 1 - i * 0.1;
        if (inputBoxHints.some((h) => t.includes(h))) score += 0.2;
        if (!best || score > best.score) {
          best = { word: w, score };
        }
      }
    }
  }
  if (!best) return null;
  const { word } = best;
  const centerX = word.bbox.x + word.bbox.width / 2;
  const centerY = word.bbox.y + word.bbox.height / 2;
  return { text: word.text, centerX, centerY };
}

/**
 * OCR 定位：区域截图 b64 + 区域在窗口内的位置 → 返回窗口相对坐标
 * region 为该区域在窗口中的相对位置，用于将 bbox 中心换算到窗口坐标
 */
export function imagePointToWindowRel(
  rect: { left: number; top: number; width: number; height: number },
  region: { xRel: number; yRel: number; wRel: number; hRel: number },
  imageCenterX: number,
  imageCenterY: number,
  imageWidth: number,
  imageHeight: number
): { xRel: number; yRel: number } {
  const cropLeft = rect.left + region.xRel * rect.width;
  const cropTop = rect.top + region.yRel * rect.height;
  const cropW = region.wRel * rect.width;
  const cropH = region.hRel * rect.height;
  const screenX = cropLeft + (imageCenterX / imageWidth) * cropW;
  const screenY = cropTop + (imageCenterY / imageHeight) * cropH;
  const xRel = (screenX - rect.left) / rect.width;
  const yRel = (screenY - rect.top) / rect.height;
  return { xRel: Math.max(0, Math.min(1, xRel)), yRel: Math.max(0, Math.min(1, yRel)) };
}
