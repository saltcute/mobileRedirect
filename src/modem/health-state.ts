/**
 * Turns periodic health samples into state *transitions*. Pure functions —
 * unit-testable without hardware, like `parse.ts`.
 *
 * Everything here is edge-triggered on purpose. The registry samples every
 * `SCAN_INTERVAL_MS`, so reporting the current state rather than the change
 * would produce an identical message every 15 seconds forever.
 */

/** How many bars still count as "low". */
export const SIGNAL_LOW_BARS = 1;
/**
 * Consecutive samples needed to declare low signal, and again to declare
 * recovery. A modem parked at the threshold flips bars constantly, so a single
 * sample either way is noise; at the default 15s scan interval three samples is
 * about 45 seconds of agreement in each direction.
 */
export const SIGNAL_SAMPLES = 3;

export type SimKind = 'ready' | 'absent' | 'locked';

export interface SimStatus {
  kind: SimKind;
  /** The raw `+CPIN` value, or `not inserted`. What the user actually sees. */
  detail: string;
}

/** One health sample. `null` means "the modem did not tell us", never "zero". */
export interface HealthSnapshot {
  /** Raw `+CPIN?` value (`READY`, `SIM PIN`, …), or null when unreadable. */
  simState: string | null;
  /** The modem answered that there is no card in the tray. */
  simAbsent: boolean;
  /** Signal bars, or null when the modem did not answer or reported unknown. */
  bars: number | null;
}

export interface HealthState {
  /** Last known SIM status, or null before the first successful read. */
  sim: SimStatus | null;
  lowSamples: number;
  okSamples: number;
  signalLow: boolean;
}

export type Transition =
  | { type: 'sim-changed'; from: SimStatus | null; to: SimStatus }
  | { type: 'signal-low'; bars: number }
  | { type: 'signal-recovered'; bars: number };

export function initialHealthState(): HealthState {
  return { sim: null, lowSamples: 0, okSamples: 0, signalLow: false };
}

function classifySim(snapshot: HealthSnapshot): SimStatus | null {
  if (snapshot.simAbsent) return { kind: 'absent', detail: 'not inserted' };
  if (snapshot.simState === null) return null;
  const detail = snapshot.simState.trim();
  if (/^READY$/i.test(detail)) return { kind: 'ready', detail };
  // Everything else the module reports here is some flavour of "you cannot use
  // this SIM yet": SIM PIN, SIM PUK, PH-SIM PIN, …
  return { kind: 'locked', detail };
}

/**
 * Fold one sample into the previous state.
 *
 * Returns the new state plus whatever changed. An unreadable field yields no
 * transition at all: a modem that has stopped answering is a *different* alert
 * (`poll-failing`), and treating silence as "SIM removed" would cry wolf every
 * time the command queue was busy.
 */
export function diffHealth(
  prev: HealthState,
  snapshot: HealthSnapshot,
): { state: HealthState; transitions: Transition[] } {
  const transitions: Transition[] = [];
  const state: HealthState = { ...prev };

  const sim = classifySim(snapshot);
  if (sim !== null) {
    const changed = prev.sim === null || prev.sim.detail !== sim.detail;
    // The first reading only seeds the state, so a healthy start stays quiet —
    // but a modem that comes up with no card, or a locked one, is worth saying
    // out loud even though nothing has "changed" yet.
    if (changed && (prev.sim !== null || sim.kind !== 'ready')) {
      transitions.push({ type: 'sim-changed', from: prev.sim, to: sim });
    }
    state.sim = sim;
  }

  const { bars } = snapshot;
  if (bars !== null) {
    if (bars <= SIGNAL_LOW_BARS) {
      state.lowSamples = prev.lowSamples + 1;
      state.okSamples = 0;
      if (!prev.signalLow && state.lowSamples >= SIGNAL_SAMPLES) {
        state.signalLow = true;
        transitions.push({ type: 'signal-low', bars });
      }
    } else {
      state.okSamples = prev.okSamples + 1;
      state.lowSamples = 0;
      if (prev.signalLow && state.okSamples >= SIGNAL_SAMPLES) {
        state.signalLow = false;
        transitions.push({ type: 'signal-recovered', bars });
      }
    }
  }
  // bars === null leaves both counters untouched rather than resetting them: a
  // single unreadable sample mid-run shouldn't restart a streak that is one
  // sample from confirming.

  return { state, transitions };
}
