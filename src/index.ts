/**
 * AIOnePersonOS 入口：导出自愈工具、编排器、轨迹记录与 A11y 差异，供上层或 MCP 接入
 */
export {
  withRetry,
  withTimeout,
  withFallback,
  type RetryOptions,
} from "./tools/resilience.js";
export {
  createTask,
  getTask,
  getNextPendingTask,
  updateTaskStatus,
  runNextTask,
  noopExecuteStep,
  type Task,
  type TaskStatus,
  type TaskPayload,
  type StepContext,
  type ExecuteStepFn,
  type OrchestratorConfig,
} from "./agents/orchestrator.js";
export {
  recordTrajectory,
  getTrajectoryStats,
  type A11yState,
  type A11yNode,
  type TrajectoryRecord,
  type TrajectoryStats,
} from "./tools/trajectoryRecorder.js";
export {
  captureA11ySnapshot,
  diffA11ySnapshots,
  type A11yDiffResult,
} from "./tools/a11yDiff.js";
export {
  runSnapshotAndClickReviewOnce,
  snapshotAndClickStep,
} from "./runSnapshotAndClickReview.js";
export {
  saveSkill,
  getSkill,
  listSkills,
  recordSkillExecution,
  type Skill,
  type SkillRegistryOptions,
} from "./skillRegistry.js";
export {
  recordAPICall,
  getDailyReport,
  getWeeklyTrend,
  estimateMonthlyCost,
  type APICallRecord,
  type DailyReport,
  type DailyTrendItem,
  type MonthlyCostEstimate,
} from "./tools/costTracker.js";
export {
  parseVoiceCommandToAction,
  executeVoiceAction,
  detectWakeWord,
  type VoiceAction,
} from "./voice/index.js";
