#pragma once

#include <Arduino.h>
#include <time.h>

namespace OledDisplay
{
constexpr uint8_t SENSOR_LINE_LEN = 22;
constexpr uint8_t SENSOR_MAX_LINES = 5;
constexpr uint8_t MAX_COMPOSITE_ROWS = 6;

struct CompositeRow
{
    char label[8];
    char value[20];
    float percent;
};

bool begin();
void setBrightness(uint8_t value);
void showMessage(const char *title, const char *detail = nullptr);
void showClock(const tm &localTime);
void showSetupPortal(const char *apSsid, const String &ipAddress);
void showWifiScreen(const String &ssid, const String &ipAddress, bool stale);
void showCpuScreen(float usagePercent, bool hasUsage, uint8_t coreCount,
                   const double *coreLoads, bool stale);
void showMemoryScreen(float percent, bool hasMemory, float usedGiB, float totalGiB,
                      bool stale);
void showGpuScreen(float usagePercent, bool hasUsage, float vramUsedGiB,
                   float vramTotalGiB, bool hasVram, float tempC, bool hasTemp,
                   bool stale);
void showNetworkScreen(float rxBytesPerSec, float txBytesPerSec, bool hasRates,
                       bool stale);
void showSensorsScreen(const char lines[][SENSOR_LINE_LEN], uint8_t count, bool stale);
void showCompositeScreen(bool hasClock, const tm &clockTime, const CompositeRow *rows,
                         uint8_t count, bool stale);
void showPlaceholderScreen(const char *screenId, bool stale);
}
