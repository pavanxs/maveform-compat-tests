# Intel Mac download reproduction

## Scope

This is a standalone runner diagnostic, independent of application compatibility (`appCompatibility: "not-tested"`). It loads only an authored text Blob on a loopback page. No application source, models, or user media are involved. Regular MP4 download and independent media-validation gates remain unchanged.

## Tested environment

Both pairs matched these observed values:

| Field | Value |
| --- | --- |
| Runner | `macos-26-intel` |
| OS / kernel | macOS 26.6.1 / Darwin 25.6.0 |
| ImageOS / ImageVersion | `macos26` / `20260824.0517.1` |
| Browser | Chrome `157.0.8103.39`, Playwright `channel: "chrome"` |
| Playwright / Node | `1.65.0` / `24.19.0` |
| Host / Node / browser architecture | x64 / x64 / x64; browser evidence `chromium-version-x64` |
| Page | Secure and cross-origin isolated; COOP `same-origin`, COEP `credentialless` |

The fixture is exactly 37 UTF-8 bytes: `Maveform synthetic download control.\n`. Its SHA-256 is `c0b4914ecb1d549c68bfd970dadd681c41ffb526deb22df15dd01f7684abe5e0`.

## Recorded pairs

- [Click-wait pair: run 42527009038](https://github.com/pavanxs/maveform-compat-tests/actions/runs/42527009038), commit `a491105651ed0fcd80e809b30addd161ad29bfe1`: normal headless versus headless with `noWaitAfter=true`. Harness checks passed 67/67.
- [Window-mode pair: run 42527917295](https://github.com/pavanxs/maveform-compat-tests/actions/runs/42527917295), commit `2b72e0e2e5c994c4706bf1c70ffbfa2b75e03d82`: normal headless versus headed, both `noWaitAfter=false`. Harness checks passed 69/69.

Each pair used the same source and matched image/browser versions, on separate fresh VMs.

## Reproduce through GitHub Actions

These commands dispatch remote runs; no local test execution is needed:

```sh
gh workflow run harness.yml --repo pavanxs/maveform-compat-tests --ref ci/download-phase-diagnostics -f intel_download_probe=true -f intel_download_pair=click-wait
gh workflow run harness.yml --repo pavanxs/maveform-compat-tests --ref ci/download-phase-diagnostics -f intel_download_probe=true -f intel_download_pair=window-mode
```

The branch and runner label can change. Compare the reports' actual commit, image, Chrome, and architecture before interpreting a new pair. Sanitized JSON artifacts are named `intel-download-probe-<mode>-<run>-<attempt>` and retained for one day.

## Mandatory checks and observations

A pass requires the real download event, completed locator click, completed `saveAs()`, `download.failure() === null`, and exact saved bytes/content, alongside environment and cleanup checks. A download event alone proves only that the download started.

All four cases received that event. Normal clicks, including headed mode, hit `DOWNLOAD_CLICK_TIMEOUT` at `download-event-and-click`; saving never began. With `noWaitAfter=true`, the click completed but `saveAs()` hit `DOWNLOAD_SAVE_TIMEOUT` at `download-save`. No downloaded file was validated.

Before cancellation, the original page heartbeat, download-status request, and creation of a fresh context all timed out. Cancellation and browser/context cleanup also failed to complete within their bounds. Incremental reports survived; no watchdog termination was reported.

## Interpretation limits

Neither headed mode nor `noWaitAfter` fixed this reproduction. `browser.isConnected() === true` only means Playwright had not observed disconnection; it does not prove responsiveness. No page crash was observed.

The evidence does not isolate Chrome, Playwright, or the runner environment as the cause. It does not establish application compatibility or justify relaxing media checks. Further optional Mac experiments are paused.
