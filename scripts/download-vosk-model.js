/**
 * 下载 Vosk 中文小模型并转换为 tar.gz 格式
 * 用法：npm run learn:prepare-vosk
 * 输出：src/learn-ui/public/models/model-cn.tar.gz (~45MB)
 */

import https from "https";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MODEL_ZIP_URL = "https://alphacephei.com/vosk/models/vosk-model-small-cn-0.22.zip";
const ROOT = path.resolve(__dirname, "..");
const MODELS_DIR = path.join(ROOT, "src", "learn-ui", "public", "models");
const ZIP_PATH = path.join(MODELS_DIR, "vosk-model-small-cn-0.22.zip");
const EXTRACT_DIR = path.join(MODELS_DIR, "vosk-cn-temp");
const TAR_PATH = path.join(MODELS_DIR, "model-cn.tar.gz");

function download(url) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(ZIP_PATH);
    https
      .get(url, { headers: { "User-Agent": "SuperOS-Learn/1.0" } }, (res) => {
        if (res.statusCode === 301 || res.statusCode === 302) {
          download(res.headers.location).then(resolve).catch(reject);
          return;
        }
        res.pipe(file);
        file.on("finish", () => {
          file.close();
          resolve();
        });
      })
      .on("error", (err) => {
        fs.unlink(ZIP_PATH, () => {});
        reject(err);
      });
  });
}

async function main() {
  console.log("[Vosk] 准备中文离线语音模型…");
  fs.mkdirSync(MODELS_DIR, { recursive: true });

  if (fs.existsSync(TAR_PATH)) {
    console.log("[Vosk] 模型已存在:", TAR_PATH);
    console.log("[Vosk] 若需重新下载，请先删除该文件。");
    return;
  }

  console.log("[Vosk] 下载中…");
  await download(MODEL_ZIP_URL);
  console.log("[Vosk] 下载完成，解压并转换…");

  const unzipper = (await import("unzipper")).default;
  const { c: tarCreate } = await import("tar");

  if (fs.existsSync(EXTRACT_DIR)) fs.rmSync(EXTRACT_DIR, { recursive: true });
  fs.mkdirSync(EXTRACT_DIR, { recursive: true });

  await fs
    .createReadStream(ZIP_PATH)
    .pipe(unzipper.Extract({ path: EXTRACT_DIR }))
    .promise();

  const extracted = path.join(EXTRACT_DIR, "vosk-model-small-cn-0.22");
  if (!fs.existsSync(extracted)) {
    const dirs = fs.readdirSync(EXTRACT_DIR);
    throw new Error("解压后未找到 vosk-model-small-cn-0.22，实际目录: " + dirs.join(", "));
  }

  const dirs = ["am", "conf", "graph", "ivector"].filter((d) =>
    fs.existsSync(path.join(extracted, d))
  );
  await tarCreate({ gzip: true, file: TAR_PATH, cwd: extracted }, dirs);

  fs.unlinkSync(ZIP_PATH);
  fs.rmSync(EXTRACT_DIR, { recursive: true });
  console.log("[Vosk] 完成:", TAR_PATH);
}

main().catch((e) => {
  console.error("[Vosk] 失败:", e);
  process.exit(1);
});
