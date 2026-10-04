#include "ProtocolTypes.h"

namespace resmon24
{
namespace protocol
{
void verifyProtocolTypes()
{
    JsonDocument document;
    DeserializationError error = deserializeJson(
        document,
        "{\"type\":\"resource_update\",\"proto\":1,\"ts\":1,"
        "\"data\":{\"cpu\":{\"usage\":12.5,\"cores\":[10.0,15.0]},"
        "\"memory\":{\"used\":1024,\"total\":2048,\"percent\":50.0}}}");
    if (error)
    {
        return;
    }

    ResourceUpdateMessage update;
    if (!fromJson(document.as<JsonVariantConst>(), update))
    {
        return;
    }

    JsonDocument encoded;
    JsonObject root = encoded.to<JsonObject>();
    toJson(update, root);

    HelloMessage hello;
    hello.data.deviceId = String("test-device");
    hello.data.firmware = String("0.1.0");
    hello.data.board = String("d1_mini");
    hello.data.capabilities.push_back(String("cpu"));
    hello.data.capabilities.push_back(String("memory"));
    hello.data.timezone = String("WIB-7");
    hello.data.hasTimezone = true;

    JsonDocument helloEncoded;
    JsonObject helloRoot = helloEncoded.to<JsonObject>();
    toJson(hello, helloRoot);
}
}
}
