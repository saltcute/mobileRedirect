/**
 * Interactive AT console against one modem.
 *
 * Usage: npm run at-console -- [/dev/ttyUSB2]
 * With no argument it uses the first discovered SIMCom AT port.
 *
 * URCs arriving between commands are printed as they come in, which makes this
 * the quickest way to watch a `+CMTI` land when an SMS arrives.
 */
import { createInterface } from 'node:readline';
import { discoverSerialCandidates } from '../src/modem/discovery.js';
import { AtChannel } from '../src/modem/at-channel.js';
import { logger } from '../src/logger.js';

const log = logger.child({ component: 'at-console' });

async function main(): Promise<void> {
  let path = process.argv[2];

  if (!path) {
    const candidates = await discoverSerialCandidates(log);
    if (candidates.length === 0) {
      console.error('No SIMCom AT ports found. Pass a device path explicitly.');
      process.exitCode = 1;
      return;
    }
    path = candidates[0]!.path;
    if (candidates.length > 1) {
      console.log(
        `${candidates.length} ports found; using ${path}. ` +
          `Others: ${candidates.slice(1).map((c) => c.path).join(', ')}`,
      );
    }
  }

  const channel = new AtChannel({ path, logger: log });
  await channel.open();
  console.log(`Connected to ${path}. Type AT commands, or "exit" to quit.\n`);

  channel.on('urc', (line: string) => console.log(`\x1b[36m<URC> ${line}\x1b[0m`));
  channel.on('failed', (err: Error) => {
    console.error(`\nChannel failed: ${err.message}`);
    process.exit(1);
  });

  const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: '> ' });
  rl.prompt();

  rl.on('line', async (input) => {
    const command = input.trim();
    if (command === 'exit' || command === 'quit') {
      rl.close();
      return;
    }
    if (command.length === 0) {
      rl.prompt();
      return;
    }

    try {
      const lines = await channel.execute(command, 20_000);
      for (const line of lines) console.log(`  ${line}`);
      console.log('  \x1b[32mOK\x1b[0m');
    } catch (err) {
      console.log(`  \x1b[31m${(err as Error).message}\x1b[0m`);
    }
    rl.prompt();
  });

  rl.on('close', () => {
    void channel.close().then(() => process.exit(0));
  });
}

main().catch((err: Error) => {
  console.error(err.message);
  process.exitCode = 1;
});
