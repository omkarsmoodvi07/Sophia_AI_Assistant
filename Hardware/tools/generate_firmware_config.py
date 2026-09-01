#!/usr/bin/env python3
"""
devices.json -> devices.h

Run this after every edit to devices.json, then flash the board. That is the
whole workflow: edit one file, run one command, click Upload.

    python tools/generate_firmware_config.py

It writes firmware/sophia_body/devices.h, which sophia_body.ino includes. The
sketch itself never changes.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
CONFIG = ROOT / "devices.json"
OUTPUT = ROOT / "firmware" / "sophia_body" / "devices.h"

TYPES = {
    "digital_out": "DEV_DIGITAL_OUT",
    "digital_in": "DEV_DIGITAL_IN",
    "analog_in": "DEV_ANALOG_IN",
    "pwm_out": "DEV_PWM_OUT",
    "ultrasonic": "DEV_ULTRASONIC",
}

# Names go straight into a C string and into Sophia's vocabulary, so keep them
# boring. Rejecting a bad name here is much kinder than a compiler error in the
# Arduino IDE, which is where you would otherwise meet it.
def check_name(name: str, seen: set[str]) -> None:
    if not name:
        raise ValueError("a device has no name")
    if name in seen:
        raise ValueError(f"two devices are both called {name!r}")
    if not all(c.islower() or c.isdigit() or c == "_" for c in name):
        raise ValueError(
            f"device name {name!r} must be lowercase letters, digits and underscores only"
        )
    if len(name) > 24:
        raise ValueError(f"device name {name!r} is too long (24 characters max)")


def escape(text: str) -> str:
    return text.replace("\\", "\\\\").replace('"', '\\"')


def main() -> int:
    if not CONFIG.exists():
        print(f"error: {CONFIG} not found", file=sys.stderr)
        return 1

    raw = json.loads(CONFIG.read_text(encoding="utf-8"))
    board = raw.get("board") or {}
    baud = int(board.get("baud") or 115200)
    devices = raw.get("devices") or []

    seen: set[str] = set()
    rows = []
    for entry in devices:
        name = str(entry.get("name") or "").strip()
        check_name(name, seen)
        seen.add(name)

        kind = str(entry.get("type") or "").strip()
        if kind not in TYPES:
            raise ValueError(
                f"device {name!r} has type {kind!r}; expected one of "
                + ", ".join(sorted(TYPES))
            )

        pin = int(entry["pin"])
        pin2 = int(entry.get("pin2") or 0)
        if kind == "ultrasonic" and not pin2:
            raise ValueError(f"device {name!r} is ultrasonic and needs pin2 (the echo pin)")

        rows.append(
            "  {{ \"{name}\", {kind}, {pin}, {pin2}, {invert}, {scale}f, {offset}f, \"{about}\" }},".format(
                name=escape(name),
                kind=TYPES[kind],
                pin=pin,
                pin2=pin2,
                invert="true" if entry.get("invert") else "false",
                scale=float(entry.get("scale", 1.0)),
                offset=float(entry.get("offset", 0.0)),
                about=escape(str(entry.get("about") or "")),
            )
        )

    # A zero-length array initialiser is not legal C++, and "it happens to
    # compile on GCC" is not a foundation. Emit a single unused placeholder when
    # there are no devices yet; DEVICE_COUNT stays 0, so no loop ever reads it.
    if rows:
        body = "\n".join(rows)
        array_size = ""
    else:
        body = '  { "", 0, 0, 0, false, 1.0f, 0.0f, "" }, // placeholder, DEVICE_COUNT is 0'
        array_size = "1"

    header = f"""/*
 * devices.h - GENERATED FILE, DO NOT EDIT.
 *
 * Produced from Hardware/devices.json by tools/generate_firmware_config.py.
 * Anything you type in here is lost the next time that runs. Edit devices.json.
 */

#ifndef SOPHIA_DEVICES_H
#define SOPHIA_DEVICES_H

#include <Arduino.h>

#define SOPHIA_BAUD {baud}

#define DEV_DIGITAL_OUT 0
#define DEV_DIGITAL_IN  1
#define DEV_ANALOG_IN   2
#define DEV_PWM_OUT     3
#define DEV_ULTRASONIC  4

struct Device {{
  const char *name;
  uint8_t type;
  uint8_t pin;
  uint8_t pin2;
  bool invert;
  float scale;
  float offset;
  const char *about;
}};

#define DEVICE_COUNT {len(rows)}

static const Device devices[{array_size}] = {{
{body}
}};

#endif
"""

    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text(header, encoding="utf-8")
    print(f"wrote {OUTPUT} ({len(rows)} device(s))")
    if not rows:
        print("note: devices.json has no devices yet, so the board will do nothing useful.")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (ValueError, KeyError, json.JSONDecodeError) as exc:
        print(f"error in devices.json: {exc}", file=sys.stderr)
        raise SystemExit(1)
