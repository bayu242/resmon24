#pragma once

#include <Arduino.h>

namespace NetworkManager
{
void begin();
void loop();
bool connected();
bool portalActive();
String ssid();
String ipAddress();
const char *apSsid();
String apIp();
}
