'use strict';

// Offline only: deterministic generated PCM, a VM worklet and real structured
// cloning. No browser, microphone, stream, recognizer or network is used.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const SOURCE = fs.readFileSync(path.join(__dirname, 'caption-worklet.js'), 'utf8');
const RATE = 16000, WINDOW = RATE * 4;
let passed = 0;

function makeInput(rate, seconds, channelCount = 2, silence = false) {
  return Array.from({length:channelCount}, (_, channel) => {
    const values = new Float32Array(rate * seconds);
    if (!silence) for (let i = 0; i < values.length; i++) {
      // Distinct, non-periodic channel values exercise order, averaging, signs
      // and clipping; Float32 storage matches what process() actually receives.
      values[i] = (((i * (channel ? 29 : 17) + channel * 47) % 1301) - 650) / 400;
    }
    return values;
  });
}

function expectedPcm(channels, rate) {
  const output = new Int16Array(Math.floor(channels[0].length * RATE / rate));
  for (let index = 0; index < output.length; index++) {
    // Independent sample-boundary formulation of the existing box-average
    // resampler: integer input frame spans, not another phase accumulator.
    const start = Math.ceil(index * rate / RATE), end = Math.ceil((index + 1) * rate / RATE);
    let sum = 0;
    for (let frame = start; frame < end; frame++) {
      let mono = 0;
      for (const channel of channels) mono += channel[frame] || 0;
      sum += mono / channels.length;
    }
    output[index] = Math.round(Math.max(-1, Math.min(1, sum / (end - start))) * 32767);
  }
  return output;
}

function harness(rate, options, {seconds = 10, channelCount = 2, baseFrame = 731, silence = false} = {}) {
  let Processor;
  const output = [], transfers = [], buffers = new Set();
  const channels = makeInput(rate, seconds, channelCount, silence);
  const context = vm.createContext({sampleRate:rate, currentFrame:baseFrame, Int16Array,
    AudioWorkletProcessor:class {
      constructor() {
        this.port = {onmessage:null, postMessage(message, transfer) {
          assert.equal(transfer.length, 1, 'only the PCM output buffer is transferred');
          assert.equal(transfer[0], message.pcm, 'transfer list owns the delivered PCM');
          assert.equal(message.pcm.byteLength, WINDOW * 2, 'every transfer contains four seconds');
          assert(!buffers.has(message.pcm), 'each emitted buffer has distinct ownership');
          buffers.add(message.pcm);
          const received = structuredClone(message, {transfer});
          assert.equal(message.pcm.byteLength, 0, 'sender output really detaches');
          transfers.push(transfer[0]);
          output.push({pcm:new Int16Array(received.pcm), endTime:received.endTime});
        }};
      }
    },
    registerProcessor(name, value) { assert.equal(name, 'stream-captions'); Processor = value; }
  });
  vm.runInContext(SOURCE, context, {filename:'caption-worklet.js'});
  const processor = new Processor(options);
  let position = 0, blockIndex = 0;
  const blocks = [17, 128, 511, 1, 257, 64, 333];
  return {rate, baseFrame, processor, output, transfers, channels, context,
    feedUntil(frame) {
      assert(frame >= position && frame <= channels[0].length);
      while (position < frame) {
        const size = Math.min(blocks[blockIndex++ % blocks.length], frame - position);
        context.currentFrame = baseFrame + position;
        const block = channels.map(channel => channel.subarray(position, position + size));
        assert.equal(processor.process([block]), true);
        position += size;
      }
    },
    send(data) { assert.equal(typeof processor.port.onmessage, 'function'); processor.port.onmessage({data}); },
    times() { return output.map(item => item.endTime - baseFrame / rate); }
  };
}

