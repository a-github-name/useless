export {
  collectRepo,
  findDuplicates,
  findSharedBlocks,
  findSimilar,
  listTestFiles,
  parseTimings,
  resolveModuleText,
  siblingSource,
} from './repo.js';
export type { CollectOptions } from './repo.js';
export { markdownTable, summarize, summaryLines } from './report.js';
export type { Summary } from './report.js';
export { FINDING_GUIDANCE, FINDING_ORDER, WEIGHTS, score } from './score.js';
export { analyzeTest, countFunctions, measureLiteralBlocks } from './signals.js';
export type { AnalyzeInput } from './signals.js';
export type { Churn, Finding, Scored, SignalName, Signals, Timing } from './types.js';

import { collectRepo } from './repo.js';
import type { CollectOptions } from './repo.js';
import { score } from './score.js';
import type { Scored } from './types.js';

/** Collect, score, and rank every test file in a repo (most useless first). */
export function rank(options: CollectOptions): Scored[] {
  return collectRepo(options)
    .map(score)
    .sort((a, b) => b.score - a.score || a.file.localeCompare(b.file));
}
