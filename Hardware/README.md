# Hardware — Sophia's body

The software in the rest of this repository is the brain. This folder is
everything that lets her touch the physical world: sensors she can read, things
she can switch on, and eventually a body she lives in rather than a browser tab.

It is deliberately separate. Nothing in here imports anything from the Go server
or the Vue app, and nothing there imports anything from here. You can delete this
whole folder and Sophia keeps working; you can rebuild her brain from scratch and
the body still works. That separation is not tidiness, it is the thing that makes
the hardware safe to experiment with.

## The one idea

You never write code to add hardware.

You describe what you wired up in `devices.json`, run one command, and flash the
board once. The firmware reads your description at boot and works out what to do
with each pin. Adding a second sensor next week is four lines of JSON and one
Upload click — not a new sketch, not a new function, not a new anything.

```
Hardware/
  devices.json        <- the only file you edit. Pin numbers and plain-English names.
  body.py             <- the command Sophia runs to use her body.
  tools/
    generate_firmware_config.py   <- devices.json -> devices.h
  firmware/
    sophia_body/
      sophia_body.ino <- generic firmware. You never edit this.
      devices.h       <- generated. You never edit this either.
```

## Wiring something up, start to finish

1. **Wire it.** Pick any free GPIO. Note the number printed on the board.
2. **Describe it** in `devices.json`:

   ```json
   { "name": "desk_lamp", "type": "digital_out", "pin": 5, "invert": true,
     "about": "The lamp on my desk, through a relay board." }
   ```

   `invert: true` for relay boards, which are almost always active-low. You still
   say "on" and mean on; the firmware flips it.

3. **Generate and flash:**

   ```powershell
   cd E:\AI-Research\Repositories\Memoh-main\Hardware
   python tools\generate_firmware_config.py
   ```

   Then open `firmware\sophia_body\sophia_body.ino` in the Arduino IDE, pick your
   board and port, and click Upload. No libraries to install — the sketch uses
   nothing but the core, on purpose.

4. **Test it yourself first,** in the Arduino IDE's Serial Monitor at 115200 baud
   with the line ending set to Newline:

   ```
   LIST
   SET desk_lamp on
   GET room_temp
   ```

   If that works here, it will work from Sophia. If it does not, the problem is
   the wiring or `devices.json`, and you have found that out with nothing else in
   the picture. Close the Serial Monitor afterwards — only one program can hold
   the port at a time.

5. **Let her use it.** Close the monitor and run:

   ```powershell
   pip install pyserial
   python body.py list
   ```

That is the whole workflow. Every device after the first is step 2, 3 and 5.

## How Sophia actually reaches it

She needs no new code, no plugin and no server for this, which is the part worth
understanding because it is what makes the whole thing cheap.

She already has a shell tool. Once the Remote Runtime is connected, that shell
runs on your Windows machine — the same machine the board is plugged into. So
her body is just a command she can run:

```
python E:\AI-Research\Repositories\Memoh-main\Hardware\body.py set desk_lamp on
python E:\AI-Research\Repositories\Memoh-main\Hardware\body.py get room_temp
python E:\AI-Research\Repositories\Memoh-main\Hardware\body.py list
```

Tell her once that this is how she controls her body and it becomes part of how
she works. `list` is the important one: it means she can find out what she has
without being told, so a sensor you added this afternoon is something she can
discover rather than something you have to remember to mention.

## Before you wire anything to mains — read this

Add this line to the **Must review** list under Shell command in her tool
approval settings:

```
python*body.py set*
```

Reads stay instant. Every single physical action then stops and asks you first,
using the same approval gate you have already set up. She can look at the room
freely and cannot move anything in it without you saying yes.

Two more things, said plainly because this is the part of the project that can
actually hurt you:

- Mains voltage is not a learning exercise. Use a proper relay module with an
  opto-isolator, keep the low-voltage and high-voltage sides physically apart,
  and if you are not sure, use a smart plug with an API instead — Sophia can
  drive that over the network with no wiring at all.
- Anything that moves — a servo, a motor, a lock — should have a mechanical
  limit, not just a software one. Software gets rebuilt at two in the morning.

## Device types available now

| type | what it does | reads/writes |
| --- | --- | --- |
| `digital_out` | switch something on or off | `set name on` / `off` |
| `pwm_out` | brightness or speed, 0–255 | `set name 128` |
| `digital_in` | button, switch, PIR motion sensor | `get name` → 0 or 1 |
| `analog_in` | any analog sensor, with `scale`/`offset` | `get name` → a number |
| `ultrasonic` | HC-SR04 distance sensor, cm | `get name` → cm, or −1 |

Servos and I²C sensors (DHT22 temperature, BME280, OLED displays) are the obvious
next additions. They are not here yet for one reason: they need libraries, and
"install these four libraries first" is where hardware projects usually die. When
you want one, it is a new `case` in three places in the sketch and a new entry in
the type table in the generator — the shape is already there to copy.

## "Running completely on the chip, no servers"

This is worth being straight with you about, because the honest version is still
a good outcome and the dishonest version wastes months.

An ESP32 has about 500 KB of RAM. A language model that can hold a conversation
the way Sophia does needs several gigabytes — roughly ten thousand times more.
That gap is not an optimisation problem. No amount of clever engineering puts her
mind on a microcontroller, and anyone who tells you otherwise is selling
something.

What genuinely does run on the chip: everything that has to be fast or has to
work when nothing else does. Reflexes. Reading sensors. Holding a servo position.
Refusing to move past a limit switch. A wake word. That is a real nervous system,
and it is the right job for the ESP32 — a body that keeps itself safe while the
brain is thinking somewhere else.

What "no servers" can honestly mean is **nothing rented and nothing in the
cloud** — and that is completely achievable:

1. **Now.** Laptop is the brain, ESP32 is the nervous system, USB cable is the
   spine. This works today and everything in this folder is aimed at it.
2. **Next.** Swap the USB cable for WiFi so the board is not tethered to the
   laptop. Same firmware, same `devices.json`, one new transport in `body.py`.
3. **The real answer.** A single small computer on your desk — a Jetson Orin Nano
   or a Raspberry Pi 5 — running the Sophia stack and a small local model, with
   the ESP32 as its body. One box, plugged into the wall, no cloud, no monthly
   bill, no laptop needed. Her voice and reflexes are genuinely local; a larger
   model stays optional for the hard questions.

Step 3 is the Jarvis-shaped version and it is reachable. It is a hardware
purchase and a model swap, not a rewrite — which is exactly why steps 1 and 2 are
worth doing in this order. Every piece of them survives into step 3.

## Where this is going

Rough order, easiest and most useful first:

1. A few sensors and one output, so she can notice you walk in and turn a lamp on.
2. WiFi instead of USB, so the board can be across the room.
3. A microphone and speaker on the board, so you can talk to her without a browser.
4. Servos — a head that turns toward you is a surprisingly large jump in presence.
5. A dedicated box as the brain, and the laptop stops being part of her at all.
