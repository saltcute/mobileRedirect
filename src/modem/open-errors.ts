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
