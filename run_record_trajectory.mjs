import { readFile } from 'node:fs/promises';
import { recordTrajectory } from './dist/tools/trajectoryRecorder.js';

async function main() {
  try {
    const raw = await readFile('./tmp_trajectory_record.json', 'utf8');
    const record = JSON.parse(raw);
    await recordTrajectory(record);
    console.log('recordTrajectory: ok');
  } catch (err) {
    console.error('recordTrajectory error:', err);
    process.exit(1);
  }
}

main();
