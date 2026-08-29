import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { scanForModems, explainEmptyScan } from '../src/modem/discovery.ts';

const silent = pino({ level: 'silent' });
let root: string;

/** Builds a fake sysfs USB tree: one device dir plus one dir per interface. */
async function addUsbDevice(opts: {
  location: string;
  vendorId: string;
  productId: string;
  /** interface number -> tty name, or null for an interface with nothing bound */
  interfaces: Record<string, string | null>;
  /** Every SIM7070G ships this same placeholder value. */
  serial?: string;
}): Promise<void> {
  const base = join(root, 'bus/usb/devices');
  const deviceDir = join(base, opts.location);
  await mkdir(deviceDir, { recursive: true });
  await writeFile(join(deviceDir, 'idVendor'), `${opts.vendorId}\n`);
  await writeFile(join(deviceDir, 'idProduct'), `${opts.productId}\n`);
  await writeFile(join(deviceDir, 'serial'), `${opts.serial ?? '1234567890ABCDEF'}\n`);

  for (const [num, tty] of Object.entries(opts.interfaces)) {
    const ifaceDir = join(base, `${opts.location}:1.${Number(num)}`);
    await mkdir(ifaceDir, { recursive: true });
    await writeFile(join(ifaceDir, 'bInterfaceNumber'), `${num}\n`);
    if (tty) await mkdir(join(ifaceDir, tty), { recursive: true });
  }
}

/** A SIM7070G in PID 9206 layout: 6 interfaces, AT control on 02. */
const sim7070 = (location: string, ttyBase: number) => ({
  location,
  vendorId: '1e0e',
  productId: '9206',
  interfaces: Object.fromEntries(
    ['00', '01', '02', '03', '04', '05'].map((n, i) => [n, `ttyUSB${ttyBase + i}`]),
  ),
});

describe('modem discovery', () => {
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'sysfs-'));
    await mkdir(join(root, 'bus/usb/devices'), { recursive: true });
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test('selects only the AT control interface, not the other five', async () => {
    await addUsbDevice(sim7070('1-6.3.4.1', 0));
    const { candidates } = await scanForModems(silent, root);

    assert.equal(candidates.length, 1);
    assert.equal(candidates[0]?.path, '/dev/ttyUSB2');
    assert.equal(candidates[0]?.interfaceNumber, '02');
    assert.equal(candidates[0]?.usbLocation, '1-6.3.4.1');
  });

  test('distinguishes two modules that share one placeholder USB serial', async () => {
    // The failure this guards: every SIM7070G reports the same iSerial, so
    // /dev/serial/by-id collapses both onto one symlink. Topology must separate
    // them. Non-contiguous tty numbering mirrors a real Pi (ttyUSB2 + ttyUSB8).
    await addUsbDevice(sim7070('1-2', 6));
    await addUsbDevice(sim7070('3-2', 0));

    const { candidates } = await scanForModems(silent, root);

    assert.equal(candidates.length, 2);
    assert.deepEqual(
      candidates.map((c) => c.usbLocation),
      ['1-2', '3-2'],
    );
    assert.deepEqual(
      candidates.map((c) => c.path),
      ['/dev/ttyUSB8', '/dev/ttyUSB2'],
      'each module must resolve to its own AT port',
    );
  });

  test('ignores non-SIMCom serial devices', async () => {
    await addUsbDevice({
      location: '1-1',
      vendorId: '0403',
      productId: '6001',
      interfaces: { '00': 'ttyUSB0', '02': 'ttyUSB1' },
    });
    const { candidates, simcomDevicesPresent } = await scanForModems(silent, root);
    assert.equal(candidates.length, 0);
    assert.equal(simcomDevicesPresent, 0);
  });

  test('reports "none attached" rather than failing when no module is present', async () => {
    const report = await scanForModems(silent, root);
    assert.equal(report.candidates.length, 0);
    assert.equal(report.problem, null);
    assert.match(explainEmptyScan(report), /no SIMCom module is attached/);
  });

  test('survives a sysfs tree with no usb-serial bus at all', async () => {
    // The Pi hit exactly this: /sys/bus/usb-serial/devices does not exist until
    // the usbserial module loads, which an earlier implementation required.
    const report = await scanForModems(silent, root);
    assert.equal(report.problem, null, 'a missing usb-serial bus is not an error');
  });

  test('distinguishes an attached module whose driver never bound', async () => {
    await addUsbDevice({
      location: '1-4',
      vendorId: '1e0e',
      productId: '9206',
      interfaces: { '00': null, '02': null },
    });
    const report = await scanForModems(silent, root);

    assert.equal(report.candidates.length, 0);
    assert.equal(report.simcomDevicesPresent, 1, 'the device itself was seen');
    assert.match(explainEmptyScan(report), /no AT port is bound/);
    assert.match(explainEmptyScan(report), /option driver/);
  });

  test('reports an unreadable USB bus as a problem', async () => {
    const report = await scanForModems(silent, join(root, 'does-not-exist'));
    assert.ok(report.problem, 'a missing USB bus is a real problem');
    assert.match(explainEmptyScan(report), /cannot read/);
  });
});
