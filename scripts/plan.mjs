import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createPlan, workflowMatrix } from './profiles.mjs';
import { validateTarget, validateExpectedBuildId } from './target.mjs';
import { collectReportContext, requestedRun } from './report-context.mjs';

const request = requestedRun();
validateTarget(process.env.MAVEFORM_BASE_URL);
validateExpectedBuildId(process.env.MAVEFORM_EXPECTED_BUILD_ID, { ci: true });
const context = collectReportContext();
if (!request.harnessCommit || context.harnessCommit !== request.harnessCommit) throw new Error('HARNESS_ID_MISMATCH');
if (!/^\d+$/.test(request.runId || '') || !/^[1-9]\d*$/.test(request.runAttempt || '')) throw new Error('WORKFLOW_ID_INVALID');
const plan = { ...createPlan(request.profileId, request.suite), ...request };
const matrix = workflowMatrix(plan);
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, 'matrix=' + JSON.stringify(matrix) + '\n');
mkdirSync(path.resolve('reports/plan'), { recursive: true });
writeFileSync(path.resolve('reports/plan/plan.json'), JSON.stringify(plan, null, 2) + '\n');
console.log('Profile ' + plan.profileId + ': ' + plan.expectedCells + ' cells, ' + plan.expectedSmokeChecks + ' smoke checks, ' + plan.expectedModelChecks + ' model checks.');
if (plan.cells.some(cell => cell.modelScope === 'smoke-only')) console.log('ubuntu-slim is smoke-only because its hosted job has a 15-minute limit.');
