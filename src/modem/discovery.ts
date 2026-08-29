import { readdir, readFile, realpath } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type { Logger } from '../logger.js';

const USB_SERIAL_DEVICES = '/sys/bus/usb-serial/devices';

/** SimTech / SIMCom */
const SIMCOM_VENDOR_ID = '1e0e';

/**
 * The AT *control* interface per product.
 *
 * SIM7070/7080/7090 expose two USB layouts, switchable with `AT+CUSBSELNV`:
 *   9205 — 0:DIAG 1:NMEA 2:AT(control) 3:AT(data)
 *   9206 — 0:DIAG 1:NMEA 2:AT(control) 3:QFLOG 4:DAM 5:AT(data)
 * Both put the control port on interface 02; the other interfaces will accept a
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
   * enumeration order and shuffles across reboots and replugs, and the SIM7070's
   * USB iSerial is a hardcoded placeholder shared by every unit, so neither can
   * distinguish two modules. The port chain can.
   */
  usbLocation: string;
  vendorId: string;
  productId: string;
  interfaceNumber: string;
}

async function readAttr(dir: string, name: string): Promise<string | null> {
  try {
    return (await readFile(join(dir, name), 'utf8')).trim();
  } catch {
    return null;
  }
}

/**
 * Enumerate SIMCom AT control ports currently attached.
 *
 * Walks sysfs rather than /dev/serial/by-id: by-id keys on the USB iSerial, which
 * every SIM7070G reports as the same placeholder string, so two modules collide
 * onto one symlink.
 */
export async function discoverSerialCandidates(log: Logger): Promise<SerialCandidate[]> {
  let ttyNames: string[];
  try {
    ttyNames = await readdir(USB_SERIAL_DEVICES);
  } catch (err) {
    log.warn(
      { err: (err as Error).message, dir: USB_SERIAL_DEVICES },
      'cannot enumerate usb-serial devices',
    );
    return [];
  }

  const found: SerialCandidate[] = [];

  for (const tty of ttyNames) {
    try {
      // /sys/bus/usb-serial/devices/ttyUSB2 ->
      //   /sys/devices/.../1-6.3.4.1/1-6.3.4.1:1.2/ttyUSB2
      const resolved = await realpath(join(USB_SERIAL_DEVICES, tty));
      const interfaceDir = dirname(resolved);
      const usbDeviceDir = dirname(interfaceDir);

      const [vendorId, productId, interfaceNumber] = await Promise.all([
        readAttr(usbDeviceDir, 'idVendor'),
        readAttr(usbDeviceDir, 'idProduct'),
        readAttr(interfaceDir, 'bInterfaceNumber'),
      ]);

      if (vendorId !== SIMCOM_VENDOR_ID) continue;

      const wanted =
        (productId && AT_INTERFACE_BY_PRODUCT[productId]) ?? DEFAULT_AT_INTERFACE;
      if (interfaceNumber !== wanted) continue;

      found.push({
        path: `/dev/${tty}`,
        usbLocation: basename(usbDeviceDir),
        vendorId,
        productId: productId ?? 'unknown',
        interfaceNumber,
      });
    } catch (err) {
      log.debug({ tty, err: (err as Error).message }, 'skipping tty during discovery');
    }
  }

  found.sort((a, b) => a.usbLocation.localeCompare(b.usbLocation));
  return found;
}
