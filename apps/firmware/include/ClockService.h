#pragma once

#include <Arduino.h>
#include <time.h>

namespace ClockService
{
void begin(const String &timezone);
bool setTimezone(const String &timezone);
void loop();
bool getLocalTime(tm &localTime);
bool usingBackupServer();
}
