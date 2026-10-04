#include "OledDisplay.h"

#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>

namespace
{
constexpr int SCREEN_WIDTH = 128;
constexpr int SCREEN_HEIGHT = 64;
constexpr int OLED_RESET = -1;
constexpr uint8_t OLED_ADDRESS = 0x3C;
constexpr uint8_t MAX_CORES = 8;

Adafruit_SSD1306 display(SCREEN_WIDTH, SCREEN_HEIGHT, &Wire, OLED_RESET);

void formatFloat1(char *buffer, size_t length, float value)
{
    int whole = (int)value;
    int fraction = (int)((value - (float)whole) * 10.0f + 0.5f);
    if (fraction < 0)
    {
        fraction = 0;
    }
    if (fraction > 9)
    {
        fraction = 0;
        whole++;
    }
    snprintf(buffer, length, "%d.%d", whole, fraction);
}

void drawBar(int16_t x, int16_t y, int16_t width, int16_t height, float percent)
{
    int16_t fill = (int16_t)((percent / 100.0f) * (float)width);
    if (fill < 0)
    {
        fill = 0;
    }
    if (fill > width)
    {
        fill = width;
    }

    display.drawRect(x, y, width, height, SSD1306_WHITE);
    if (fill > 1)
    {
        display.fillRect(x + 1, y + 1, fill - 1, height - 2, SSD1306_WHITE);
    }
}

void drawStaleMarker(int16_t x, int16_t y)
{
    display.drawCircle(x, y, 2, SSD1306_WHITE);
    display.drawCircle(x, y, 1, SSD1306_WHITE);
}

void formatRate(char *buffer, size_t length, double bytesPerSec)
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

    char number[12];
    if (value >= 100.0)
    {
        snprintf(number, sizeof(number), "%d", (int)value);
    }
    else
    {
        formatFloat1(number, sizeof(number), (float)value);
    }
    snprintf(buffer, length, "%s%s/s", number, unit);
}
}

