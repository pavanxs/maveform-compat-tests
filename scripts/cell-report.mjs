import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { markdownCell, xml } from './report-utils.mjs';

export function writeCellReport(report) {
  const directory = path.resolve('reports/public');
  mkdirSync(directory, { recursive: true });
  const stem = /^[A-Za-z0-9_.-]+$/.test(report.cellId) ? report.cellId : 'unknown';
  writeFileSync(path.join(directory, stem + '.json'), JSON.stringify(report, null, 2) + '\n');
  const lines = [
    '# Maveform compatibility: ' + markdownCell(report.cellId),
    '',
    '- Result: **' + markdownCell(report.status) + '**',
    '- Build ID: ' + markdownCell(report.buildId),
    '- Expected build matched: ' + (report.identityVerified ? 'yes' : '**not verified**'),
    '- Runner: ' + markdownCell(report.environment?.runner) + ' / ' + markdownCell(report.environment?.arch),
    '- Browser: ' + markdownCell(report.environment?.browser),
    '- Suite: ' + markdownCell(report.suite),
    '',
    '| Check | Result | Failure code | Stage | Duration |',
    '| --- | --- | --- | --- | --- |',
    ...(report.tests || []).map(test => '| ' + [
      test.title, test.status, test.failure?.code, test.failure?.stage,
      typeof test.durationMs === 'number' ? (test.durationMs / 1000).toFixed(1) + 's' : null,
    ].map(markdownCell).join(' | ') + ' |'),
  ];
  if (report.failureCode) lines.push('', 'Setup/report failure: **' + markdownCell(report.failureCode) + '** (' + markdownCell(report.failureStage) + ').');
  for (const test of report.tests || []) {
    if (!test.diagnostics) continue;
    lines.push('', '## ' + markdownCell(test.title), '', '~~~json', JSON.stringify(test.diagnostics, null, 2), '~~~');
  }
  lines.push(
    '', '## Scope',
    '',
    'Smoke uses synthetic media and captions through the production decode/export path. It does not run AI models.',
    'The manual models suite additionally runs speech recognition and Atlas embeddings/clip finding.',
    'WebKit is Playwright WebKit, not the installed Safari application. GitHub runners do not represent every user GPU.',
    'Authentication, database persistence, save/resume, face detection, scene detection and Genesis are outside these checks.',
    'Only allow-listed diagnostics are published. Raw traces, source maps, cookies, requests, screenshots and media files are not uploaded.',
    '',
  );
  writeFileSync(path.join(directory, stem + '.md'), lines.join('\n'));

  const tests = report.tests || [];
  const failures = tests.filter(test => test.status !== 'passed').length + (report.failureCode ? 1 : 0);
  const cases = tests.map(test =>
    '  <testcase name="' + xml(test.title) + '" classname="' + xml(report.cellId) +
    '" time="' + ((test.durationMs || 0) / 1000).toFixed(3) + '">' +
    (test.status !== 'passed' ? '<failure message="' + xml(test.failure?.code || test.status) +
      '">' + xml(test.failure?.stage || 'unknown') + '</failure>' : '') + '</testcase>'
  );
  if (report.failureCode) cases.push('  <testcase name="setup"><failure message="' + xml(report.failureCode) + '">' + xml(report.failureStage) + '</failure></testcase>');
  writeFileSync(path.join(directory, stem + '.xml'),
    '<?xml version="1.0" encoding="UTF-8"?>\n<testsuite name="' + xml(report.cellId) +
    '" tests="' + (tests.length + (report.failureCode ? 1 : 0)) + '" failures="' + failures + '">\n' +
    cases.join('\n') + '\n</testsuite>\n'
  );
}
