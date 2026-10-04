#include "ConfigStore.h"

#include <ArduinoJson.h>
#include <LittleFS.h>

namespace
{
constexpr char WIFI_CONFIG_FILE[] = "/wifi.json";
constexpr char DISPLAY_CONFIG_FILE[] = "/config.json";
constexpr char DEFAULT_TIMEZONE[] = "UTC";

constexpr uint32_t MIN_ROTATE_MS = 2000;
constexpr uint32_t MAX_ROTATE_MS = 60000;
constexpr uint32_t MAX_DIM_MS = 3600000;
}

namespace ConfigStore
{
void begin()
{
    LittleFS.begin();
}

bool loadWifiConfig(WifiConfig &config)
{
    File file = LittleFS.open(WIFI_CONFIG_FILE, "r");
    if (!file)
    {
        return false;
    }

    JsonDocument document;
    DeserializationError error = deserializeJson(document, file);
    file.close();
    if (error)
    {
        return false;
    }

    const char *ssid = document["ssid"] | "";
    const char *password = document["password"] | "";
    const char *timezone = document["timezone"] | DEFAULT_TIMEZONE;

    config.ssid = ssid;
    config.password = password;
    config.timezone = timezone;
    return !config.ssid.isEmpty();
}

bool saveWifiConfig(const WifiConfig &config)
{
    JsonDocument document;
    document["ssid"] = config.ssid;
    document["password"] = config.password;
    document["timezone"] = config.timezone.isEmpty() ? DEFAULT_TIMEZONE : config.timezone;

    File file = LittleFS.open(WIFI_CONFIG_FILE, "w");
    if (!file)
    {
        return false;
    }

    bool saved = serializeJson(document, file) > 0;
    file.close();
    return saved;
}

bool clearWifiConfig()
{
    return LittleFS.remove(WIFI_CONFIG_FILE);
}

void applyDefaults(DisplayConfig &config)
{
    strcpy(config.screens[0], "clock");
    config.screenCount = 1;
    config.rotateMs = 5000;
    config.brightness = 200;
    config.hasBrightness = false;
    config.dimAfterMs = 0;
    config.timezone = "";
    config.hasTimezone = false;
    config.showConnection = true;
    config.hasShowConnection = false;
}

bool loadDisplayConfig(DisplayConfig &config)
{
    File file = LittleFS.open(DISPLAY_CONFIG_FILE, "r");
    if (!file)
    {
        return false;
    }

    JsonDocument document;
    DeserializationError error = deserializeJson(document, file);
    file.close();
    if (error)
    {
        return false;
    }

    JsonArrayConst screens = document["screens"].as<JsonArrayConst>();
    config.screenCount = 0;
    for (JsonVariantConst item : screens)
    {
        if (config.screenCount >= MAX_SCREENS)
        {
            break;
        }
        const char *id = item.as<const char *>();
        if (id == nullptr || strlen(id) == 0 || strlen(id) >= SCREEN_ID_LEN)
        {
            continue;
        }
        strncpy(config.screens[config.screenCount], id, SCREEN_ID_LEN - 1);
        config.screens[config.screenCount][SCREEN_ID_LEN - 1] = '\0';
        config.screenCount++;
    }

    if (config.screenCount == 0)
    {
        applyDefaults(config);
        return false;
    }

    uint32_t rotateMs = document["rotateMs"] | config.rotateMs;
    if (rotateMs < MIN_ROTATE_MS)
    {
        rotateMs = MIN_ROTATE_MS;
    }
    if (rotateMs > MAX_ROTATE_MS)
    {
        rotateMs = MAX_ROTATE_MS;
    }
    config.rotateMs = rotateMs;

    uint32_t dimAfterMs = document["dimAfterMs"] | 0;
    config.dimAfterMs = dimAfterMs > MAX_DIM_MS ? MAX_DIM_MS : dimAfterMs;

    if (!document["brightness"].isNull())
    {
        uint32_t brightness = document["brightness"] | 200;
        config.brightness = brightness > 255 ? 255 : (uint8_t)brightness;
        config.hasBrightness = true;
    }

    if (!document["timezone"].isNull())
    {
        config.timezone = document["timezone"] | "";
        config.hasTimezone = !config.timezone.isEmpty();
    }

    if (!document["showConnection"].isNull())
    {
        config.showConnection = document["showConnection"] | true;
        config.hasShowConnection = true;
    }

    return true;
}

bool saveDisplayConfig(const DisplayConfig &config)
{
    JsonDocument document;
    JsonArray screens = document["screens"].to<JsonArray>();
    for (uint8_t i = 0; i < config.screenCount && i < MAX_SCREENS; ++i)
    {
        screens.add(config.screens[i]);
    }
    document["rotateMs"] = config.rotateMs;
    document["dimAfterMs"] = config.dimAfterMs;
    document["brightness"] = config.brightness;
    if (config.hasTimezone)
    {
        document["timezone"] = config.timezone;
    }
    document["showConnection"] = config.showConnection;

    File file = LittleFS.open(DISPLAY_CONFIG_FILE, "w");
    if (!file)
    {
        return false;
    }

    bool saved = serializeJson(document, file) > 0;
    file.close();
    return saved;
}

bool isValidTimezone(const String &timezone)
{
    if (timezone.isEmpty() || timezone.length() > 32)
    {
        return false;
    }

    bool hasLetter = false;
    for (size_t i = 0; i < timezone.length(); ++i)
    {
        char c = timezone.charAt(i);
        if (isalpha((unsigned char)c))
        {
            hasLetter = true;
        }
        else if (!isdigit((unsigned char)c) && c != '-' && c != '+' && c != '_' &&
                 c != '/' && c != ':' && c != '.')
        {
            return false;
        }
    }
    return hasLetter;
}

String effectiveTimezone(){
    DisplayConfig displayConfig;
    applyDefaults(displayConfig);
    if (loadDisplayConfig(displayConfig) && displayConfig.hasTimezone &&
        isValidTimezone(displayConfig.timezone))
    {
        return displayConfig.timezone;
    }

    WifiConfig wifiConfig;
    wifiConfig.timezone = DEFAULT_TIMEZONE;
    if (loadWifiConfig(wifiConfig) && isValidTimezone(wifiConfig.timezone))
    {
        return wifiConfig.timezone;
    }

    return DEFAULT_TIMEZONE;
}
}
