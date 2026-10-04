#include "ClockService.h"

#include <ESP8266WiFi.h>

namespace
{
constexpr time_t VALID_TIME_EPOCH = 1700000000;
constexpr uint32_t NTP_FALLBACK_DELAY_MS = 30000;

const char *NTP_SERVERS[] = {
    "0.id.pool.ntp.org",
    "1.id.pool.ntp.org",
    "2.id.pool.ntp.org",
    "3.id.pool.ntp.org",
};

String timezoneString = "UTC";
uint32_t ntpStartedAt = 0;
bool timeConfigured = false;
bool fallbackConfigured = false;
}

namespace ClockService
{
void begin(const String &value)
{
    if (!value.isEmpty())
    {
        timezoneString = value;
    }
}

bool setTimezone(const String &value)
{
    if (value.isEmpty() || value == timezoneString)
    {
        return false;
    }

    timezoneString = value;
    timeConfigured = false;
    fallbackConfigured = false;
    return true;
}

void loop()
{
    if (!timeConfigured)
    {
        Serial.print("WiFi connected, IP: ");
        Serial.println(WiFi.localIP());
        Serial.print("NTP timezone: ");
        Serial.println(timezoneString);
        configTime(timezoneString.c_str(), NTP_SERVERS[0], NTP_SERVERS[1], NTP_SERVERS[2]);
        ntpStartedAt = millis();
        timeConfigured = true;
    }

    if (time(nullptr) < VALID_TIME_EPOCH && !fallbackConfigured &&
        millis() - ntpStartedAt >= NTP_FALLBACK_DELAY_MS)
    {
        configTime(timezoneString.c_str(), NTP_SERVERS[3]);
        fallbackConfigured = true;
        Serial.println("Trying the fourth NTP server");
    }
}

bool getLocalTime(tm &localTime)
{
    time_t now = time(nullptr);
    if (now < VALID_TIME_EPOCH)
    {
        return false;
    }
    localtime_r(&now, &localTime);
    return true;
}

bool usingBackupServer()
{
    return fallbackConfigured;
}
}
