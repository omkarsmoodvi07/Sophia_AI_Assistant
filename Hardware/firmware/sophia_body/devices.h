/*
 * devices.h - GENERATED FILE, DO NOT EDIT.
 *
 * Produced from Hardware/devices.json by tools/generate_firmware_config.py.
 * Anything you type in here is lost the next time that runs. Edit devices.json.
 */

#ifndef SOPHIA_DEVICES_H
#define SOPHIA_DEVICES_H

#include <Arduino.h>

#define SOPHIA_BAUD 115200

#define DEV_DIGITAL_OUT 0
#define DEV_DIGITAL_IN  1
#define DEV_ANALOG_IN   2
#define DEV_PWM_OUT     3
#define DEV_ULTRASONIC  4

struct Device {
  const char *name;
  uint8_t type;
  uint8_t pin;
  uint8_t pin2;
  bool invert;
  float scale;
  float offset;
  const char *about;
};

#define DEVICE_COUNT 0

static const Device devices[1] = {
  { "", 0, 0, 0, false, 1.0f, 0.0f, "" }, // placeholder, DEVICE_COUNT is 0
};

#endif
