import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { markdownCell, xml } from './report-utils.mjs';

export function writeCellReport(report) {
  const directory = path.resolve('reports/public');
  mkdirSync(directory, { recursive: true });
  const stem = /^[A-Za-z0-9_.-]+$/.test(report.cellId) ? report.cellId : 'unknown';
  writeFileSync(path.join(directory, stem + '.json'), JSON.stringify(report, null, 2) + '\n');
  const env = report.environment || {};
  const lines = [
    '# Maveform compatibility: ' + markdownCell(report.cellId),
    '',
    '- Result: **' + markdownCell(report.status) + '**',
    '- Profile: ' + markdownCell(report.profileId),
    '- Requested suite / cell suite: ' + markdownCell(report.requestedSuite) + ' / ' + markdownCell(report.suite),
    '- Required checks: ' + (report.requiredChecks || []).map(markdownCell).join(', '),
    '- AI model scope: ' + markdownCell(report.modelScope) + (report.modelScopeReason ? ' (' + markdownCell(report.modelScopeReason) + ')' : ''),
    '- Build ID: ' + markdownCell(report.buildId),
    '- Expected build matched: ' + (report.identityVerified ? 'yes' : '**not verified**'),
    '- Public harness commit: ' + markdownCell(report.harnessCommit),
    '- Workflow run / attempt: ' + markdownCell(report.runId) + ' / ' + markdownCell(report.runAttempt),
    '- Runner label: ' + markdownCell(env.runner),
    '- Observed OS: ' + markdownCell(env.os?.product) + ' ' + markdownCell(env.os?.version) + ' (kernel ' + markdownCell(env.os?.release) + ')',
    '- Observed image: ' + markdownCell(env.image?.os) + ' / ' + markdownCell(env.image?.version),
    '- Architecture, host / Node / browser: ' + [env.arch?.host, env.arch?.node, env.arch?.browser].map(markdownCell).join(' / '),
    '- Browser: ' + markdownCell(env.browser?.channel) + ' ' + markdownCell(env.browser?.version) + ' (' + markdownCell(env.arch?.browserEvidence) + ')',
    '',
    '| Check | Result | Failure code | Stage | Duration |',
    '| --- | --- | --- | --- | --- |',
    ...(report.tests || []).map(test => '| ' + [
      test.checkId, test.status, test.failure?.code, test.failure?.stage,
      typeof test.durationMs === 'number' ? (test.durationMs / 1000).toFixed(1) + 's' : null,
    ].map(markdownCell).join(' | ') + ' |'),
  ];
  if (report.failureCode) lines.push('', 'Setup/report failure: **' + markdownCell(report.failureCode) + '** (' + markdownCell(report.failureStage) + ').');
  for (const test of report.tests || []) {
    if (!test.diagnostics) continue;
    lines.push('', '## ' + markdownCell(test.title), '', '~~~json', JSON.stringify(test.diagnostics, null, 2), '~~~');
  }
  lines.push(
    '', '## Scope', '',
    'Smoke uses generated media and captions through the production decode/export path. AI models are not run in smoke.',
    report.modelScope === 'smoke-only' ? 'This ubuntu-slim cell is explicitly smoke-only. Its 15-minute hosted limit excludes the real model checks.' :
      'When requested, the models suite also runs real speech recognition and Atlas embeddings/clip finding.',
    'WebKit is Playwright WebKit. Hosted runner results do not certify every user GPU or device.',
    'Authentication, database persistence, save/resume, face detection, scene detection and Genesis are outside these checks.',
    'Only allow-listed diagnostics are published. Raw traces, source maps, cookies, requests, screenshots and media files are not uploaded.', '',
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
