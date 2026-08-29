/**
 * Lists every attached SIM7070 with its identity and live status.
 *
 * Needs no Telegram token — this is the first thing to run after wiring up the
 * udev rule, and the check that two modules are told apart correctly.
 */
import { discoverSerialCandidates } from '../src/modem/discovery.js';
import { AtChannel } from '../src/modem/at-channel.js';
import { logger } from '../src/logger.js';
import {
  parseCops,
  parseCpin,
  parseCpms,
  parseCpsi,
  parseCreg,
  parseCsq,
  parseIccid,
  parseImei,
  parseCnum,
} from '../src/modem/parse.js';

const log = logger.child({ component: 'probe' });

async function main(): Promise<void> {
  const candidates = await discoverSerialCandidates(log);

  if (candidates.length === 0) {
    console.log('No SIMCom AT ports found.');
    console.log('  · Is the module plugged in?  lsusb | grep 1e0e');
    console.log('  · Is the option driver bound? ls /sys/bus/usb-serial/devices/');
    return;
  }

  console.log(`Found ${candidates.length} SIMCom AT port(s):\n`);

  for (const candidate of candidates) {
    console.log(`── ${candidate.path}  (USB ${candidate.usbLocation}, ${candidate.vendorId}:${candidate.productId})`);

    const channel = new AtChannel({ path: candidate.path, logger: log });
    try {
      await channel.open();
    } catch (err) {
      const message = (err as Error).message;
      console.log(`   ✗ cannot open: ${message}`);
      if (/permission denied|EACCES/i.test(message)) {
        console.log('     Install the udev rule: see README, deploy/99-sim7070.rules');
      }
      console.log();
      continue;
    }

    try {
      await channel.execute('AT', 3000);
      await channel.execute('ATE0');
      await channel.execute('AT+CMEE=2');

      const say = async (label: string, cmd: string, parse: (l: string[]) => unknown) => {
        try {
          const value = parse(await channel.execute(cmd, 8000));
          console.log(`   ${label.padEnd(10)} ${value === null ? '—' : formatValue(value)}`);
        } catch (err) {
          console.log(`   ${label.padEnd(10)} error: ${(err as Error).message}`);
        }
      };

      const sayFirst = async (
        label: string,
        cmds: string[],
        parse: (l: string[]) => unknown,
      ) => {
        for (const cmd of cmds) {
          try {
            const value = parse(await channel.execute(cmd, 8000));
            if (value !== null && value !== undefined) {
              console.log(`   ${label.padEnd(10)} ${formatValue(value)}`);
              return;
            }
          } catch {
            // Try the next spelling.
          }
        }
        console.log(`   ${label.padEnd(10)} —`);
      };

      await say('IMEI', 'AT+CGSN', parseImei);
      // Which spelling works varies by firmware revision; mirror Modem.readIdentity.
      await sayFirst('ICCID', ['AT+CICCID', 'AT+CCID'], parseIccid);
      await say('Number', 'AT+CNUM', parseCnum);
      await say('SIM', 'AT+CPIN?', parseCpin);
      await say('Signal', 'AT+CSQ', parseCsq);
      await say('Carrier', 'AT+COPS?', parseCops);
      await say('Network', 'AT+CREG?', (l) => parseCreg(l, 'CREG'));
      await say('System', 'AT+CPSI?', parseCpsi);
      await say('Storage', 'AT+CPMS?', parseCpms);
    } catch (err) {
      console.log(`   ✗ probe failed: ${(err as Error).message}`);
    } finally {
      await channel.close();
      console.log();
    }
  }
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>)
      .map(([k, v]) => `${k}=${v ?? '—'}`)
      .join(' ');
  }
  return String(value);
}

main().catch((err: Error) => {
  console.error(err.message);
  process.exitCode = 1;
});
