/*
 * sophia_body - generic firmware for Sophia's body.
 *
 * The point of this sketch is that you never edit it.
 *
 * Every pin, every sensor and every output is described in ../../devices.json.
 * A generator turns that into devices.h, which is the only file that changes
 * when you wire something new up. This file is the part that stays the same
 * forever: it reads the table, sets the pins up, and answers questions about
 * them over the USB cable.
 *
 * No libraries, on purpose. It compiles as-is on an ESP32 and on an Arduino Uno
 * with nothing installed, because "install these four libraries first" is where
 * hardware projects usually die.
 *
 * The protocol is plain text, one command per line, so you can test the whole
 * board by hand in the Arduino IDE's Serial Monitor before Sophia ever touches
 * it. Set the monitor to 115200 baud and Newline, then type:
 *
 *   PING                 -> OK pong sophia-body 1
 *   LIST                 -> one OK line per device
 *   GET room_temp        -> OK room_temp=23.40
 *   SET desk_lamp 1      -> OK desk_lamp=1
 *   SET status_led 128   -> OK status_led=128
 *
 * If that works in the Serial Monitor, it will work from Sophia. If it does not,
 * the problem is the wiring or devices.json, and you have found that out without
 * anything else being involved.
 */

#include "devices.h"

// ---------------------------------------------------------------------------
// Device table plumbing
//
// devices.h defines DEVICE_COUNT and the `devices` array. Everything below is
// generic over that array and has no knowledge of what is actually plugged in.
// ---------------------------------------------------------------------------

// Last written value for each output, so GET on an output reports what it is
// currently set to rather than reading the pin back (reading an output pin is
// unreliable across boards).
static long lastWritten[DEVICE_COUNT > 0 ? DEVICE_COUNT : 1];

static int findDevice(const char *name) {
  for (int i = 0; i < DEVICE_COUNT; i++) {
    if (strcmp(devices[i].name, name) == 0) return i;
  }
  return -1;
}

