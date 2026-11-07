# Maveform browser compatibility tests

This is a standalone public test harness. It opens an already deployed Maveform preview in real browsers. It never checks out, builds, or publishes the private application.

## What gets tested

The default smoke check uses a generated 3-second video: moving test shapes, a 440 Hz tone, H.264 video and AAC audio. It uploads that fixture, decodes a frame in the browser, then exports a 2-second portrait clip twice through the app: captions off and captions on.

FFmpeg and ffprobe inspect the downloaded files independently. The test checks dimensions, codecs, duration, every decoded packet, moving/nonblank frames, preserved sound, and a localized caption change. A missing API, unavailable codec, failed export or missing runner is a failure, not a skipped pass.

The manual models suite also creates at least 30 seconds of computer-generated speech. It runs real transcription and Atlas embedding/clip finding, then checks recognized words, timing, complete sentence embedding coverage and actual clips. It does not claim to test face detection, scene detection or Genesis.

## Choose a runner profile

The default `current` profile tests seven machine groups. `older`, `newer`, and `aliases` each select another combination. Together they cover every requested runner label.

| Machine group | `current` | `older` | `newer` | `aliases` |
| --- | --- | --- | --- | --- |
| Small Linux x64 | `ubuntu-slim` | `ubuntu-slim` | `ubuntu-slim` | `ubuntu-slim` |
| Linux x64 | `ubuntu-24.04` | `ubuntu-22.04` | `ubuntu-26.04` | `ubuntu-latest` |
| Windows x64 | `windows-2025` | `windows-2022` | `windows-2025-vs2026` | `windows-latest` |
| Linux ARM64 | `ubuntu-24.04-arm` | `ubuntu-22.04-arm` | `ubuntu-26.04-arm` | `ubuntu-24.04-arm` |
| Windows ARM64 | `windows-11-arm` | `windows-11-arm` | `windows-11-vs2026-arm` | `windows-11-arm` |
| Intel Mac | `macos-26-intel` | `macos-15-intel` | `macos-26-intel` | `macos-26-intel` |
| Apple silicon Mac | `macos-26` | `macos-15` | `xcode-27` | `macos-latest` |

Some labels resolve to the same OS or image. Reports preserve the requested label and observed OS/image versions, so label coverage is not presented as extra hardware coverage. Fixed OS labels are checked against their observed releases; rolling labels report the version they actually used.

Linux uses Playwright 1.65's Chrome for Testing with the `chromium` channel. This includes a native Linux ARM64 build. Windows x64 and Macs use Chrome. Windows ARM64 uses installed Edge and checks its executable architecture; Playwright's Chrome/Edge installers currently select x64 Windows binaries and are not used there.

`ubuntu-slim` is a small container with a hard 15-minute job limit. It runs the video smoke check only. The `models` suite plans seven smoke checks and six model checks; the slim model check is explicitly not planned. Setup, browser or codec failures still fail the cell.

### Browser baseline

Choose `baseline` to keep the original six-browser comparison. Its `models` suite plans six smoke checks and six model checks.

| Standard runner | Architecture | Browser |
| --- | --- | --- |
| macos-15-intel | x64 | Chrome stable |
| macos-15-intel | x64 | Playwright WebKit |
| macos-15 | arm64 | Chrome stable |
| macos-15 | arm64 | Playwright WebKit |
| windows-2025 | x64 | Chrome stable |
| windows-2025 | x64 | Edge stable |

Playwright WebKit is not the installed Safari app. Hosted runners also do not represent every user's GPU, device or video format. These checks do not cover login, the database, saving/reopening projects, or deployment health outside the preview route.

## Run on GitHub

1. Publish only this harness repository.
2. Deploy a preview separately from the private app. It must implement the protocol in [CONTRACT.md](CONTRACT.md).
3. Open **Actions → Browser compatibility → Run workflow**.
4. Enter the HTTPS preview origin and its exact build ID, or set the repository variables MAVEFORM_PREVIEW_URL and MAVEFORM_EXPECTED_BUILD_ID.
5. Choose a profile: current, older, newer, aliases, or baseline.
6. Choose smoke. Choose models when you want real model downloads and the slower core pipeline check on the profile's planned model cells.

