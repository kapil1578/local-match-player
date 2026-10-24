# Architecture and engineering decisions

## Separate ownership and responsibilities

The browser owns playback, user intent and capture consent. The loopback Python server validates requests and owns local speech inference, metadata retrieval and the vision subprocess. Cross-origin media is not read directly; embedded-video analysis uses explicit browser-authorized tab sharing.

Caption audio and video frames remain in memory in the analysis path. The browser does not capture microphone audio for this pipeline. Model inference is local; selected media and fixture metadata still require their upstream providers.

## Bound work instead of accumulating delay

Four seconds of speech context are sent on an overlapping schedule. A ready GPU starts at a one-second hop; CPU uses two seconds. Slow processing backs off to two seconds, and recovery requires multiple sufficiently fast decoded windows. Only one request and one replaceable pending window are retained. Silence does not count as evidence of faster decoding.

Video capture permits one in-flight request and no accumulating frame queue. New sources and invalidated playback states reject late replies, including replies that arrive after a new session starts. This is tested with controlled promises, fake timers and worker transports in the full local project.

## Isolate incompatible inference dependencies

Captions use faster-whisper/CTranslate2 with CUDA or CPU. Vision runs in a child process using an isolated ONNX Runtime DirectML installation. The child remains warm while idle; disabling analysis stops requests. IPC uses bounded writer work and timeout handling so a blocked child cannot indefinitely occupy an HTTP request. Runtime readiness and fallback are exposed as status rather than assumed.

## Keep observation separate from interpretation

The included football engine consumes normalized tracks and ball observations; it does not run a detector itself. It maintains bounded shot-local state and applies evidence gates before estimating control, handoffs or passing geometry. Predicted positions alone cannot establish observed control. Camera cuts and missing observations invalidate assumptions.

Generic object detections are not verified identities. Visible-control estimates are not official match possession. Geometric passing options are not calibrated completion probabilities. Fixture facts must remain bound to the selected fixture rather than inferred from a continuous channel.

## Tradeoffs and remaining work

- Four-second context imposes startup delay even if inference is fast.
- Latest-only queues favor freshness over exhaustive processing.
- Conservative evidence gates can show no result during difficult footage.
- The local GPU adapter configuration is machine-specific; portability needs further packaging work.
- Live transcription quality, small-ball recall and football-event accuracy need labelled evaluation data.
- The public examples are a reviewable subset. End-to-end setup, dependencies and model provenance must be packaged before a complete distributable release.
