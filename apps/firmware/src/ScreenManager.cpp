#include "ScreenManager.h"

#include <time.h>

#include "ClockService.h"
#include "MonitorClient.h"
#include "NetworkManager.h"
#include "OledDisplay.h"

namespace
{
constexpr uint32_t RENDER_INTERVAL_MS = 1000;
constexpr uint8_t DIM_BRIGHTNESS = 8;
constexpr uint8_t MAX_SENSOR_LINES = OledDisplay::SENSOR_MAX_LINES;
constexpr size_t SENSOR_LINE_LEN = OledDisplay::SENSOR_LINE_LEN;

ConfigStore::DisplayConfig config;
uint8_t screenIndex = 0;
uint32_t lastRotateAt = 0;
uint32_t lastRenderAt = 0;
uint32_t lastFreshAt = 0;
bool metricsDirty = false;
bool firstRender = true;
bool dimmed = false;
ScreenManager::Mode renderedMode = ScreenManager::SETUP;

void applyBrightness()
{
    OledDisplay::setBrightness(dimmed ? DIM_BRIGHTNESS : config.brightness);
}

void addSensorLine(char lines[][SENSOR_LINE_LEN], uint8_t &count, const char *text)
{
    if (count >= MAX_SENSOR_LINES)
    {
        return;
    }
    strncpy(lines[count], text, SENSOR_LINE_LEN - 1);
    lines[count][SENSOR_LINE_LEN - 1] = '\0';
    count++;
}

uint8_t buildSensorLines(const resmon24::protocol::ResourceUpdateMessageData *data,
                         char lines[][SENSOR_LINE_LEN])
{
    uint8_t count = 0;
    char buf[SENSOR_LINE_LEN];

    if (data == nullptr)
    {
        return 0;
    }

    bool hasCpuTemp = data->hasCpu && data->cpu.hasTempC;
    bool hasGpuTemp = data->hasGpu && data->gpu.hasTempC;
    if (hasCpuTemp && hasGpuTemp)
    {
        snprintf(buf, sizeof(buf), "CPU %.1fC GPU %.1fC", (float)data->cpu.tempC,
                 (float)data->gpu.tempC);
        addSensorLine(lines, count, buf);
    }
    else if (hasCpuTemp)
    {
        snprintf(buf, sizeof(buf), "CPU %.1fC", (float)data->cpu.tempC);
        addSensorLine(lines, count, buf);
    }
    else if (hasGpuTemp)
    {
        snprintf(buf, sizeof(buf), "GPU %.1fC", (float)data->gpu.tempC);
        addSensorLine(lines, count, buf);
    }

    if (data->hasTemperature && data->temperature.hasSystem &&
        data->temperature.system > -50.0 && data->temperature.system < 150.0)
    {
        snprintf(buf, sizeof(buf), "SYS %.1fC", (float)data->temperature.system);
        addSensorLine(lines, count, buf);
    }

    if (data->hasTemperature && data->temperature.hasExtras)
    {
        for (const auto &extra : data->temperature.extras)
        {
            if (count >= MAX_SENSOR_LINES)
            {
                break;
            }
            snprintf(buf, sizeof(buf), "%.8s %.1fC", extra.label.c_str(),
                     (float)extra.tempC);
            addSensorLine(lines, count, buf);
        }
    }

    if (data->hasFans && data->fans.hasEntries)
    {
        for (const auto &fan : data->fans.entries)
        {
            if (count >= MAX_SENSOR_LINES)
            {
                break;
            }
            snprintf(buf, sizeof(buf), "%.9s %drpm", fan.label.c_str(),
                     (int)fan.rpm);
            addSensorLine(lines, count, buf);
        }
    }

    return count;
}

struct ParsedScreen
{
    bool cpu;
    bool mem;
    bool gpu;
    bool net;
    bool sens;
    bool clock;
    bool wifi;
    uint8_t metrics;
};

bool tokenMatches(const char *token, const char *full, const char *alias)
{
    return strcmp(token, full) == 0 || strcmp(token, alias) == 0;
}

bool parseScreenId(const char *id, ParsedScreen &out)
{
    out = ParsedScreen{false, false, false, false, false, false, false, 0};

    char buffer[ConfigStore::SCREEN_ID_LEN];
    strncpy(buffer, id, sizeof(buffer) - 1);
    buffer[sizeof(buffer) - 1] = '\0';

    bool any = false;
    char *save = nullptr;
    for (char *token = strtok_r(buffer, "+", &save); token != nullptr;
         token = strtok_r(nullptr, "+", &save))
    {
        if (tokenMatches(token, "cpu", "cpu"))
            out.cpu = true;
        else if (tokenMatches(token, "memory", "mem"))
            out.mem = true;
        else if (tokenMatches(token, "gpu", "gpu"))
            out.gpu = true;
        else if (tokenMatches(token, "network", "net"))
            out.net = true;
        else if (tokenMatches(token, "sensors", "sens"))
            out.sens = true;
        else if (tokenMatches(token, "clock", "clk"))
            out.clock = true;
        else if (strcmp(token, "wifi") == 0)
            out.wifi = true;
        else
            continue;
        any = true;
    }

    if (any)
    {
        out.metrics = (out.cpu ? 1 : 0) + (out.mem ? 1 : 0) + (out.gpu ? 1 : 0) +
                      (out.net ? 1 : 0) + (out.sens ? 1 : 0) + (out.clock ? 1 : 0) +
                      (out.wifi ? 1 : 0);
    }
    return any;
}

bool addCompositeRow(OledDisplay::CompositeRow *rows, uint8_t &count, const char *label,
                     const char *value, float percent)
{
    if (count >= OledDisplay::MAX_COMPOSITE_ROWS)
    {
        return false;
    }
    OledDisplay::CompositeRow &row = rows[count];
    count++;
    strncpy(row.label, label, sizeof(row.label) - 1);
    row.label[sizeof(row.label) - 1] = '\0';
    strncpy(row.value, value, sizeof(row.value) - 1);
    row.value[sizeof(row.value) - 1] = '\0';
    row.percent = percent;
    return true;
}

void formatRateShort(char *buffer, size_t length, double bytesPerSec)
{
    const char *unit = "B";
    double value = bytesPerSec;
    if (value >= 1073741824.0)
    {
        value /= 1073741824.0;
        unit = "G";
    }
    else if (value >= 1048576.0)
    {
        value /= 1048576.0;
        unit = "M";
    }
    else if (value >= 1024.0)
    {
        value /= 1024.0;
        unit = "K";
    }

    char number[8];
    if (value >= 100.0)
    {
        snprintf(number, sizeof(number), "%d", (int)value);
    }
    else
    {
        snprintf(number, sizeof(number), "%.1f", value);
    }
    snprintf(buffer, length, "%s%s", number, unit);
}

void renderComposite(const ParsedScreen &spec,
                     const resmon24::protocol::ResourceUpdateMessageData *data, bool stale)
{
    OledDisplay::CompositeRow rows[OledDisplay::MAX_COMPOSITE_ROWS];
    uint8_t count = 0;
    char value[24];

    tm localTime = {};
    bool hasClock = spec.clock && ClockService::getLocalTime(localTime);

    if (spec.cpu)
    {
        bool present = data != nullptr && data->hasCpu && data->cpu.hasUsage;
        if (present)
        {
            snprintf(value, sizeof(value), "%.1f%%", (float)data->cpu.usage);
            addCompositeRow(rows, count, "CPU", value, (float)data->cpu.usage);
        }
        else
        {
            addCompositeRow(rows, count, "CPU", "--%", -1.0f);
        }
    }

    if (spec.mem)
    {
        if (data != nullptr && data->hasMemory)
        {
            float usedGiB = (float)data->memory.used / 1073741824.0f;
            float totalGiB = (float)data->memory.total / 1073741824.0f;
            snprintf(value, sizeof(value), "%.1f/%.1fG", usedGiB, totalGiB);
            float percent = data->memory.hasPercent ? (float)data->memory.percent : -1.0f;
            addCompositeRow(rows, count, "MEM", value, percent);
        }
        else
        {
            addCompositeRow(rows, count, "MEM", "--%", -1.0f);
        }
    }

    if (spec.gpu)
    {
        bool present = data != nullptr && data->hasGpu;
        bool hasUsage = present && data->gpu.hasUsage;
        bool hasTemp = present && data->gpu.hasTempC;
        if (hasUsage && hasTemp)
        {
            snprintf(value, sizeof(value), "%.0f%% %.0fC", (float)data->gpu.usage,
                     (float)data->gpu.tempC);
        }
        else if (hasUsage)
        {
            snprintf(value, sizeof(value), "%.0f%%", (float)data->gpu.usage);
        }
        else
        {
            strcpy(value, "--%");
        }
        addCompositeRow(rows, count, "GPU", value, hasUsage ? (float)data->gpu.usage : -1.0f);
    }

    if (spec.net)
    {
        bool present = data != nullptr && data->hasNetwork && data->network.hasRxBytesPerSec &&
                       data->network.hasTxBytesPerSec;
        if (present)
        {
            char rx[10];
            char tx[10];
            formatRateShort(rx, sizeof(rx), (double)data->network.rxBytesPerSec);
            formatRateShort(tx, sizeof(tx), (double)data->network.txBytesPerSec);
            snprintf(value, sizeof(value), "R%s T%s", rx, tx);
        }
        else
        {
            strcpy(value, "--");
        }
        addCompositeRow(rows, count, "NET", value, -1.0f);
    }

    if (spec.wifi)
    {
        String ssid = NetworkManager::ssid();
        if (ssid.length() > 15)
        {
            ssid = ssid.substring(0, 15);
        }
        addCompositeRow(rows, count, "SSID", ssid.c_str(), -1.0f);
        addCompositeRow(rows, count, "IP", NetworkManager::ipAddress().c_str(), -1.0f);
    }

    if (spec.sens)
    {
        bool hasCpuTemp = data != nullptr && data->hasCpu && data->cpu.hasTempC;
        bool hasGpuTemp = data != nullptr && data->hasGpu && data->gpu.hasTempC;
        bool hasSystem = data != nullptr && data->hasTemperature &&
                         data->temperature.hasSystem && data->temperature.system > -50.0 &&
                         data->temperature.system < 150.0;

        const char *primary = nullptr;
        double primaryValue = 0.0;
        if (hasCpuTemp)
        {
            primary = "cpu";
            primaryValue = data->cpu.tempC;
        }
        else if (hasGpuTemp)
        {
            primary = "gpu";
            primaryValue = data->gpu.tempC;
        }
        else if (hasSystem)
        {
            primary = "sys";
            primaryValue = data->temperature.system;
        }

        if (primary != nullptr)
        {
            snprintf(value, sizeof(value), "%.1fC", primaryValue);
            addCompositeRow(rows, count, "TEMP", value, -1.0f);
        }
        if (hasSystem && primary != nullptr && strcmp(primary, "sys") != 0)
        {
            snprintf(value, sizeof(value), "%.1fC", data->temperature.system);
            addCompositeRow(rows, count, "SYS", value, -1.0f);
        }
        if (data != nullptr && data->hasFans && data->fans.hasEntries &&
            !data->fans.entries.empty())
        {
            snprintf(value, sizeof(value), "%drpm", (int)data->fans.entries[0].rpm);
            addCompositeRow(rows, count, "FAN", value, -1.0f);
        }
    }

    OledDisplay::showCompositeScreen(hasClock, localTime, rows, count, stale);
}

void renderGpu(const resmon24::protocol::ResourceUpdateMessageData *data, bool stale)
{
    bool present = data != nullptr && data->hasGpu;
    bool hasUsage = present && data->gpu.hasUsage;
    float usage = hasUsage ? (float)data->gpu.usage : 0.0f;
    bool hasVram = present && data->gpu.hasVramUsed && data->gpu.hasVramTotal;
    float usedGiB = hasVram ? (float)data->gpu.vramUsed / 1073741824.0f : 0.0f;
    float totalGiB = hasVram ? (float)data->gpu.vramTotal / 1073741824.0f : 0.0f;
    bool hasTemp = present && data->gpu.hasTempC;
    float tempC = hasTemp ? (float)data->gpu.tempC : 0.0f;
    OledDisplay::showGpuScreen(usage, hasUsage, usedGiB, totalGiB, hasVram, tempC,
                               hasTemp, stale);
}

void renderNetwork(const resmon24::protocol::ResourceUpdateMessageData *data, bool stale)
{
    bool present = data != nullptr && data->hasNetwork;
    bool hasRates = present && data->network.hasRxBytesPerSec &&
                    data->network.hasTxBytesPerSec;
    float rx = hasRates ? (float)data->network.rxBytesPerSec : 0.0f;
    float tx = hasRates ? (float)data->network.txBytesPerSec : 0.0f;
    OledDisplay::showNetworkScreen(rx, tx, hasRates, stale);
}

void renderSensors(const resmon24::protocol::ResourceUpdateMessageData *data, bool stale)
{
    char lines[MAX_SENSOR_LINES][SENSOR_LINE_LEN];
    uint8_t count = buildSensorLines(data, lines);
    OledDisplay::showSensorsScreen(lines, count, stale);
}

void renderWifi(bool stale)
{
    OledDisplay::showWifiScreen(NetworkManager::ssid(), NetworkManager::ipAddress(), stale);
}
}

