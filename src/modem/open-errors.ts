/** Turns a serial open() failure into an actionable hint. */
export function diagnoseOpenError(message: string): string | null {
  if (/permission denied|EACCES/i.test(message)) {
    return 'permission denied — install deploy/99-sim7070.rules, then `udevadm control --reload && udevadm trigger` (see README)';
  }
  if (/busy|EBUSY/i.test(message)) {
    // Almost always ModemManager, which Raspberry Pi OS enables by default and
    // which claims any port it recognises as a modem. Note that installing the
    // udev rule is not enough on its own: ID_MM_DEVICE_IGNORE is only consulted
    // when the device appears, so a ModemManager that already holds the port
    // keeps holding it until it is restarted or the module is replugged.
    return 'port already in use — most likely ModemManager. Check with `sudo fuser -v /dev/ttyUSB*`; fix with `sudo systemctl mask --now ModemManager` (see README)';
  }
  return null;
}

/**
 * Explains a command that failed because the channel died beneath it, rather
 * than because the modem rejected it.
 *
 * Distinct from an open failure: the port was working, so the module itself went
 * away mid-operation. Network selection is a common trigger because attaching is
 * when the radio transmits hardest.
 */
export function diagnoseChannelLoss(message: string): string | null {
  if (/serial port closed|port is not open|ENXIO|ENODEV|EIO/i.test(message)) {
    return (
      'the modem dropped off the USB bus mid-command — it reset or browned out. ' +
      'A SIM7070 draws ~2A peaks while transmitting, so check the power supply ' +
      '(a powered hub or a dedicated 5V/2A feed) before suspecting firmware. ' +
      'The gateway re-attaches automatically once it re-enumerates.'
    );
  }
  return null;
}
