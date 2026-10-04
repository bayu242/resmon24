#pragma once

// Compile-time verification that the generated resmon24 protocol types build
// against the ESP8266 Arduino + ArduinoJson toolchain.
#include <resmon24_protocol.h>

namespace resmon24
{
namespace protocol
{
void verifyProtocolTypes();
}
}
