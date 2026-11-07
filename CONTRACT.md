# Preview compatibility protocol v1

The deployed preview serves /compatibility/ and exposes window.__MAVEFORM_COMPAT__ after loading. This is a deliberately limited test surface. It must be unavailable in ordinary production builds.

The harness never logs in, receives application secrets or imports private source. It supplies only its own generated media.

## DOM hooks

| Hook | Purpose |
| --- | --- |
| data-testid="compat-video" | Local video file input |
| data-testid="compat-source-preview" | Video element for the selected file |
| data-testid="compat-download" | Download anchor for the latest completed export |
| data-testid="compat-export-preview" | Video element for the exported clip |

## Facade

~~~ts
interface CompatibilityFacade {
  version: 1;
  capabilities(): Promise<Capabilities>;
  snapshot(): Snapshot;
  exportClip(options: {
    startS?: number;
    endS?: number;
    captions?: boolean;
  }): Promise<ExportArtifact>;
  runCoreModels(): Promise<CoreModelsResult>;
  cancel(): void;
}
~~~

capabilities() reports secureContext, crossOriginIsolated, sharedArrayBuffer, webAssembly, webgpu, videoDecoder, videoEncoder, audioDecoder, audioEncoder, audioContext, offscreenCanvas and avcEncode. Boolean capability probes may return null when unresolved. It also reports cores and probeErrors. Capabilities are observations; successful output still has to pass independent validation.

snapshot() includes:

- version: 1 and an opaque buildId.
- mode: "deterministic-media".
- sourceStatus: empty, loading, ready or error.
- source: null or width, height, durationS, bytes, name and mimeType.
- sourceError: null or an error.
- export: phase, progress, error and artifact.
- models: phase, transcriptionPhase, atlasPhase, wordCount, sentenceCount, embeddingCount and error.

The harness strips names, URLs and raw errors before publishing diagnostics.

## Deterministic media export

exportClip() uses the production decoding, reframing, caption rendering and export code. It must not return the input file or a prepared fixture as the export.

For the smoke check, the harness requests source time 0.5–2.5 seconds with captions both off and on. The expected result is a 540×960 H.264/AAC MP4 containing the selected audio and video. Audio must not be silently removed.

The deterministic caption text is “Maveform compatibility”. It uses the production HORMOZI preset, centered at 78% of output height. Word timing divides the selected clip in half. The harness samples after fade-in and compares the caption band with a control band; the production no-face background is blurred video.

ExportArtifact includes buildId, url, filename, bytes, mimeType, width, height, startS, endS, captions, audioMode and elapsedMs. The public report excludes url and filename.

models.phase remains not-run during this check. Synthetic captions are test inputs, not claimed AI output.

## Optional real core models

runCoreModels() processes the selected synthetic spoken video using real transcription and Atlas workers. It returns:

~~~ts
interface CoreModelsResult {
  buildId: string;
  words: Array<{ text: string; start: number; end: number }>;
  sentences: Array<{
    id: string;
    startS: number;
    endS: number;
    words: Array<{ text: string; startS: number; endS: number }>;
  }>;
  embeddedSentenceIds: string[];
  embeddingCount: number;
  clips: Array<{
    id: string;
    startS: number;
    endS: number;
    durationS: number;
    source: "atlas";
  }>;
  atlasDevice: "wasm" | "webgpu" | null;
  preferredTranscriptionDevice: "wasm" | "webgpu";
  optionalLanes: {
    faceDetection: "not-run";
    sceneDetection: "not-run";
    genesis: "not-run";
  };
}
~~~

Embedding IDs must come from completed embeddings. Every unique sentence must have an embedding. Worker/download errors reject the call. Empty speech, fabricated results and silently skipped model stages must not count as success.

preferredTranscriptionDevice describes the preferred capability path; it does not prove which fallback device ultimately executed transcription.

## Identity and failure behavior

Every snapshot and result carries the same buildId. CI checks it against the required expected build ID. A missing facade, wrong revision, unsupported export codec or failed worker is reported as a failure with a stage and code.

The deterministic export lane requires export capabilities. The real core-model lane runs separately so that unavailable video encoding does not prevent testing actual audio/CPU fallback behavior.

The public harness additionally records its own commit, selected runner profile, requested suite, effective per-cell suite, planned checks, and workflow run/attempt. These values must match across the selected matrix. The application does not choose which cells passed or which checks were planned.

Seven-group profiles plan one media smoke check per group. When models is selected, six groups also run core models; ubuntu-slim explicitly plans media smoke only because of its 15-minute job limit. A runtime skip, missing setup, unavailable codec or unfinished model attempt cannot substitute for a planned successful check.

Runner evidence distinguishes the host architecture, Node architecture and browser executable architecture. Requested runner labels alone are not evidence of an OS release or native ARM browser. The report checks observed releases for fixed OS labels and records the actual image behind rolling labels.
