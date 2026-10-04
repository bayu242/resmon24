#include <Arduino.h>

#include "ClockService.h"
#include "ConfigStore.h"
#include "MonitorClient.h"
#include "NetworkManager.h"
#include "OledDisplay.h"
#include "ScreenManager.h"

void setup()
{
    Serial.begin(115200);
    delay(100);
    Serial.println();
    Serial.println("resmon24 firmware");

    ConfigStore::begin();

    if (!OledDisplay::begin())
    {
        Serial.println("SSD1306 initialization failed");
    }

    ConfigStore::DisplayConfig displayConfig;
    ConfigStore::applyDefaults(displayConfig);
    ConfigStore::loadDisplayConfig(displayConfig);

    NetworkManager::begin();

    String timezone = ConfigStore::effectiveTimezone();
    ClockService::begin(timezone);
    MonitorClient::begin(timezone);

    ScreenManager::begin(displayConfig);

    Serial.print("Timezone: ");
    Serial.println(timezone);
}

void loop()
{
    NetworkManager::loop();

    if (NetworkManager::connected())
    {
        ClockService::loop();
        MonitorClient::loop();
    }

    ScreenManager::loop();
    delay(10);
}
