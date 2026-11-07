# Maveform browser compatibility tests

This is a standalone public test harness. It opens an already deployed Maveform preview in real browsers. It never checks out, builds, or publishes the private application.

## What gets tested

The default smoke check uses a generated 3-second video: moving test shapes, a 440 Hz tone, H.264 video and AAC audio. It uploads that fixture, decodes a frame in the browser, then exports a 2-second portrait clip twice through the app: captions off and captions on.

FFmpeg and ffprobe inspect the downloaded files independently. The test checks dimensions, codecs, duration, every decoded packet, moving/nonblank frames, preserved sound, and a localized caption change. A missing API, unavailable codec, failed export or missing runner is a failure, not a skipped pass.

The manual models suite also creates at least 30 seconds of computer-generated speech. It runs real transcription and Atlas embedding/clip finding, then checks recognized words, timing, complete sentence embedding coverage and actual clips. It does not claim to test face detection, scene detection or Genesis.

## Browser matrix

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
5. Choose smoke. Choose models only when you deliberately want model downloads and the slower core pipeline check.

The compatibility workflow is manual. The separate public-harness workflow checks this repository on pushes and pull requests without contacting the app.

CI requires an expected build ID. Every browser must report that ID. Mixed IDs, missing reports, skipped checks and wrong runner architectures fail the combined result. The matrix uses fail-fast: false, so one failure does not cancel the remaining browsers.

## Run locally

Prerequisites: Node 24+, FFmpeg, ffprobe, and the browser you want to test.

~~~sh
npm ci --ignore-scripts
npm run check
npm run setup:media
npm run fixtures
~~~

The media setup command uses installed tools first. On CI it installs FFmpeg through Homebrew on macOS or Chocolatey on Windows if required. Locally, installation requires setting COMPAT_ALLOW_TOOL_INSTALL=1 explicitly. FFMPEG_PATH and FFPROBE_PATH can select existing binaries.

Install a missing browser with Playwright's CLI:

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

Use webkit on macOS or msedge on Windows. Local HTTP is accepted only for localhost. Local runs without an expected ID are clearly labelled unverified; CI rejects that configuration.

For the manual model check:

~~~sh
npm run fixtures:models
npm run test:models
~~~

The speech fixture uses the operating system's speech synthesizer. If no voice is available, fixture generation fails explicitly. No real person, recording or user media is used.

## Reports and debugging

Each cell produces sanitized JSON, Markdown and JUnit XML in reports/public. The combined GitHub job lists all six cells and fails if any is missing or unsuccessful. Uploaded artifacts expire after 3 days.

Reports include browser/runner versions, build identity, capability flags, stage and failure code, worker phases, timings and independent media measurements. Raw app error text, private paths, source maps, network requests, cookies, screenshots and media files are not uploaded.

For local debugging only, set COMPAT_LOCAL_DEBUG=1. This retains Playwright traces and a local HTML report in ignored folders. CI rejects that flag. Do not publish those raw files.

Generated fixtures and downloads stay ignored. The fixture's content and timing are deterministic; encoded file hashes can differ across FFmpeg versions or CPU architectures. The manifest records the generator version and each hash.

## Dependencies and sources

Playwright is pinned in package-lock.json. GitHub actions are pinned to verified official tag SHAs. Native FFmpeg and browser versions are recorded because runner images change.

- [Playwright browser channels](https://playwright.dev/docs/browsers)
- [Playwright projects](https://playwright.dev/docs/test-projects)
- [GitHub runner images](https://github.com/actions/runner-images)
- [FFmpeg filters and synthetic sources](https://ffmpeg.org/ffmpeg-filters.html)
- [FFmpeg command documentation](https://ffmpeg.org/ffmpeg.html)
