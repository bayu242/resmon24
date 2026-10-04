#pragma once

#include <Arduino.h>

namespace ConfigStore
{
constexpr uint8_t MAX_SCREENS = 5;
constexpr uint8_t SCREEN_ID_LEN = 40;

struct WifiConfig
{
    String ssid;
    String password;
    String timezone;
};

struct DisplayConfig
{
    char screens[MAX_SCREENS][SCREEN_ID_LEN];
    uint8_t screenCount;
    uint32_t rotateMs;
    uint8_t brightness;
    bool hasBrightness;
    uint32_t dimAfterMs;
    String timezone;
    bool hasTimezone;
    bool showConnection;
    bool hasShowConnection;
};

void begin();

bool loadWifiConfig(WifiConfig &config);
bool saveWifiConfig(const WifiConfig &config);
bool clearWifiConfig();

void applyDefaults(DisplayConfig &config);
bool loadDisplayConfig(DisplayConfig &config);
bool saveDisplayConfig(const DisplayConfig &config);

bool isValidTimezone(const String &timezone);
String effectiveTimezone();
}