namespace OledDisplay
{
bool begin()
{
    return display.begin(SSD1306_SWITCHCAPVCC, OLED_ADDRESS);
}

void setBrightness(uint8_t value)
{
    display.ssd1306_command(SSD1306_SETCONTRAST);
    display.ssd1306_command(value);
}

void showMessage(const char *title, const char *detail)
{
    display.clearDisplay();
    display.setTextSize(1);
    display.setTextColor(SSD1306_WHITE);
    display.setCursor(0, 16);
    display.println(title);
    if (detail != nullptr)
    {
        display.setCursor(0, 32);
        display.println(detail);
    }
    display.display();
}

void showClock(const tm &localTime)
{
    char clockText[9];
    char dateText[11];
    strftime(clockText, sizeof(clockText), "%H:%M:%S", &localTime);
    strftime(dateText, sizeof(dateText), "%d-%m-%Y", &localTime);

    display.clearDisplay();
    display.setTextColor(SSD1306_WHITE);
    display.setTextSize(2);
    display.setCursor(16, 18);
    display.println(clockText);
    display.setTextSize(1);
    display.setCursor(34, 46);
    display.println(dateText);
    display.display();
}

void showSetupPortal(const char *apSsid, const String &ipAddress)
{
    display.clearDisplay();
    display.setTextSize(1);
    display.setTextColor(SSD1306_WHITE);
    display.setCursor(0, 0);
    display.println("WiFi setup");
    display.setCursor(0, 14);
    display.print("AP: ");
    display.println(apSsid);
    display.setCursor(0, 28);
    display.print("IP: ");
    display.println(ipAddress);
    display.setCursor(0, 44);
    display.println("Connect, open IP");
    display.display();
}

void showWifiScreen(const String &ssid, const String &ipAddress, bool stale)
{
    String displaySsid = ssid;
    if (displaySsid.length() > 15)
    {
        displaySsid = displaySsid.substring(0, 15);
    }

    display.clearDisplay();
    display.setTextColor(SSD1306_WHITE);
    display.setTextSize(1);
    display.setCursor(0, 0);
    display.println("WIFI");
    if (stale)
    {
        drawStaleMarker(122, 5);
    }

    display.setCursor(0, 20);
    display.print("SSID: ");
    display.println(displaySsid);
    display.setCursor(0, 36);
    display.print("IP: ");
    display.println(ipAddress);
    display.display();
}

void showCpuScreen(float usagePercent, bool hasUsage, uint8_t coreCount,
                   const double *coreLoads, bool stale)
{
    char text[16];

    display.clearDisplay();
    display.setTextColor(SSD1306_WHITE);

    display.setTextSize(1);
    display.setCursor(0, 0);
    display.println("CPU");
    if (stale)
    {
        drawStaleMarker(122, 5);
    }

    display.setTextSize(2);
    if (hasUsage)
    {
        formatFloat1(text, sizeof(text), usagePercent);
        strcat(text, "%");
    }
    else
    {
        strcpy(text, "--%");
    }
    display.setCursor(0, 12);
    display.println(text);

    drawBar(6, 34, 116, 7, hasUsage ? usagePercent : 0.0f);

    if (coreCount > 0 && coreLoads != nullptr)
    {
        for (uint8_t i = 0; i < coreCount && i < MAX_CORES; ++i)
        {
            int16_t x = 6 + (i % 4) * 30;
            int16_t y = 46 + (i / 4) * 8;
            drawBar(x, y, 26, 6, (float)coreLoads[i]);
        }
    }
    else
    {
        display.setTextSize(1);
        display.setCursor(6, 48);
        display.println(hasUsage ? "per-core: n/a" : "waiting for data");
    }

    display.display();
}

void showMemoryScreen(float percent, bool hasMemory, float usedGiB, float totalGiB,
                      bool stale)
{
    char text[24];

    display.clearDisplay();
    display.setTextColor(SSD1306_WHITE);

    display.setTextSize(1);
    display.setCursor(0, 0);
    display.println("MEM");
    if (stale)
    {
        drawStaleMarker(122, 5);
    }

    display.setTextSize(2);
    if (hasMemory)
    {
        formatFloat1(text, sizeof(text), percent);
        strcat(text, "%");
    }
    else
    {
        strcpy(text, "--%");
    }
    display.setCursor(0, 12);
    display.println(text);

    drawBar(6, 34, 116, 7, hasMemory ? percent : 0.0f);

    display.setTextSize(1);
    display.setCursor(6, 46);
    if (hasMemory)
    {
        formatFloat1(text, sizeof(text), usedGiB);
        strcat(text, "/");
        char tail[10];
        formatFloat1(tail, sizeof(tail), totalGiB);
        strcat(text, tail);
        strcat(text, " GiB");
        display.println(text);
    }
    else
    {
        display.println("waiting for data");
    }

    display.display();
}

void showGpuScreen(float usagePercent, bool hasUsage, float vramUsedGiB,
                   float vramTotalGiB, bool hasVram, float tempC, bool hasTemp,
                   bool stale)
{
    char text[40];
    char used[12];
    char total[12];

    display.clearDisplay();
    display.setTextColor(SSD1306_WHITE);

    display.setTextSize(1);
    display.setCursor(0, 0);
    display.println("GPU");
    if (stale)
    {
        drawStaleMarker(122, 5);
    }

    display.setTextSize(2);
    if (hasUsage)
    {
        formatFloat1(text, sizeof(text), usagePercent);
        strcat(text, "%");
    }
    else
    {
        strcpy(text, "--%");
    }
    display.setCursor(0, 12);
    display.println(text);

    drawBar(6, 34, 116, 7, hasUsage ? usagePercent : 0.0f);

    display.setTextSize(1);
    display.setCursor(6, 46);
    if (hasVram)
    {
        formatFloat1(used, sizeof(used), vramUsedGiB);
        formatFloat1(total, sizeof(total), vramTotalGiB);
        snprintf(text, sizeof(text), "VRAM %s/%s GiB", used, total);
        display.println(text);
    }
    else
    {
        display.println("VRAM n/a");
    }

    display.setCursor(6, 56);
    if (hasTemp)
    {
        snprintf(text, sizeof(text), "TEMP %.1fC", tempC);
        display.println(text);
    }
    else
    {
        display.println("TEMP n/a");
    }

    display.display();
}

void showNetworkScreen(float rxBytesPerSec, float txBytesPerSec, bool hasRates,
                       bool stale)
{
    char text[24];
    char rx[16];
    char tx[16];

    display.clearDisplay();
    display.setTextColor(SSD1306_WHITE);

    display.setTextSize(1);
    display.setCursor(0, 0);
    display.println("NET");
    if (stale)
    {
        drawStaleMarker(122, 5);
    }

    display.setTextSize(2);
    if (hasRates)
    {
        formatRate(rx, sizeof(rx), rxBytesPerSec);
        formatRate(tx, sizeof(tx), txBytesPerSec);
        snprintf(text, sizeof(text), "RX %s", rx);
        display.setCursor(0, 16);
        display.println(text);
        snprintf(text, sizeof(text), "TX %s", tx);
        display.setCursor(0, 40);
        display.println(text);
    }
    else
    {
        display.setCursor(0, 24);
        display.println("waiting");
    }

    display.display();
}

void showSensorsScreen(const char lines[][SENSOR_LINE_LEN], uint8_t count, bool stale)
{
    display.clearDisplay();
    display.setTextColor(SSD1306_WHITE);
    display.setTextSize(1);
    display.setCursor(0, 0);
    display.println("SENSORS");
    if (stale)
    {
        drawStaleMarker(122, 5);
    }

    if (count == 0)
    {
        display.setCursor(0, 16);
        display.println("waiting for data");
    }
    else
    {
        for (uint8_t i = 0; i < count && i < SENSOR_MAX_LINES; ++i)
        {
            display.setCursor(0, 10 + i * 10);
            display.println(lines[i]);
        }
    }

    display.display();
}

void showCompositeScreen(bool hasClock, const tm &clockTime, const CompositeRow *rows,
                         uint8_t count, bool stale)
{
    display.clearDisplay();
    display.setTextColor(SSD1306_WHITE);
    display.setTextSize(1);

    uint8_t startY = 0;
    uint8_t available = SCREEN_HEIGHT;

    if (hasClock)
    {
        char clockText[9];
        strftime(clockText, sizeof(clockText), "%H:%M:%S", &clockTime);
        display.setTextSize(2);
        display.setCursor(0, 0);
        display.println(clockText);
        display.setTextSize(1);
        startY = 18;
        available = SCREEN_HEIGHT - startY;
    }

    if (stale)
    {
        drawStaleMarker(122, 5);
    }

    if (count == 0)
    {
        display.setCursor(0, startY + 4);
        display.println("waiting for data");
        display.display();
        return;
    }

    uint8_t capacity = available / 8;
    if (capacity == 0)
    {
        capacity = 1;
    }
    uint8_t rowsToShow = count < capacity ? count : capacity;
    uint8_t rowHeight = available / rowsToShow;

    for (uint8_t i = 0; i < rowsToShow; ++i)
    {
        const CompositeRow &row = rows[i];
        uint8_t y = startY + i * rowHeight;

        display.setTextSize(1);
        display.setCursor(0, y);
        display.println(row.label);

        int16_t valueWidth = (int16_t)(strlen(row.value) * 6);
        int16_t valueX = SCREEN_WIDTH - valueWidth;
        if (i == 0 && stale && !hasClock && valueX > 116 - valueWidth)
        {
            valueX = 116 - valueWidth;
        }
        if (valueX < 44)
        {
            valueX = 44;
        }
        display.setCursor(valueX, y);
        display.println(row.value);

        if (row.percent >= 0.0f && rowHeight >= 14)
        {
            drawBar(0, y + 9, SCREEN_WIDTH, 4, row.percent);
        }
    }

    display.display();
}

void showPlaceholderScreen(const char *screenId, bool stale)
{
    display.clearDisplay();
    display.setTextSize(1);
    display.setTextColor(SSD1306_WHITE);
    display.setCursor(0, 0);
    display.println(screenId);
    if (stale)
    {
        drawStaleMarker(122, 5);
    }
    display.setCursor(0, 16);
    display.println("No data yet");
    display.display();
}
}
