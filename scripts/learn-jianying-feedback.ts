/**
 * 剪映学习模式（反馈式）：用户只负责把光标移到目标位置，不点击；记录后自动化用该坐标点击
 * 用法：npm run learn:jianying:feedback
 *
 * 流程设计（按实际剪映）：
 * 1. 每步：把光标移到要学习的按钮上（不点击）→ 倒计时自动记录
 * 2. 进入下一界面：需用户手动点一次（或 s 跳过该步）
 * 3. 步骤按实际：开始创作 → 导入 → 导出；弹窗步骤可跳过
 */

import { createInterface } from "node:readline";
import { getForegroundWindowAndCursor } from "../src/tools/directShellBridge.js";
import { appendLearnedAction } from "../src/tools/learnedActions.js";

const STEPS: { target: string; label: string; hint: string }[] = [
  {
    target: "剪映|开始创作",
    label: "开始创作",
    hint: "欢迎页主按钮。把光标移到「开始创作」上，不要点击。",
  },
  {
    target: "剪映|开始创作(弹窗)",
    label: "开始创作（弹窗内）",
    hint: "若点开始创作后出现项目选择弹窗，把光标移到弹窗内的「开始创作」；若无弹窗（直接进大画面）则 s 跳过。",
  },
  {
    target: "剪映|导入",
    label: "导入",
    hint: "编辑界面左下素材区。把光标移到「导入」或「+」上，不要点击。",
  },
  {
    target: "剪映|导出",
    label: "导出",
    hint: "编辑界面右上角。把光标移到「导出」按钮上，不要点击。",
  },
  {
    target: "剪映|导出设置",
    label: "导出设置",
    hint: "导出弹窗内（若有）。无则 s 跳过。",
  },
];

const COUNTDOWN_SEC = 3;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function question(rl: ReturnType<typeof createInterface>, prompt: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => resolve((answer ?? "").trim()));
  });
}

async function main(): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  if (process.platform !== "win32") {
    console.log("学习模式仅支持 Windows");
    rl.close();
    return;
  }

  process.on("SIGINT", () => {
    rl.close();
    process.exit(0);
  });

  console.log("剪映学习模式（反馈式）\n");
  console.log("  规则：你只负责把光标移到目标按钮上，不点击。倒计时结束我记录坐标，自动化时由我来点击。");
  console.log("  进入下一界面需你手动点一次。终端放副屏或缩小，避免抢焦点。\n");

  await question(rl, "请先打开剪映到欢迎页，准备好后按 Enter 开始 > ");

  for (const step of STEPS) {
    console.log(`\n--- ${step.label} ---`);
    console.log(`  ${step.hint}`);
    const skip = await question(rl, "  按 Enter 开始记录，或 s 跳过 > ");
    if (skip.toLowerCase() === "s") continue;

    console.log(`  把光标移到「${step.label}」上，保持不动…\n`);

    for (let i = COUNTDOWN_SEC; i >= 1; i--) {
      process.stdout.write(`  ${i}... `);
      await sleep(1000);
    }
    console.log("记录！");

    let snap = await getForegroundWindowAndCursor();
    if (!snap) {
      await new Promise((r) => setTimeout(r, 200));
      snap = await getForegroundWindowAndCursor();
    }
    if (!snap) {
      console.log(`  [失败] 无法获取窗口（终端可能抢了焦点）。Enter 重试 / s 跳过`);
      const ans = await question(rl, "  > ");
      if (ans.toLowerCase() === "s") continue;
      console.log("  再试，3 秒后记录...");
      await sleep(3000);
      const retry = await getForegroundWindowAndCursor();
      if (!retry) {
        console.log("  [跳过]");
        continue;
      }
      await recordStep(rl, step.target, retry);
      continue;
    }

    await recordStep(rl, step.target, snap);

    if (["剪映|开始创作", "剪映|开始创作(弹窗)"].includes(step.target)) {
      console.log(`  → 请手动点一次进入下一界面，再继续下一步。`);
    }
  }

  console.log("\n全部完成！");
  rl.close();
}

async function recordStep(
  rl: ReturnType<typeof createInterface>,
  target: string,
  snap: { windowTitle: string; xRel: number; yRel: number }
): Promise<void> {
  console.log(`  窗口: ${snap.windowTitle}`);
  console.log(`  坐标: xRel=${snap.xRel.toFixed(3)} yRel=${snap.yRel.toFixed(3)}`);

  try {
    await appendLearnedAction({
      target,
      xRel: snap.xRel,
      yRel: snap.yRel,
      ts: Date.now(),
      windowTitle: snap.windowTitle,
    });
    console.log(`  [已记录] ${target}`);
  } catch (e) {
    console.error("  写入失败:", e);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