function exactPcm(page) {
  const expected = expectedPcm(page.channels, page.rate);
  for (const message of page.output) {
    const inputEnd = Math.round(message.endTime * page.rate - page.baseFrame);
    assert(Math.abs(message.endTime * page.rate - page.baseFrame - inputEnd) < 1e-7,
      'endTime is the actual input frame, including the nonzero AudioContext origin');
    const outputEnd = Math.floor(inputEnd * RATE / page.rate);
    assert.equal(message.pcm.length, WINDOW);
    assert(outputEnd >= WINDOW, 'the first window is never shortened');
    const start = outputEnd - WINDOW;
    const mismatch = message.pcm.findIndex((sample, index) => sample !== expected[start + index]);
    assert.equal(mismatch, -1, `PCM at frame ${inputEnd} exactly matches its contiguous four-second span`);
  }
}

function exactTimes(page, expected) {
  const actual = page.times();
  assert.equal(actual.length, expected.length, 'window count');
  actual.forEach((value, index) => assert(Math.abs(value - expected[index]) < 1e-9,
    `window ${index}: expected ${expected[index]}s, received ${value}s`));
}

function test(name, run) {
  try { run(); passed++; console.log('  ok  ' + name); }
  catch (error) { console.error('  FAIL ' + name + '\n    ' + error.message); process.exitCode = 1; }
}

for (const rate of [16000, 44100, 48000]) {
  for (const hop of [undefined, 1, 2]) test(`${rate} Hz, ${hop ?? 'default'}s hop: complete exact PCM and frame times`, () => {
    const page = harness(rate, hop === undefined ? undefined : {processorOptions:{hopSeconds:hop}},
      {channelCount:hop === 1 ? 1 : 2});
    page.feedUntil(rate * 4 - 1);
    assert.equal(page.output.length, 0, 'wait for the entire first four seconds');
    page.feedUntil(rate * 8);
    exactTimes(page, hop === 1 ? [4, 5, 6, 7, 8] : [4, 6, 8]);
    exactPcm(page);
  });

  test(`${rate} Hz: accelerate before the shorter hop is due`, () => {
    const page = harness(rate);
    page.feedUntil(rate * 4.5);
    page.send({hopSeconds:1});
    assert.equal(page.output.length, 1, 'a port message does not manufacture a window');
    page.feedUntil(rate * 8);
    exactTimes(page, [4, 5, 6, 7, 8]);
    exactPcm(page);
  });

  test(`${rate} Hz: slow down relative to the last emitted frame`, () => {
    const page = harness(rate, {processorOptions:{hopSeconds:1}});
    page.feedUntil(rate * 4.5);
    page.send({hopSeconds:2});
    page.feedUntil(rate * 8);
    exactTimes(page, [4, 6, 8]);
    exactPcm(page);
  });

  test(`${rate} Hz: late acceleration emits fresh context then exact 1s hops`, () => {
    const page = harness(rate);
    page.feedUntil(rate * 5.5);
    page.send({hopSeconds:1});
    assert.equal(page.output.length, 1);
    const firstEndFrame = Math.ceil(5.5 * RATE * rate / RATE + rate / RATE);
    page.feedUntil(rate * 8);
    exactTimes(page, [4, firstEndFrame / rate, firstEndFrame / rate + 1, firstEndFrame / rate + 2]);
    exactPcm(page);
  });
}

test('receiver mutation cannot corrupt retained overlap or later transfers', () => {
  const page = harness(48000, {processorOptions:{hopSeconds:1}});
  page.feedUntil(48000 * 4);
  page.output[0].pcm.fill(-32768);
  page.output.shift();
  page.feedUntil(48000 * 8);
  exactTimes(page, [5, 6, 7, 8]);
  exactPcm(page);
  assert(page.transfers.every(buffer => buffer.byteLength === 0));
});

test('changes before startup never shorten the four-second context', () => {
  const page = harness(16000);
  page.feedUntil(16000);
  page.send({hopSeconds:1});
  page.feedUntil(16000 * 3);
  page.send({hopSeconds:2});
  page.feedUntil(16000 * 4 - 1);
  assert.equal(page.output.length, 0);
  page.send({hopSeconds:1});
  page.feedUntil(16000 * 6);
  exactTimes(page, [4, 5, 6]);
  exactPcm(page);
});

