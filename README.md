# mobileRedirect — SMS ↔ Telegram gateway

Bridges SMS and Telegram in both directions over SIMCom **SIM7070G** modules.
Incoming SMS are posted to Telegram; replying to one sends an SMS back to that
sender on the SIM that received it. Multiple modules on one host are supported.

## Commands

| Command | Purpose |
| --- | --- |
| `/select` | Choose which SIM to use (skipped automatically when only one is attached) |
| `/send <number> <text>` | Send an SMS from the selected SIM |
| `/history [n\|all]` | Recent messages, newest last |
| `/status` | Signal, carrier, roaming, registration, SIM state, SMS storage |
| `/network` | Carrier selection and radio settings — see below |

### Carrier and radio selection

```
/network                              current carrier, radio mode, last attach error
/network scan                         list visible carriers (slow, drops registration)
/network auto                         automatic carrier selection
/network use <plmn> [gsm|catm|nbiot]  pin one carrier
/network rat <catm|nbiot|both>        LTE-IoT technology (AT+CMNB)
/network mode <auto|gsm|lte|gsm+lte>  radio generations (AT+CNMP)
```

Mainly for diagnosing `registration denied`, which means the network *answered
and refused* the attach — so the antenna, SIM and driver are all working, and the
cause is subscription- or technology-side. `/network scan` marks each carrier
`available`, `current` or **`forbidden`**; forbidden is the network refusing this
SIM, which no modem setting will change. If the carrier is *not* forbidden but
registration still fails, try a different `/network rat` — carriers provision
Cat-M and NB-IoT separately, and a SIM enabled for one will be refused on the
other.

`/network use` applies a **hard lock** (`AT+COPS=1`), not manual-with-fallback
(`AT+COPS=4`). Fallback would silently revert to automatic whenever the chosen
network refused or was unreachable, which destroys the thing you are testing — a
selection that "succeeds" tells you nothing if it might have fallen back. A hard
lock fails loudly instead.

The trade-off is real and deliberate: a failed selection leaves the module
**deregistered** rather than on some other network, and the lock **persists across
reboots**. `/network auto` is the only way out, and both `/network` and `/status`
flag a modem that is locked and unregistered.

**Replying:** every inbound SMS is posted as a Telegram message. Use Telegram's
native reply on it and the text goes back to that sender — on the modem that
received it, regardless of the current `/select`.

## Requirements

- **Node.js 24+** — uses the built-in `node:sqlite`, so there is no
  `better-sqlite3` to compile. On Raspberry Pi OS install from NodeSource; the
  distro package is older. (On Node 22 `node:sqlite` needs `--experimental-sqlite`.)
- **64-bit OS on a Pi 4/5** so `serialport` uses its `linux-arm64` prebuild. On
  32-bit or a Pi Zero it builds from source and needs `build-essential` + `python3`.