static const char *typeName(uint8_t t) {
  switch (t) {
    case DEV_DIGITAL_OUT: return "digital_out";
    case DEV_DIGITAL_IN:  return "digital_in";
    case DEV_ANALOG_IN:   return "analog_in";
    case DEV_PWM_OUT:     return "pwm_out";
    case DEV_ULTRASONIC:  return "ultrasonic";
  }
  return "unknown";
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/*
 * Distance in centimetres from an HC-SR04 style sensor.
 *
 * Pure timing, no library. The 25ms timeout is deliberate: that is a little over
 * the sensor's 4m range, and without it a missing or unplugged sensor blocks the
 * whole board for a second on every read. Returns -1 for no echo, which is
 * honest — out of range and not connected genuinely are the same signal here.
 */
static float readUltrasonic(uint8_t trig, uint8_t echo) {
  digitalWrite(trig, LOW);
  delayMicroseconds(2);
  digitalWrite(trig, HIGH);
  delayMicroseconds(10);
  digitalWrite(trig, LOW);

  unsigned long us = pulseIn(echo, HIGH, 25000UL);
  if (us == 0) return -1.0f;
  // Speed of sound is ~0.0343 cm/us, halved for the round trip.
  return (float)us * 0.01715f;
}

static bool readDevice(int i, float *out) {
  const Device &d = devices[i];
  switch (d.type) {
    case DEV_DIGITAL_IN: {
      int raw = digitalRead(d.pin);
      if (d.invert) raw = !raw;
      *out = (float)raw;
      return true;
    }
    case DEV_ANALOG_IN: {
      long raw = analogRead(d.pin);
      *out = (float)raw * d.scale + d.offset;
      return true;
    }
    case DEV_ULTRASONIC: {
      *out = readUltrasonic(d.pin, d.pin2);
      return true;
    }
    case DEV_DIGITAL_OUT:
    case DEV_PWM_OUT:
      *out = (float)lastWritten[i];
      return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

static bool writeDevice(int i, long value) {
  const Device &d = devices[i];
  switch (d.type) {
    case DEV_DIGITAL_OUT: {
      long v = value != 0 ? 1 : 0;
      lastWritten[i] = v;
      digitalWrite(d.pin, (d.invert ? !v : v) ? HIGH : LOW);
      return true;
    }
    case DEV_PWM_OUT: {
      long v = value;
      if (v < 0) v = 0;
      if (v > 255) v = 255;
      lastWritten[i] = v;
      analogWrite(d.pin, (int)(d.invert ? 255 - v : v));
      return true;
    }
    default:
      // Inputs are not writable. Saying so is better than silently doing nothing.
      return false;
  }
}

// ---------------------------------------------------------------------------
// Command handling
// ---------------------------------------------------------------------------

static void cmdList() {
  for (int i = 0; i < DEVICE_COUNT; i++) {
    Serial.print(F("OK name="));
    Serial.print(devices[i].name);
    Serial.print(F(" type="));
    Serial.print(typeName(devices[i].type));
    Serial.print(F(" pin="));
    Serial.print(devices[i].pin);
    if (devices[i].type == DEV_ULTRASONIC) {
      Serial.print(F(" pin2="));
      Serial.print(devices[i].pin2);
    }
    Serial.print(F(" about="));
    Serial.println(devices[i].about);
  }
  Serial.print(F("OK count="));
  Serial.println(DEVICE_COUNT);
}

static void cmdGet(const char *name) {
  int i = findDevice(name);
  if (i < 0) {
    Serial.print(F("ERR unknown device "));
    Serial.println(name);
    return;
  }
  float value = 0;
  if (!readDevice(i, &value)) {
    Serial.print(F("ERR cannot read "));
    Serial.println(name);
    return;
  }
  Serial.print(F("OK "));
  Serial.print(name);
  Serial.print('=');
  Serial.println(value, 2);
}

static void cmdSet(const char *name, const char *valueText) {
  int i = findDevice(name);
  if (i < 0) {
    Serial.print(F("ERR unknown device "));
    Serial.println(name);
    return;
  }
  // Accept the words a person would actually use as well as numbers, because
  // "SET desk_lamp on" is what anyone types the first time.
  long value;
  if (strcasecmp(valueText, "on") == 0 || strcasecmp(valueText, "true") == 0) value = 1;
  else if (strcasecmp(valueText, "off") == 0 || strcasecmp(valueText, "false") == 0) value = 0;
  else value = atol(valueText);

  if (!writeDevice(i, value)) {
    Serial.print(F("ERR not writable "));
    Serial.println(name);
    return;
  }
  Serial.print(F("OK "));
  Serial.print(name);
  Serial.print('=');
  Serial.println(lastWritten[i]);
}

static void handleLine(char *line) {
  // Split into at most three whitespace-separated words in place.
  char *verb = strtok(line, " \t");
  if (!verb || !*verb) return;
  char *arg1 = strtok(NULL, " \t");
  char *arg2 = strtok(NULL, " \t");

  if (strcasecmp(verb, "PING") == 0) {
    Serial.println(F("OK pong sophia-body 1"));
  } else if (strcasecmp(verb, "LIST") == 0) {
    cmdList();
  } else if (strcasecmp(verb, "GET") == 0) {
    if (arg1) cmdGet(arg1);
    else Serial.println(F("ERR usage GET <name>"));
  } else if (strcasecmp(verb, "SET") == 0) {
    if (arg1 && arg2) cmdSet(arg1, arg2);
    else Serial.println(F("ERR usage SET <name> <value>"));
  } else {
    Serial.print(F("ERR unknown command "));
    Serial.println(verb);
  }
}

// ---------------------------------------------------------------------------

void setup() {
  Serial.begin(SOPHIA_BAUD);

  for (int i = 0; i < DEVICE_COUNT; i++) {
    const Device &d = devices[i];
    switch (d.type) {
      case DEV_DIGITAL_OUT:
      case DEV_PWM_OUT:
        pinMode(d.pin, OUTPUT);
        lastWritten[i] = 0;
        // Start every output off, including inverted ones. A relay board that
        // energises on boot is how you find out the hard way that active-low is
        // a real thing.
        writeDevice(i, 0);
        break;
      case DEV_DIGITAL_IN:
        // Pull-up rather than plain INPUT: it means a bare button wired to
        // ground works with no extra resistor, which is the common case.
        pinMode(d.pin, d.invert ? INPUT_PULLUP : INPUT);
        break;
      case DEV_ANALOG_IN:
        break;
      case DEV_ULTRASONIC:
        pinMode(d.pin, OUTPUT);
        pinMode(d.pin2, INPUT);
        break;
    }
  }

  Serial.println(F("OK ready sophia-body 1"));
}

void loop() {
  static char buf[96];
  static uint8_t len = 0;

  while (Serial.available()) {
    char c = (char)Serial.read();
    if (c == '\r') continue;
    if (c == '\n') {
      buf[len] = '\0';
      if (len > 0) handleLine(buf);
      len = 0;
      continue;
    }
    // Overlong lines are dropped rather than truncated and acted on, because a
    // half-read SET is worse than no SET.
    if (len < sizeof(buf) - 1) buf[len++] = c;
    else len = 0;
  }
}
