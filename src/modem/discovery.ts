import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Logger } from '../logger.js';

/** SimTech / SIMCom */
const SIMCOM_VENDOR_ID = '1e0e';

/**
 * The AT *control* interface per product.
 *
 * SIM7070/7080/7090 expose two USB layouts, switchable with `AT+CUSBSELNV`:
 *   9205 — 0:DIAG 1:NMEA 2:AT(control) 3:AT(data)
 *   9206 — 0:DIAG 1:NMEA 2:AT(control) 3:QFLOG 4:DAM 5:AT(data)
 * Both put the control port on interface 02; the other interfaces accept a
 * connection and then never answer `AT`, which is why we match on the interface
 * number rather than probing every tty.
 */
const AT_INTERFACE_BY_PRODUCT: Record<string, string> = {
  '9205': '02',
  '9206': '02',
};

/** Fallback when the product id is unknown but the vendor matches. */
const DEFAULT_AT_INTERFACE = '02';

export interface SerialCandidate {
  /** e.g. /dev/ttyUSB2 */
  path: string;
  /**
   * Stable physical location, e.g. `1-6.3.4.1` (bus-port.port…).
   *
   * This is the identity anchor for a physical USB slot. `ttyUSBn` is assigned in
   * enumeration order and shuffles across reboots and replugs (one Pi enumerated
   * two modules as ttyUSB2 and ttyUSB8), and the SIM7070's USB iSerial is a
   * hardcoded placeholder shared by every unit, so neither can distinguish two
   * modules. The port chain can.
   */
  usbLocation: string;
  vendorId: string;
  productId: string;
  interfaceNumber: string;
}

export interface DiscoveryReport {
  candidates: SerialCandidate[];
  /** SIMCom USB devices present, whether or not a tty is bound to them. */
  simcomDevicesPresent: number;
  /** Set when the scan could not run at all. */
  problem: string | null;
}

async function readAttr(dir: string, name: string): Promise<string | null> {
  try {
    return (await readFile(join(dir, name), 'utf8')).trim();
  } catch {
    return null;
  }
}

async function findTty(interfaceDir: string): Promise<string | null> {
  try {
    const entries = await readdir(interfaceDir);
    return entries.find((e) => e.startsWith('ttyUSB') || e.startsWith('ttyACM')) ?? null;
  } catch {
    return null;
  }
}

/**
 * Enumerate SIMCom AT control ports.
 *
 * Walks `/sys/bus/usb/devices`, which exists whenever USB does. An earlier
 * version read `/sys/bus/usb-serial/devices`, but that directory only appears
 * once the usbserial module has loaded — so with no modem yet bound it is absent
 * entirely, and the scan failed with ENOENT instead of reporting "none attached".
 *
 * Walking the USB bus also distinguishes "no module plugged in" from "module
 * plugged in but no driver bound to it", which are different problems.
 */
export async function scanForModems(
  log: Logger,
  sysfsRoot = '/sys',
): Promise<DiscoveryReport> {
  const usbDevices = join(sysfsRoot, 'bus/usb/devices');

  let entries: string[];
  try {
    entries = await readdir(usbDevices);
  } catch (err) {
    const problem = `cannot read ${usbDevices}: ${(err as Error).message}`;
    log.warn({ dir: usbDevices }, 'USB bus is not readable — is this a Linux host?');
    return { candidates: [], simcomDevicesPresent: 0, problem };
  }

  const candidates: SerialCandidate[] = [];
  const simcomDevices = new Set<string>();

  for (const entry of entries) {
    // Interface directories are named `<device>:<config>.<interface>`, e.g.
    // `1-6.3.4.1:1.2`. Anything without a colon is the USB device itself.
    const separator = entry.indexOf(':');
    if (separator === -1) continue;

    const deviceName = entry.slice(0, separator);
    const deviceDir = join(usbDevices, deviceName);

    const vendorId = await readAttr(deviceDir, 'idVendor');
    if (vendorId !== SIMCOM_VENDOR_ID) continue;
    simcomDevices.add(deviceName);

    const interfaceDir = join(usbDevices, entry);
    const [productId, interfaceNumber] = await Promise.all([
      readAttr(deviceDir, 'idProduct'),
      readAttr(interfaceDir, 'bInterfaceNumber'),
    ]);

    const wanted = (productId && AT_INTERFACE_BY_PRODUCT[productId]) ?? DEFAULT_AT_INTERFACE;
    if (interfaceNumber !== wanted) continue;

    const tty = await findTty(interfaceDir);
    if (!tty) {
      log.warn(
        { device: deviceName, interface: entry },
        'SIMCom AT interface has no serial device bound — the option driver may not recognise this product id',
      );
      continue;
    }

    candidates.push({
      path: `/dev/${tty}`,
      usbLocation: deviceName,
      vendorId,
      productId: productId ?? 'unknown',
      interfaceNumber,
    });
  }

  candidates.sort((a, b) => a.usbLocation.localeCompare(b.usbLocation));
  return { candidates, simcomDevicesPresent: simcomDevices.size, problem: null };
}

/** Convenience wrapper for callers that only want the ports. */
export async function discoverSerialCandidates(
  log: Logger,
  sysfsRoot = '/sys',
): Promise<SerialCandidate[]> {
  return (await scanForModems(log, sysfsRoot)).candidates;
}

/** Human-readable explanation for an empty scan. */
export function explainEmptyScan(report: DiscoveryReport): string {
  if (report.problem) return report.problem;
  if (report.simcomDevicesPresent === 0) {
    return 'no SIMCom module is attached (check `lsusb | grep 1e0e` and the USB cable/power)';
  }
  return `${report.simcomDevicesPresent} SIMCom module(s) attached but no AT port is bound — check that the option driver loaded (\`lsmod | grep option\`, \`dmesg | grep -i ttyUSB\`)`;
}
