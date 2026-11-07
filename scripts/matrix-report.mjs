import { existsSync, readdirSync, readFileSync, mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import path from 'node:path';
import { evaluateMatrix } from './matrix.mjs';
import { markdownCell } from './report-utils.mjs';

const input = path.resolve(process.argv[2] || 'reports/downloaded');
const cells = [];
function visit(folder) {
  if (!existsSync(folder)) return;
  for (const entry of readdirSync(folder, { withFileTypes: true })) {
    const file = path.join(folder, entry.name);
    if (entry.isDirectory()) visit(file);
    else if (entry.isFile() && entry.name.endsWith('.json')) {
      try {
        const report = JSON.parse(readFileSync(file, 'utf8'));
        if (report.schemaVersion === 1 && typeof report.cellId === 'string') cells.push(report);
      } catch { /* An unreadable cell remains missing and fails the matrix. */ }
    }
  }
}
visit(input);
const summary = evaluateMatrix(cells, process.env.COMPAT_SUITE || 'smoke', process.env.MAVEFORM_EXPECTED_BUILD_ID?.trim());
const lines = [
  '# Maveform browser compatibility',
  '',
  '**Result: ' + summary.status.toUpperCase() + '**',
  '',
  'Build: ' + markdownCell(summary.buildId) + '. Expected build matched in every cell: ' + (summary.identityVerified ? 'yes' : 'no') + '.',
  '',
  '| Runner | Architecture | Browser | Result | Failure |',
  '| --- | --- | --- | --- | --- |',
  ...summary.rows.map(row => '| ' + [row.runner, row.arch, row.browser, row.status, row.code].map(markdownCell).join(' | ') + ' |'),
  '',
  'All six cells must report passing checks against the same identified build. Missing, skipped, cancelled, failed, or incomplete cells do not count as success.',
  '',
  'Smoke covers real decode, trim/reframe export, audio, captions and independent media validation using generated fixtures. AI models are not run in smoke.',
  'The optional manual models suite adds real speech recognition and Atlas embeddings/clip finding. Face/scene detection and Genesis remain untested.',
  'Playwright WebKit is not installed Safari; hosted runner results do not certify every user GPU, OS, video codec, or device.',
  '',
];
if (summary.matrixIssue) lines.push('Matrix issue: **' + summary.matrixIssue + '**.', '');
const output = path.resolve('reports/matrix');
mkdirSync(output, { recursive: true });
writeFileSync(path.join(output, 'matrix.json'), JSON.stringify(summary, null, 2) + '\n');
writeFileSync(path.join(output, 'matrix.md'), lines.join('\n'));
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join('\n'));
console.log(lines.join('\n'));
process.exitCode = summary.status === 'passed' ? 0 : 1;
