import { describe, expect, it } from 'vitest';

import {
  connectivityFromChannelStatus,
  durationInState,
  initialConnectivity,
  isOffline,
  isReconnection,
  observeConnectivity,
  type ChannelStatus,
} from './connectivity.js';

// Unit tests for the connectivity state machine behind the connectivity-lost
// indicator (Req 5.4) and the reconnect drain trigger (Req 5.5).

const T0 = 1_700_000_000_000;

describe('connectivityFromChannelStatus', () => {
  it('treats only SUBSCRIBED as online', () => {
    expect(connectivityFromChannelStatus('SUBSCRIBED')).toBe('online');
    // A channel that is not subscribed is not delivering partner changes, which
    // is indistinguishable from offline for Req 5.3/5.4.
    for (const status of ['CHANNEL_ERROR', 'TIMED_OUT', 'CLOSED'] satisfies ChannelStatus[]) {
      expect(connectivityFromChannelStatus(status)).toBe('offline');
    }
  });
});

describe('initialConnectivity', () => {
  it('starts offline with the indicator shown', () => {
    const state = initialConnectivity(T0);
    // Starting optimistically online would hide the indicator during the initial
    // connect and send the first mutations at the network instead of queueing.
    expect(state.status).toBe('offline');
    expect(state.indicatorVisible).toBe(true);
    expect(isOffline(state)).toBe(true);
  });
});

describe('observeConnectivity', () => {
  it('shows the indicator offline and hides it online (Req 5.4)', () => {
    const offline = initialConnectivity(T0);
    const online = observeConnectivity(offline, { kind: 'channel', status: 'SUBSCRIBED' }, T0 + 10);
    expect(online.status).toBe('online');
    expect(online.indicatorVisible).toBe(false);

    const lost = observeConnectivity(online, { kind: 'channel', status: 'TIMED_OUT' }, T0 + 20);
    expect(lost.status).toBe('offline');
    expect(lost.indicatorVisible).toBe(true);
  });

  it('accepts a platform network signal as well as a channel status', () => {
    const offline = initialConnectivity(T0);
    const online = observeConnectivity(offline, { kind: 'network', online: true }, T0 + 5);
    expect(online.status).toBe('online');

    const lost = observeConnectivity(online, { kind: 'network', online: false }, T0 + 6);
    expect(lost.status).toBe('offline');
  });

  it('does not move `since` when the status is unchanged', () => {
    const online = observeConnectivity(
      initialConnectivity(T0),
      { kind: 'channel', status: 'SUBSCRIBED' },
      T0 + 10,
    );
    // A heartbeat re-reporting the same status must not reset the duration...
    const again = observeConnectivity(online, { kind: 'channel', status: 'SUBSCRIBED' }, T0 + 999);
    expect(again.since).toBe(online.since);
    // ...and returns the identical object, so listeners are not woken needlessly.
    expect(again).toBe(online);
  });

  it('does not treat a burst of errors as repeated disconnections', () => {
    let state = observeConnectivity(
      initialConnectivity(T0),
      { kind: 'channel', status: 'SUBSCRIBED' },
      T0,
    );
    state = observeConnectivity(state, { kind: 'channel', status: 'CHANNEL_ERROR' }, T0 + 100);
    const firstLoss = state.since;
    state = observeConnectivity(state, { kind: 'channel', status: 'TIMED_OUT' }, T0 + 200);
    state = observeConnectivity(state, { kind: 'channel', status: 'CLOSED' }, T0 + 300);
    // Still one continuous offline period, so "offline for Ns" stays truthful.
    expect(state.since).toBe(firstLoss);
    expect(durationInState(state, T0 + 400)).toBe(300);
  });
});

describe('isReconnection', () => {
  it('is true only on the offline -> online edge (Req 5.5)', () => {
    const offline = initialConnectivity(T0);
    const online = observeConnectivity(offline, { kind: 'channel', status: 'SUBSCRIBED' }, T0 + 1);

    expect(isReconnection(offline, online)).toBe(true);
    // Level, not edge: a second online observation must not re-trigger a drain.
    expect(isReconnection(online, online)).toBe(false);
    expect(isReconnection(online, offline)).toBe(false);
    expect(isReconnection(offline, offline)).toBe(false);
  });
});

describe('durationInState', () => {
  it('never reports a negative duration for a clock that went backwards', () => {
    const state = initialConnectivity(T0);
    expect(durationInState(state, T0 - 5_000)).toBe(0);
  });
});