The compatibility workflow is manual. The separate public-harness workflow checks this repository on pushes and pull requests without contacting the app.

CI requires an expected app build ID. Every browser must report that ID. Reports also identify the exact harness commit, workflow run/attempt, profile, and planned checks. Missing, duplicate, unexpected or mismatched cells fail the combined result. Host, Node and browser architecture are checked separately. The matrix uses fail-fast: false, so one failure does not cancel the remaining browsers.

Standard jobs have a 40-minute ceiling. Slim jobs have shorter setup/test budgets to leave time for reports within GitHub's 15-minute limit. The workflow runs one batch per branch/profile/suite at a time, with GitHub's normal pending-run behavior.

## Run locally

Prerequisites: Node 24+, FFmpeg, ffprobe, and the browser you want to test.

~~~sh
npm ci --ignore-scripts
npm run check
npm run setup:media
npm run fixtures
~~~

The media setup command uses installed tools first. On CI it can install FFmpeg through the OS package manager. Linux speech fixtures also use espeak-ng. Locally, installation requires setting COMPAT_ALLOW_TOOL_INSTALL=1 explicitly. FFMPEG_PATH and FFPROBE_PATH can select existing binaries.

Install Chrome on x64 Windows or macOS with Playwright's CLI:

~~~sh
node node_modules/@playwright/test/cli.js install chrome
~~~

macOS shell:

~~~sh
MAVEFORM_BASE_URL=https://your-preview.example \
MAVEFORM_EXPECTED_BUILD_ID=your-exact-build-id \
COMPAT_BROWSER=chrome npm run test:smoke
~~~

Windows PowerShell:

~~~powershell
$env:MAVEFORM_BASE_URL = 'https://your-preview.example'
$env:MAVEFORM_EXPECTED_BUILD_ID = 'your-exact-build-id'
$env:COMPAT_BROWSER = 'msedge'
npm run test:smoke
~~~

Use webkit on macOS, msedge on Windows, or chromium for Chrome for Testing. On Linux, install it with `node node_modules/@playwright/test/cli.js install --with-deps --no-shell chromium`. On Windows ARM64, reuse installed native Edge instead of running Playwright's x64 channel installers. Local HTTP is accepted only for localhost. Local runs without an expected ID are clearly labelled unverified; CI rejects that configuration.

For the manual model check:

~~~sh
npm run fixtures:models
npm run test:models
~~~

The speech fixture uses the operating system's speech synthesizer, or espeak-ng on Linux. If no usable voice is available, fixture generation fails explicitly. No real person, recording or user media is used.

## Reports and debugging

Each cell produces sanitized JSON, Markdown and JUnit XML in reports/public. The combined GitHub job lists every cell selected by the profile, including its planned checks. Missing or unsuccessful cells fail the run. Uploaded artifacts expire after 3 days.

Reports include browser/runner versions, app and harness identity, capability flags, stage and failure code, worker phases, timings and independent media measurements. Model attempts and completed model checks are distinct. A download timeout is a failure, not a claim that inference was tested. Raw app error text, private paths, source maps, network requests, cookies, screenshots and media files are not uploaded.

For local debugging only, set COMPAT_LOCAL_DEBUG=1. This retains Playwright traces and a local HTML report in ignored folders. CI rejects that flag. Do not publish those raw files.

Generated fixtures and downloads stay ignored. The fixture's content and timing are deterministic; encoded file hashes can differ across FFmpeg versions or CPU architectures. The manifest records the generator version and each hash.

## Dependencies and sources

Playwright is pinned in package-lock.json. GitHub actions are pinned to verified official tag SHAs. Native FFmpeg and browser versions are recorded because runner images change.

- [Playwright browser channels](https://playwright.dev/docs/browsers)
- [Playwright projects](https://playwright.dev/docs/test-projects)
- [GitHub runner images](https://github.com/actions/runner-images)
- [FFmpeg filters and synthetic sources](https://ffmpeg.org/ffmpeg-filters.html)
- [FFmpeg command documentation](https://ffmpeg.org/ffmpeg.html)
