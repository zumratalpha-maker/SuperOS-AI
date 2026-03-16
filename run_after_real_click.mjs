import { readFile } from 'node:fs/promises';
import { captureA11ySnapshot, diffA11ySnapshots } from './dist/tools/a11yDiff.js';
import { recordTrajectory } from './dist/tools/trajectoryRecorder.js';

async function main() {
  // 给 UI 和 DirectShell 刷新留时间（点击后等 2000ms 再抓快照）
  await new Promise((r) => setTimeout(r, 2000));
  const filePath = new URL('./data/trajectories/trajectories_2026-03-14.jsonl', import.meta.url);
  const raw = await readFile(filePath, 'utf8');
  const lines = raw.split('\n').filter((l) => l.trim().length > 0);
  const records = lines.map((l) => JSON.parse(l));

  let beforeRec = null;
  for (let i = records.length - 1; i >= 0; i--) {
    const r = records[i];
    if (
      r.action === 'before_click' &&
      r.afterState &&
      Array.isArray(r.afterState.nodes) &&
      r.afterState.nodes.length > 0
    ) {
      beforeRec = r;
      break;
    }
  }

  if (!beforeRec) {
    console.log('NO_BEFORE_WITH_NODES');
    return;
  }

  const beforeState = beforeRec.afterState;
  const afterState = await captureA11ySnapshot();
  const diff = diffA11ySnapshots(beforeState, afterState);

  await recordTrajectory({
    timestamp: Date.now(),
    action: 'after_real_click',
    target: beforeRec.target || 'cursor',
    beforeState,
    afterState,
    diffSummary: {
      added: diff.added.length,
      removed: diff.removed.length,
      changed: diff.changed.length,
    },
  });

  console.log('=== BEFORE SNAPSHOT (preview) ===');
  console.log(
    JSON.stringify(
      {
        timestamp: beforeState.timestamp,
        nodeCount: beforeState.nodes.length,
        nodesPreview: beforeState.nodes.slice(0, 10),
      },
      null,
      2
    )
  );

  console.log('\n=== AFTER SNAPSHOT (preview) ===');
  console.log(
    JSON.stringify(
      {
        timestamp: afterState.timestamp,
        nodeCount: afterState.nodes.length,
        nodesPreview: afterState.nodes.slice(0, 10),
      },
      null,
      2
    )
  );

  console.log('\n=== DIFF SUMMARY ===');
  console.log(
    JSON.stringify(
      {
        added: diff.added.length,
        removed: diff.removed.length,
        changed: diff.changed.length,
      },
      null,
      2
    )
  );

  console.log('\n=== LAST RECORDS RAW (up to 10) ===');
  console.log(lines.slice(-10).join('\n'));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
