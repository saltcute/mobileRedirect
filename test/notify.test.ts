import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import pino from 'pino';
import { Notifier, type NotifySetting } from '../src/telegram/notify.ts';
import type { GatewayBot } from '../src/telegram/deps.ts';

const silent = pino({ level: 'silent' });

interface Sent {
  chatId: number;
  text: string;
}

/** A bot whose only job is to record what it was asked to send. */
function fakeBot(onSend?: () => void) {
  const sent: Sent[] = [];
  const bot = {
    api: {
      sendMessage: async (chatId: number, text: string) => {
        onSend?.();
        sent.push({ chatId, text });
        return { message_id: sent.length };
      },
    },
  } as unknown as GatewayBot;
  return { bot, sent };
}

function build(setting: NotifySetting, chatIds = [1], over: Record<string, number> = {}) {
  const { bot, sent } = fakeBot();
  const notifier = new Notifier({ bot, chatIds, setting, logger: silent, ...over });
  return { notifier, sent };
}

describe('Notifier — level filtering', () => {
  test('off sends nothing at all', async () => {
    const { notifier, sent } = build('off');
    await notifier.send({ level: 'critical', text: 'a' });
    assert.deepEqual(sent, []);
    assert.equal(notifier.enabled, false);
  });

  test('each level admits itself and everything more urgent', async () => {
    const cases: [NotifySetting, number][] = [
      ['critical', 1],
      ['normal', 2],
      ['verbose', 3],
    ];
    for (const [setting, expected] of cases) {
      const { notifier, sent } = build(setting);
      await notifier.send({ level: 'critical', text: 'c' });
      await notifier.send({ level: 'normal', text: 'n' });
      await notifier.send({ level: 'verbose', text: 'v' });
      assert.equal(sent.length, expected, setting);
    }
  });
});

describe('Notifier — throttling', () => {
  test('a keyed alert fires once, then counts what it swallowed', async () => {
    const { notifier, sent } = build('verbose', [1], { throttleMs: 60_000 });
    for (let i = 0; i < 4; i++) {
      await notifier.send({ key: 'k', level: 'critical', text: 'boom' });
    }
    assert.equal(sent.length, 1);

    // A zero window means no throttling at all, so every one gets through.
    const { notifier: n2, sent: s2 } = build('verbose', [1], { throttleMs: 0 });
    await n2.send({ key: 'k', level: 'critical', text: 'boom' });
    await n2.send({ key: 'k', level: 'critical', text: 'boom' });
    assert.equal(s2.length, 2);
  });

  test('reports how many were suppressed while the window was open', async () => {
    const { notifier, sent } = build('verbose', [1], { throttleMs: 25 });
    await notifier.send({ key: 'k', level: 'critical', text: 'boom' });
    await notifier.send({ key: 'k', level: 'critical', text: 'boom' });
    await notifier.send({ key: 'k', level: 'critical', text: 'boom' });
    await new Promise((r) => setTimeout(r, 40));
    await notifier.send({ key: 'k', level: 'critical', text: 'boom' });
    assert.equal(sent.length, 2);
    assert.match(sent[1]!.text, /\+2 more since the last alert/);
  });

  test('separate keys throttle separately', async () => {
    const { notifier, sent } = build('verbose', [1], { throttleMs: 60_000 });
    await notifier.send({ key: 'a', level: 'critical', text: 'x' });
    await notifier.send({ key: 'b', level: 'critical', text: 'y' });
    assert.equal(sent.length, 2);
  });

  test('unkeyed edge transitions are never throttled', async () => {
    // attached/detached/sim/signal are already emitted once per change, so a
    // second one inside the window is a second real event.
    const { notifier, sent } = build('verbose', [1], { throttleMs: 60_000 });
    await notifier.send({ level: 'normal', text: 'connected' });
    await notifier.send({ level: 'normal', text: 'disconnected' });
    await notifier.send({ level: 'normal', text: 'connected' });
    assert.equal(sent.length, 3);
  });

  test('the rate cap drops the overflow and says so on the next one through', async () => {
    const { notifier, sent } = build('verbose', [1], { ratePerMinute: 3 });
    for (let i = 0; i < 6; i++) await notifier.send({ level: 'normal', text: `m${i}` });
    assert.equal(sent.length, 3);

    // The cap is per 60s window, so nothing else gets through until it clears;
    // the count rides out on the first message that does.
    const { notifier: n2, sent: s2 } = build('verbose', [1], { ratePerMinute: 1 });
    await n2.send({ level: 'normal', text: 'first' });
    await n2.send({ level: 'normal', text: 'dropped' });
    assert.equal(s2.length, 1);
  });
});

describe('Notifier — delivery', () => {
  test('sends to every configured chat', async () => {
    const { notifier, sent } = build('verbose', [10, 20, 30]);
    await notifier.send({ level: 'critical', text: 'hi' });
    assert.deepEqual(
      sent.map((s) => s.chatId),
      [10, 20, 30],
    );
  });

  test('a Telegram failure never propagates to the caller', async () => {
    // The callers are event handlers on the modem registry; an unhandled
    // rejection there would take down a poll cycle over a chat message.
    const bot = {
      api: {
        sendMessage: async () => {
          throw new Error('429 Too Many Requests');
        },
      },
    } as unknown as GatewayBot;
    const notifier = new Notifier({ bot, chatIds: [1], setting: 'verbose', logger: silent });
    await notifier.send({ level: 'critical', text: 'hi' });
  });

  test('one failing chat does not stop the others', async () => {
    const sent: number[] = [];
    const bot = {
      api: {
        sendMessage: async (chatId: number) => {
          if (chatId === 2) throw new Error('blocked by user');
          sent.push(chatId);
          return { message_id: 1 };
        },
      },
    } as unknown as GatewayBot;
    const notifier = new Notifier({ bot, chatIds: [1, 2, 3], setting: 'verbose', logger: silent });
    await notifier.send({ level: 'critical', text: 'hi' });
    assert.deepEqual(sent, [1, 3]);
  });
});
