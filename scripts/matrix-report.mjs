import { existsSync, readdirSync, readFileSync, mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import path from 'node:path';
import { evaluateMatrix } from './matrix.mjs';
import { markdownCell } from './report-utils.mjs';
import { requestedRun, collectReportContext } from './report-context.mjs';

const input = path.resolve(process.argv[2] || 'reports/downloaded');
const cells = [];
let readErrors = 0;
function visit(folder) {
  if (!existsSync(folder)) return;
  for (const entry of readdirSync(folder, { withFileTypes: true })) {
    const file = path.join(folder, entry.name);
    if (entry.isDirectory()) visit(file);
    else if (entry.isFile() && entry.name.endsWith('.json')) {
      try {
        const report = JSON.parse(readFileSync(file, 'utf8'));
        if (report?.schemaVersion === 2 && typeof report.cellId === 'string') cells.push(report);
        else readErrors++;
      } catch { readErrors++; }
    }
  }
}
visit(input);
const request = requestedRun();
const context = collectReportContext();
if (context.harnessCommit !== request.harnessCommit) readErrors++;
const summary = evaluateMatrix(cells, request, readErrors);
const lines = [
  '# Maveform browser compatibility', '',
  '**Result: ' + summary.status.toUpperCase() + '**', '',
  'Profile: ' + markdownCell(summary.profileId) + '. Requested suite: ' + markdownCell(summary.requestedSuite) + '.',
  'Expected coverage: ' + (summary.expectedCells || 0) + ' cells, ' + (summary.expectedSmokeChecks || 0) + ' smoke checks, ' + (summary.expectedModelChecks || 0) + ' model checks.',
  'Build: ' + markdownCell(summary.buildId) + '. Every app/harness/run identity verified: ' + (summary.identityVerified ? 'yes' : 'no') + '.',
  'Public harness: ' + markdownCell(summary.harnessCommit) + '. Workflow run/attempt: ' + markdownCell(summary.runId) + '/' + markdownCell(summary.runAttempt) + '.', '',
  '| Runner | Observed OS | Host / Node / browser arch | Browser | Model scope | Result | Failure |',
  '| --- | --- | --- | --- | --- | --- | --- |',
  ...summary.rows.map(row => '| ' + [
    row.runner, [row.environment?.os?.product, row.environment?.os?.version].filter(Boolean).join(' '),
    [row.environment?.arch?.host, row.environment?.arch?.node, row.environment?.arch?.browser].map(value => value || '?').join(' / '),
    row.browser, row.modelScope, row.status, row.code,
  ].map(markdownCell).join(' | ') + ' |'), '',
  'Every requested cell and check must pass against the exact app build, public harness commit, profile, and workflow attempt. Missing, duplicate, unexpected, stale, skipped, cancelled, or incomplete results fail the report.', '',
  'The four OS profiles cover seven system groups. Their models suite requires seven smoke checks plus six real model checks. ubuntu-slim is always smoke-only because of its 15-minute hosted limit.',
  'The baseline profile preserves the original six Chrome, Edge, and WebKit cells; its models suite requires six smoke and six model checks.',
  'Pinned OS versions are verified. Floating aliases and Xcode-selected images show their observed OS/image; aliases do not represent extra hardware.',
  'Smoke covers actual decode, trim/reframe export, audio, captions, and independent media validation with generated fixtures. AI models are not run in smoke.',
  'Models adds real speech recognition and Atlas embeddings/clip finding. Face/scene detection and Genesis remain untested.',
  'Playwright WebKit is not installed Safari; hosted runners do not certify every user GPU, OS, codec, or device.', '',
];
if (summary.matrixIssue) lines.push('Matrix issue: **' + markdownCell(summary.matrixIssue) + '**.', '');
const output = path.resolve('reports/matrix');
mkdirSync(output, { recursive: true });
writeFileSync(path.join(output, 'matrix.json'), JSON.stringify(summary, null, 2) + '\n');
writeFileSync(path.join(output, 'matrix.md'), lines.join('\n'));
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join('\n'));
console.log(lines.join('\n'));
process.exitCode = summary.status === 'passed' ? 0 : 1;
