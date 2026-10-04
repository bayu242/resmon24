#pragma once

#include <Arduino.h>
#include <resmon24_protocol.h>

#include "ConfigStore.h"

namespace ScreenManager
{
enum Mode
{
    SETUP,
    CONNECTING,
    CLOCK,
    RESOURCE
};

void begin(const ConfigStore::DisplayConfig &config);
void applyConfig(const ConfigStore::DisplayConfig &config);
void loop();
void onMetrics();
Mode currentMode();
}