- A Telegram bot token from [@BotFather](https://t.me/BotFather).

## Setup

```bash
npm install
cp .env.example .env      # then fill in TELEGRAM_BOT_TOKEN and ALLOWED_USER_IDS
```

### 1. Stop ModemManager claiming the modem

Raspberry Pi OS enables ModemManager by default, and it opens any port it
recognises as a modem — the gateway then fails with `Device or resource busy`.
On a dedicated gateway the simplest fix is to remove it from the picture:

```bash
sudo systemctl mask --now ModemManager
```

The udev rule below also sets `ID_MM_DEVICE_IGNORE=1`, but that alone does not
free a port ModemManager is *already* holding — the property is only consulted
when the device appears, so it takes effect after a restart or a replug.

### 2. Grant access to the modem's serial port

Ports are owned by `root` with mode `0660`, so the rule below hands the AT
control interface to your user. It is scoped to SIMCom's vendor id and to
interface `02` — no other serial device on the machine is affected.

```bash
sed "s/__USER__/$USER/" deploy/99-sim7070.rules | sudo tee /etc/udev/rules.d/99-sim7070.rules
sudo udevadm control --reload && sudo udevadm trigger
```

Confirm it applied — `/dev/ttyUSB2` should now be owned by you rather than
`root:uucp`:

```bash
ls -l /dev/ttyUSB2
```

The rule also sets `ID_MM_DEVICE_IGNORE=1`. ModemManager, which Raspberry Pi OS
enables by default, otherwise opens the AT port and interleaves its own probing —
corrupting responses and swallowing new-message indications.

### 3. Confirm the hardware

```bash
npm run probe
```

Lists every attached module with IMEI, ICCID, carrier and signal. This is the
check that two modules are told apart correctly — see *Identifying modules* below.

### 4. Run it

```bash
npm run dev      # foreground, reloads on change
npm run build && npm start
```

## Deploying to a Raspberry Pi

```bash
sudo useradd --system --home /opt/mobile-redirect smsgw
sudo cp -r . /opt/mobile-redirect && cd /opt/mobile-redirect
sudo -u smsgw npm ci && sudo -u smsgw npm run build

sudo cp .env.example /etc/mobile-redirect.env   # edit it; chmod 600, it holds the token
sudo chmod 600 /etc/mobile-redirect.env

sudo cp deploy/sms-gateway.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now sms-gateway
journalctl -u sms-gateway -f
```

Install the udev rule with `OWNER="smsgw"` on the Pi so the service user owns the
port. Set `DB_PATH=/var/lib/mobile-redirect/gateway.sqlite` — systemd creates that
directory via `StateDirectory`.

A **system** service rather than a user service is deliberate: user services need
`loginctl enable-linger` to start on a headless boot, and fail silently without it.

## How it works

### Identifying modules

Every SIM7070G ships the **same hardcoded USB serial number**
(`1234567890ABCDEF`), so `/dev/serial/by-id` collapses two modules onto one
symlink and cannot tell them apart. `ttyUSBn` numbering is no better — it is
assigned in enumeration order and shuffles on replug.

So modules are keyed on:

- **USB topology** (`1-6.3.4.1`, the bus and physical port chain) for the slot, and
- **IMEI** for the module, **ICCID** for the SIM, read over AT.

Friendly names come from `MODEM_LABELS`, keyed by ICCID or IMEI.

### Ports

The module exposes six TTYs. For PID `9206`: `ttyUSB0`=DIAG, `1`=NMEA,
**`2`=AT control**, `3`=QFLOG, `4`=DAM, `5`=AT data. The gateway matches
interface `02` in sysfs; the others accept a connection and then never answer.

### SMS

PDU mode (`AT+CMGF=0`) throughout — text mode cannot represent non-GSM-7
characters and offers no way to build the UDH that multipart messages need.
Encoding (GSM-7 vs UCS-2) and segmentation are automatic.

Inbound messages are **persisted before** the SIM slot is released with
`AT+CMGD`, so a crash in between costs a duplicate — absorbed by a dedupe index —
rather than the message. Deleting is mandatory: SIM storage holds only ~20–30
messages and the modem silently stops accepting new ones once it fills.

Multipart messages are reassembled in a buffer table and flushed after
`CONCAT_TIMEOUT_MS` if a segment never arrives, so one lost segment cannot strand
the rest.

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| `Permission denied` opening the port | Rule not installed, or it did not match — check with `ls -l /dev/ttyUSB2`; it should be owned by your user, not `root:uucp` |
| Rule installed but ownership unchanged | The rule must match with `ENV{ID_VENDOR_ID}` + `ENV{ID_USB_INTERFACE_NUM}`, **not** `ATTRS{idVendor}` + `ATTRS{bInterfaceNumber}`: udev requires all `ATTRS{}` in one rule to match the same parent, and those two live on different parents, so the rule silently never fires |
| `npm run probe` finds nothing | It now says which case applies: *no module attached* (check `lsusb \| grep 1e0e`, the cable, and USB power) or *attached but no AT port bound* (check `lsmod \| grep option` and `dmesg \| grep -i ttyUSB`) |
| `Device or resource busy` opening the port | Another process holds it — find it with `sudo fuser -v /dev/ttyUSB*`. Nearly always ModemManager on Raspberry Pi OS: `sudo systemctl mask --now ModemManager`. Installing the udev rule alone is **not** enough if ModemManager already had the port: `ID_MM_DEVICE_IGNORE` is only read when the device appears, so restart it or replug the module |
| Commands time out, responses look garbled | ModemManager is on the port — confirm the udev rule applied, or `sudo systemctl mask --now ModemManager` |
| Modem vanishes during `/network` or `/send` | The module left the USB bus — it reset or browned out. A SIM7070 draws **~2A peaks while transmitting**, and attaching/sending is when it transmits hardest, so bus power alone is often not enough. Use a powered hub or a dedicated 5V/2A+ supply. The gateway re-attaches automatically once it re-enumerates (`module came back after disappearing` in the log) |
| SMS stop arriving | SIM storage full — `/status` shows occupancy; check `AT+CMGD` errors in the log |
| Bot ignores you | Your Telegram user ID is not in `ALLOWED_USER_IDS` (rejections are logged) |

`npm run at-console` opens an interactive AT prompt against the first modem and
prints URCs as they arrive — the quickest way to watch a `+CMTI` land.

## Testing

```bash
npm test        # 55 tests, no hardware required
npm run typecheck
```

Covers PDU encode/decode (GSM-7, UCS-2, multipart), concat reassembly including
out-of-order arrival and the stale flush, crash-replay dedupe, and the AT channel
against a mock serial device — URC interleaving, `+CME ERROR`, the newline-less
`>` send prompt, and the ESC abort path.

## Security notes

- The allowlist is enforced ahead of every handler. It is the only thing between
  a stranger and SMS billed to your SIM.
- Keep the bot token out of the repo; on the Pi it lives in
  `/etc/mobile-redirect.env` at mode `600`.
- SMS is unencrypted and visible to the carrier. Anything relayed through this
  gateway — 2FA codes especially — is exactly as exposed as ordinary SMS.
