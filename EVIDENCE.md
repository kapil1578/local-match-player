# Verification and measurement scope

Reviewed and tested on 24 October 2026. The following are separate evidence categories.

## Runnable public examples

Executed against the exact files in `examples/`:

| Command (from examples/) | Result |
| --- | --- |
| `node verify_caption_worklet.cjs` | 24/24 checks passed |
| `python -B -m unittest verify_football_engine` | 37/37 tests passed |

These are deterministic, offline tests. They do not use live media or measure model accuracy. The source manifest records the hashes of the examples and test files at publication.

## Additional checks in the complete local project

The inspected local application passed these selected checks during this review:

| Suite | Passed | Scope |
| --- | ---: | --- |
| Caption cadence | 9 | Adaptive scheduling, latest-only queue, timing expiry and source ownership |
| Audio worklet | 24 | Generated PCM and offline scheduling |
| Tracking lifecycle | 48 | Fake DOM/timers/fetch/workers; stale-result and lifecycle rejection |
| Football engine + vision transport | 43 | Synthetic engine states and mocked subprocess failures |

Total: **124 selected offline checks**, not a full-project coverage claim. The public example tests overlap with these checks; their counts must not be added to 124. The other local suites are not bundled in this selected-source publication.

## Synthetic scheduling experiment

The preserved [simulation report](evidence/caption-cadence-simulation.json), generated on 23 October 2026, compares the same 600 simulated utterance-end times with actual offline AudioWorklet emission times. It uses generated PCM, not recorded speech.

| Scheduling metric | Two-second hop | One-second hop |
| --- | ---: | ---: |
| Mean scheduling wait | 1,000 ms | 500 ms |
| p95 scheduling wait | 1,850 ms | 950 ms |
| Initial context wait | 4,000 ms | 4,000 ms |

This measures scheduling only. It excludes model inference, transport, queueing, browser delivery and recognition quality. It must not be presented as a 50% improvement in total live-caption latency.

To regenerate from the public examples:

```sh
cd examples
node verify_caption_worklet.cjs --report
```

The generated report is written under `examples/`; the dated report under `evidence/` is preserved separately.

## Not established

No claim is made here about live word error rate, football-event accuracy, production scalability, full-match possession, named-player identity, off-camera coverage, or real-world adoption. Historical local GPU timings are intentionally not used as resume performance claims.
