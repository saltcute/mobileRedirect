import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  diffHealth,
  initialHealthState,
  SIGNAL_SAMPLES,
  type HealthSnapshot,
  type HealthState,
} from '../src/modem/health-state.ts';

const sample = (over: Partial<HealthSnapshot> = {}): HealthSnapshot => ({
  simState: 'READY',
  simAbsent: false,
  bars: 4,
  ...over,
});

/** Feed a series of samples through, returning the end state and everything emitted. */
function run(samples: HealthSnapshot[], from: HealthState = initialHealthState()) {
  let state = from;
  const emitted = [];
  for (const s of samples) {
    const result = diffHealth(state, s);
    state = result.state;
    emitted.push(...result.transitions);
  }
  return { state, emitted };
}

describe('diffHealth — SIM', () => {
  test('a healthy first reading is silent', () => {
    const { emitted, state } = run([sample()]);
    assert.deepEqual(emitted, []);
    assert.equal(state.sim?.kind, 'ready');
  });

  test('an unhealthy first reading is reported even though nothing changed', () => {
    const { emitted } = run([sample({ simState: null, simAbsent: true })]);
    assert.equal(emitted.length, 1);
    assert.equal(emitted[0]?.type, 'sim-changed');
    assert.equal((emitted[0] as { to: { kind: string } }).to.kind, 'absent');
  });

  test('reports removal and reinstallation', () => {
    const { emitted } = run([
      sample(),
      sample({ simState: null, simAbsent: true }),
      sample(),
    ]);
    assert.equal(emitted.length, 2);
    assert.equal((emitted[0] as { to: { kind: string } }).to.kind, 'absent');
    assert.equal((emitted[1] as { to: { kind: string } }).to.kind, 'ready');
    assert.equal((emitted[1] as { from: { kind: string } }).from.kind, 'absent');
  });

  test('a PIN lock is a change, and holding at that lock is not', () => {
    const { emitted } = run([
      sample(),
      sample({ simState: 'SIM PIN' }),
      sample({ simState: 'SIM PIN' }),
    ]);
    assert.equal(emitted.length, 1);
    assert.equal((emitted[0] as { to: { kind: string; detail: string } }).to.detail, 'SIM PIN');
  });

  test('an unreadable SIM is not a removal — it reports nothing and keeps the last value', () => {
    // The distinction that matters: a busy command queue must never look like
    // someone pulling the card out.
    const { emitted, state } = run([sample(), sample({ simState: null, simAbsent: false })]);
    assert.deepEqual(emitted, []);
    assert.equal(state.sim?.kind, 'ready');
  });
});

describe('diffHealth — signal hysteresis', () => {
  test('needs a full run of low samples before firing', () => {
    const low = sample({ bars: 1 });
    for (let n = 1; n < SIGNAL_SAMPLES; n++) {
      assert.deepEqual(run(Array<HealthSnapshot>(n).fill(low)).emitted, [], `${n} samples`);
    }
    const { emitted } = run(Array<HealthSnapshot>(SIGNAL_SAMPLES).fill(low));
    assert.equal(emitted.length, 1);
    assert.equal(emitted[0]?.type, 'signal-low');
  });

  test('one good sample resets the run', () => {
    const { emitted } = run([
      sample({ bars: 0 }),
      sample({ bars: 0 }),
      sample({ bars: 3 }),
      sample({ bars: 0 }),
      sample({ bars: 0 }),
    ]);
    assert.deepEqual(emitted, []);
  });

  test('an unknown sample interrupts neither run', () => {
    // rssi 99 maps to 0 bars but means "no reading". Counting it as low would
    // raise a false alarm; resetting on it would stop a real one from ever
    // confirming on a flaky link.
    const { emitted } = run([
      sample({ bars: 1 }),
      sample({ bars: null }),
      sample({ bars: 1 }),
      sample({ bars: 1 }),
    ]);
    assert.equal(emitted.length, 1);
    assert.equal(emitted[0]?.type, 'signal-low');
  });

  test('fires once while it stays low, then once again on recovery', () => {
    const low = Array<HealthSnapshot>(SIGNAL_SAMPLES + 4).fill(sample({ bars: 1 }));
    const good = Array<HealthSnapshot>(SIGNAL_SAMPLES).fill(sample({ bars: 4 }));
    const { emitted } = run([...low, ...good]);
    assert.deepEqual(
      emitted.map((t) => t.type),
      ['signal-low', 'signal-recovered'],
    );
  });

  test('recovery needs a full run too', () => {
    const { emitted } = run([
      ...Array<HealthSnapshot>(SIGNAL_SAMPLES).fill(sample({ bars: 1 })),
      ...Array<HealthSnapshot>(SIGNAL_SAMPLES - 1).fill(sample({ bars: 4 })),
    ]);
    assert.deepEqual(
      emitted.map((t) => t.type),
      ['signal-low'],
    );
  });
});
