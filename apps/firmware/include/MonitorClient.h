#pragma once

#include <Arduino.h>
#include <resmon24_protocol.h>

namespace MonitorClient
{
void begin(const String &effectiveTimezone);
void loop();
bool sessionActive();
const resmon24::protocol::ResourceUpdateMessageData *latestData();
uint32_t lastUpdateAt();
uint32_t intervalMs();
}