test('invalid constructor configurations retain the backward-compatible 2s hop', () => {
  const options = [null, {}, {processorOptions:null}, ...[null, 0, 3, -1, '1', true, NaN, Infinity, {}, [1]]
    .map(hopSeconds => ({processorOptions:{hopSeconds}}))];
  for (const option of options) {
    const page = harness(16000, option, {seconds:6, silence:true});
    page.feedUntil(16000 * 6);
    exactTimes(page, [4, 6]);
  }
});

test('invalid control messages cannot change a valid hop or flush audio', () => {
  const page = harness(16000, {processorOptions:{hopSeconds:1}});
  page.feedUntil(16000 * 4.5);
  for (const value of [null, undefined, 2, '2', [], {}, {hopSeconds:null}, {hopSeconds:'2'},
    {hopSeconds:0}, {hopSeconds:3}, {hopSeconds:NaN}, {hopSeconds:Infinity}, {hopSeconds:true}]) page.send(value);
  assert.equal(page.output.length, 1);
  page.feedUntil(16000 * 7);
  exactTimes(page, [4, 5, 6, 7]);
  exactPcm(page);
});

test('repeated settings and round-trip changes preserve exact window overlap', () => {
  const page = harness(44100, {processorOptions:{hopSeconds:1}});
  page.feedUntil(44100 * 4.5);
  page.send({hopSeconds:1});
  page.feedUntil(44100 * 5.5);
  page.send({hopSeconds:2});
  page.feedUntil(44100 * 7.5);
  page.send({hopSeconds:1});
  page.feedUntil(44100 * 10);
  exactTimes(page, [4, 5, 7, 8, 9, 10]);
  exactPcm(page);
});

test('missing audio inputs emit no synthetic silence or premature window', () => {
  const page = harness(16000);
  assert.equal(page.processor.process([]), true);
  assert.equal(page.processor.process([[]]), true);
  assert.equal(page.processor.process([[new Float32Array(0)]]), true);
  assert.equal(page.output.length, 0);
  page.feedUntil(16000 * 4);
  exactTimes(page, [4]);
  exactPcm(page);
});

console.log(`\nverify_caption_worklet: ${passed}/24 checks passed`);

if (!process.exitCode && process.argv.includes('--report')) {
  const utteranceEnds = Array.from({length:600}, (_, i) => (4050 + i * 100) / 1000);
  const variants = [2, 1].map(hopSeconds => {
    const page = harness(16000, {processorOptions:{hopSeconds}}, {seconds:64, baseFrame:0, silence:true});
    page.feedUntil(16000 * 64);
    const emitted = page.times();
    const delays = utteranceEnds.map(end => Math.round((emitted.find(time => time >= end) - end) * 1000));
    const sorted = [...delays].sort((a, b) => a - b);
    return {hop_seconds:hopSeconds, emitted_windows:emitted.length, first_window_at_ms:emitted[0] * 1000,
      input_timestamps:utteranceEnds.length, scheduling_delay_ms:{
        mean:delays.reduce((sum, value) => sum + value, 0) / delays.length,
        median:(sorted[299] + sorted[300]) / 2, p95:sorted[Math.ceil(sorted.length * .95) - 1],
        min:sorted[0], max:sorted.at(-1)}};
  });
  const report = {kind:'OFFLINE SCHEDULING SIMULATION ONLY', generated_at:new Date().toISOString(),
    context_seconds:4, pcm_sample_rate:RATE, variants,
    method:'Worklet emission times from 64 seconds of generated zero PCM; both variants use the same 600 simulated utterance-end timestamps, 4.05s through 63.95s at 100ms intervals.',
    exclusions:['No live audio or browser', 'No ASR inference or queueing measured',
      'No recognition accuracy evaluated', 'No claim about total live caption latency'],
    mean_scheduling_reduction_ms:variants[0].scheduling_delay_ms.mean - variants[1].scheduling_delay_ms.mean};
  const destination = path.join(__dirname, 'caption-cadence-simulation.json');
  fs.writeFileSync(destination, JSON.stringify(report, null, 2) + '\n');
  console.log('Saved offline scheduling simulation: 2s vs 1s hop (not ASR accuracy or live latency).');
}