namespace ScreenManager
{
void begin(const ConfigStore::DisplayConfig &configured)
{
    config = configured;
    if (config.screenCount == 0)
    {
        ConfigStore::applyDefaults(config);
    }
    lastFreshAt = millis();
    dimmed = false;
    applyBrightness();
}

void applyConfig(const ConfigStore::DisplayConfig &configured)
{
    config = configured;
    if (config.screenCount == 0)
    {
        ConfigStore::applyDefaults(config);
    }
    screenIndex = 0;
    lastRotateAt = millis();
    lastFreshAt = millis();
    dimmed = false;
    firstRender = true;
    applyBrightness();
}

void onMetrics()
{
    metricsDirty = true;
    lastFreshAt = millis();
}

Mode computeMode()
{
    if (NetworkManager::portalActive())
    {
        return SETUP;
    }
    if (!NetworkManager::connected())
    {
        return CONNECTING;
    }

    if (MonitorClient::sessionActive())
    {
        uint32_t last = MonitorClient::lastUpdateAt();
        uint32_t staleTimeout = 3 * MonitorClient::intervalMs();
        if (last != 0 && millis() - last <= staleTimeout)
        {
            return RESOURCE;
        }
    }

    return CLOCK;
}

void renderClock()
{
    tm localTime;
    if (ClockService::getLocalTime(localTime))
    {
        OledDisplay::showClock(localTime);
    }
    else
    {
        OledDisplay::showMessage("Syncing time", ClockService::usingBackupServer()
                                                    ? "Trying backup NTP"
                                                    : "Please wait");
    }
}

void renderResource()
{
    if (config.screenCount == 0)
    {
        OledDisplay::showMessage("Resmon24", "No screens");
        return;
    }

    const char *id = config.screens[screenIndex];

    const resmon24::protocol::ResourceUpdateMessageData *data = MonitorClient::latestData();
    uint32_t last = MonitorClient::lastUpdateAt();
    bool stale = data != nullptr && (millis() - last > MonitorClient::intervalMs());

    ParsedScreen spec;
    if (!parseScreenId(id, spec))
    {
        OledDisplay::showPlaceholderScreen(id, stale);
        return;
    }

    if (spec.metrics > 1)
    {
        renderComposite(spec, data, stale);
        return;
    }

    if (spec.cpu)
    {
        bool hasUsage = data != nullptr && data->hasCpu && data->cpu.hasUsage;
        float usage = hasUsage ? (float)data->cpu.usage : 0.0f;
        uint8_t coreCount = 0;
        const double *coreLoads = nullptr;
        if (data != nullptr && data->hasCpu && !data->cpu.cores.empty())
        {
            coreCount = data->cpu.cores.size() > 255 ? 255 : (uint8_t)data->cpu.cores.size();
            coreLoads = data->cpu.cores.data();
        }
        OledDisplay::showCpuScreen(usage, hasUsage, coreCount, coreLoads, stale);
    }
    else if (spec.mem)
    {
        bool hasMemory = data != nullptr && data->hasMemory;
        float percent = hasMemory && data->memory.hasPercent ? (float)data->memory.percent : 0.0f;
        float usedGiB = hasMemory ? (float)data->memory.used / 1073741824.0f : 0.0f;
        float totalGiB = hasMemory ? (float)data->memory.total / 1073741824.0f : 0.0f;
        OledDisplay::showMemoryScreen(percent, hasMemory, usedGiB, totalGiB, stale);
    }
    else if (spec.gpu)
    {
        renderGpu(data, stale);
    }
    else if (spec.net)
    {
        renderNetwork(data, stale);
    }
    else if (spec.sens)
    {
        renderSensors(data, stale);
    }
    else if (spec.clock)
    {
        renderClock();
    }
    else if (spec.wifi)
    {
        renderWifi(stale);
    }
}

void loop()
{
    Mode next = computeMode();
    uint32_t now = millis();

    bool wantDim = false;
    if (config.dimAfterMs > 0 && lastFreshAt != 0 && now - lastFreshAt >= config.dimAfterMs &&
        (next == RESOURCE || next == CLOCK))
    {
        wantDim = true;
    }
    if (wantDim != dimmed)
    {
        dimmed = wantDim;
        applyBrightness();
    }

    bool changed = next != renderedMode;

    if (next == RESOURCE && config.screenCount > 1)
    {
        if (now - lastRotateAt >= config.rotateMs)
        {
            screenIndex = (screenIndex + 1) % config.screenCount;
            lastRotateAt = now;
            changed = true;
        }
    }

    bool due = now - lastRenderAt >= RENDER_INTERVAL_MS;
    if (firstRender || changed || metricsDirty || due)
    {
        firstRender = false;
        renderedMode = next;
        lastRenderAt = now;
        metricsDirty = false;

        switch (next)
        {
        case SETUP:
            OledDisplay::showSetupPortal(NetworkManager::apSsid(), NetworkManager::apIp());
            break;
        case CONNECTING:
            OledDisplay::showMessage("Connecting to WiFi", "Please wait");
            break;
        case CLOCK:
            renderClock();
            break;
        case RESOURCE:
            renderResource();
            break;
        }
    }
}

Mode currentMode()
{
    return computeMode();
}
}
