#!/usr/bin/env python3
"""
body.py - the one command Sophia runs to use her body.

She already has a shell tool that runs on your Windows machine once the Remote
Runtime is connected. So her body needs no new Sophia code at all, no plugin, no
API, no server: it needs a command line she can call.

    python body.py list                 what is wired up right now
    python body.py get room_temp        read one sensor
    python body.py set desk_lamp on     drive one output
    python body.py ping                 is the board alive

Everything prints one short line, so the answer lands in her context as a fact
rather than as a wall of output.

Requires pyserial:   pip install pyserial

Safety, and this is worth doing before you wire anything to mains: add
    python*body.py set*
to the "Must review" deny list under Shell command in her tool approval
settings. Reads stay instant, and every single physical action then stops and
asks you before it happens. That is the same approval gate you already set up,
pointed at the part of the system that can actually move something.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

CONFIG = Path(__file__).resolve().parent / "devices.json"

# The board prints a banner when it resets. Opening the serial port on most
# ESP32 and Arduino boards *causes* that reset, so the first read has to be
# allowed to be the banner rather than the answer to our question.
BANNER_PREFIXES = ("OK ready", "OK pong")


def load_board() -> dict:
    if not CONFIG.exists():
        die(f"{CONFIG.name} not found next to body.py")
    try:
        raw = json.loads(CONFIG.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        die(f"{CONFIG.name} is not valid JSON: {exc}")
    board = raw.get("board") or {}
    port = str(board.get("serial_port") or "").strip()
    if not port:
        die('no serial_port set in devices.json (for example "COM5")')
    return {"port": port, "baud": int(board.get("baud") or 115200)}


def die(message: str) -> "None":
    # One line, prefixed, on stdout as well as stderr. Sophia reads stdout, and a
    # failure she cannot see is a failure she will confidently report as success.
    print(f"ERROR {message}")
    print(f"ERROR {message}", file=sys.stderr)
    raise SystemExit(1)


def open_board(board: dict):
    try:
        import serial  # type: ignore
    except ImportError:
        die("pyserial is not installed. Run: pip install pyserial")

    try:
        link = serial.Serial(board["port"], board["baud"], timeout=1.5)
    except Exception as exc:  # noqa: BLE001 - the reason varies wildly by platform
        die(
            f"cannot open {board['port']}: {exc}. "
            "Check the cable, check the port in devices.json, and close the "
            "Arduino Serial Monitor if it is open - only one program can hold "
            "the port at a time."
        )
    # Give the board time to finish its reset before talking to it.
    time.sleep(1.6)
    link.reset_input_buffer()
    return link


def ask(link, command: str, expect_many: bool = False) -> list[str]:
    link.write((command + "\n").encode("ascii", "ignore"))
    link.flush()

    lines: list[str] = []
    deadline = time.time() + 4.0
    while time.time() < deadline:
        raw = link.readline()
        if not raw:
            if lines:
                break
            continue
        text = raw.decode("utf-8", "replace").strip()
        if not text:
            continue
        # Skip a reset banner that arrived after we already sent the command.
        if not lines and text.startswith(BANNER_PREFIXES) and not command.upper().startswith("PING"):
            continue
        lines.append(text)
        if not expect_many:
            break
        if text.startswith("OK count="):
            break
    if not lines:
        die("the board did not answer. Is it flashed with sophia_body.ino?")
    return lines


def main() -> int:
    parser = argparse.ArgumentParser(description="Talk to Sophia's body.")
    sub = parser.add_subparsers(dest="action", required=True)
    sub.add_parser("ping", help="check the board is alive")
    sub.add_parser("list", help="list everything that is wired up")
    p_get = sub.add_parser("get", help="read one device")
    p_get.add_argument("name")
    p_set = sub.add_parser("set", help="drive one device")
    p_set.add_argument("name")
    p_set.add_argument("value", help="on, off, or a number 0-255 for pwm_out")

    args = parser.parse_args()
    board = load_board()
    link = open_board(board)
    try:
        if args.action == "ping":
            for line in ask(link, "PING"):
                print(line)
        elif args.action == "list":
            for line in ask(link, "LIST", expect_many=True):
                print(line)
        elif args.action == "get":
            for line in ask(link, f"GET {args.name}"):
                print(line)
        elif args.action == "set":
            for line in ask(link, f"SET {args.name} {args.value}"):
                print(line)
    finally:
        link.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
