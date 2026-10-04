#include "MonitorClient.h"

#include <ArduinoJson.h>
#include <ESP8266WiFi.h>
#include <ESP8266mDNS.h>
#include <WebSocketsClient.h>

#include "ClockService.h"
#include "ConfigStore.h"
#include "ScreenManager.h"

namespace
{
constexpr char MDNS_SERVICE[] = "resmon24";
constexpr char MDNS_PROTOCOL[] = "tcp";
constexpr uint16_t DEFAULT_SERVER_PORT = 8765;
constexpr uint32_t DISCOVERY_INTERVAL_MS = 5000;
constexpr uint32_t HEARTBEAT_INTERVAL_MS = 15000;
constexpr uint32_t LINK_TIMEOUT_MS = 20000;
constexpr char FIRMWARE_VERSION[] = "0.1.0";
constexpr char BOARD_NAME[] = "d1_mini";

WebSocketsClient webSocket;

bool serverDiscovered = false;
bool mdnsStarted = false;
IPAddress serverIp;
uint16_t serverPort = DEFAULT_SERVER_PORT;

bool welcomeReceived = false;
uint32_t pushIntervalMs = 1000;
uint32_t lastMessageAt = 0;
uint32_t lastMetricsAt = 0;
uint32_t lastDiscoveryAt = 0;
uint32_t lastHeartbeatAt = 0;
uint32_t heartbeatSeq = 0;

String deviceId;
String effectiveTimezone;
uint32_t messagesReceived = 0;
uint32_t eventsText = 0;
uint32_t rxWelcome = 0;
uint32_t rxConfig = 0;
uint32_t rxUpdate = 0;
uint32_t rxPing = 0;
uint32_t rxPong = 0;
uint32_t rxFail = 0;

resmon24::protocol::ResourceUpdateMessageData latest;
bool hasLatest = false;

void sendJson(JsonDocument &document)
{
    String payload;
    serializeJson(document, payload);
    webSocket.sendTXT(payload);
}

void sendHello()
{
    using namespace resmon24::protocol;

    HelloMessage message;
    message.type = "hello";
    message.ts = millis();
    message.data.deviceId = deviceId;
    message.data.firmware = FIRMWARE_VERSION;
    message.data.board = BOARD_NAME;
    message.data.timezone = effectiveTimezone;
    message.data.hasTimezone = !effectiveTimezone.isEmpty();
    message.data.capabilities.push_back(String("cpu"));
    message.data.capabilities.push_back(String("memory"));
    message.data.capabilities.push_back(String("clock"));
    message.data.capabilities.push_back(String("display.ssd1306.128x64"));

    JsonDocument document;
    JsonObject root = document.to<JsonObject>();
    toJson(message, root);
    sendJson(document);
}

void sendAck(const String &id)
{
    using namespace resmon24::protocol;

    AckMessage message;
    message.type = "ack";
    message.ts = millis();
    message.id = id;
    message.hasId = !id.isEmpty();
    message.data.ok = true;

    JsonDocument document;
    JsonObject root = document.to<JsonObject>();
    toJson(message, root);
    sendJson(document);
}

void sendPong(const String &id)
{
    using namespace resmon24::protocol;

    PongMessage message;
    message.type = "pong";
    message.ts = millis();
    message.id = id;
    message.hasId = !id.isEmpty();

    JsonDocument document;
    JsonObject root = document.to<JsonObject>();
    toJson(message, root);
    sendJson(document);
}

void sendError(const char *code, const char *text)
{
    using namespace resmon24::protocol;

    ErrorMessage message;
    message.type = "error";
    message.ts = millis();
    message.data.code = String(code);
    message.data.message = String(text);

    JsonDocument document;
    JsonObject root = document.to<JsonObject>();
    toJson(message, root);
    sendJson(document);
}

void applyConfig(const resmon24::protocol::ConfigMessage &message)
{
    ConfigStore::DisplayConfig config;
    ConfigStore::applyDefaults(config);

    config.screenCount = 0;
    for (const auto &id : message.data.screens)
    {
        if (config.screenCount >= ConfigStore::MAX_SCREENS)
        {
            break;
        }
        if (id.isEmpty() || id.length() >= ConfigStore::SCREEN_ID_LEN)
        {
            continue;
        }
        strncpy(config.screens[config.screenCount], id.c_str(), ConfigStore::SCREEN_ID_LEN - 1);
        config.screens[config.screenCount][ConfigStore::SCREEN_ID_LEN - 1] = '\0';
        config.screenCount++;
    }
    if (config.screenCount == 0)
    {
        strncpy(config.screens[0], "clock", ConfigStore::SCREEN_ID_LEN - 1);
        config.screens[0][ConfigStore::SCREEN_ID_LEN - 1] = '\0';
        config.screenCount = 1;
    }

    config.rotateMs = message.data.rotateMs;
    if (config.rotateMs < 2000)
    {
        config.rotateMs = 2000;
    }
    if (config.rotateMs > 60000)
    {
        config.rotateMs = 60000;
    }

    if (message.data.hasBrightness)
    {
        config.brightness = message.data.brightness > 255 ? 255 : (uint8_t)message.data.brightness;
        config.hasBrightness = true;
    }

    if (message.data.hasTimezone && !message.data.timezone.isEmpty() &&
        ConfigStore::isValidTimezone(message.data.timezone))
    {
        config.timezone = message.data.timezone;
        config.hasTimezone = true;
    }

    if (message.data.hasShowConnection)
    {
        config.showConnection = message.data.showConnection;
        config.hasShowConnection = true;
    }

    if (message.data.hasDimAfterMs)
    {
        int64_t dimAfterMs = message.data.dimAfterMs;
        if (dimAfterMs < 0)
        {
            dimAfterMs = 0;
        }
        if (dimAfterMs > 3600000)
        {
            dimAfterMs = 3600000;
        }
        config.dimAfterMs = (uint32_t)dimAfterMs;
    }

    ConfigStore::saveDisplayConfig(config);
    ScreenManager::applyConfig(config);

    if (config.hasTimezone)
    {
        ClockService::setTimezone(config.timezone);
    }

    Serial.printf("[%lu] Display config applied: %u screens, rotate %lu\n",
                  (unsigned long)millis(), config.screenCount,
                  (unsigned long)config.rotateMs);
}

void handleText(const String &payload)
{
    using namespace resmon24::protocol;

    lastMessageAt = millis();
    messagesReceived++;

    static JsonDocument document;
    document.clear();
    DeserializationError error = deserializeJson(document, payload);
    if (error)
    {
        rxFail++;
        Serial.print("[rx] parse failed: ");
        Serial.println(error.c_str());
        sendError("INVALID_PAYLOAD", "cannot parse JSON");
        return;
    }

    int proto = document["proto"] | -1;
    if (proto != PROTOCOL_VERSION)
    {
        sendError("UNSUPPORTED_VERSION", "protocol version mismatch");
        webSocket.disconnect();
        return;
    }

    const char *type = document["type"] | "?";
    Serial.printf("[%lu] [rx] %s\n", (unsigned long)millis(), type);

    if (strcmp(type, "welcome") == 0)
    {
        rxWelcome++;
        WelcomeMessage message;
        if (fromJson(document.as<JsonVariantConst>(), message))
        {
            welcomeReceived = true;
            pushIntervalMs = message.data.intervalMs;
            Serial.printf("[%lu] Session established (interval=%ums)\n",
                          (unsigned long)millis(), (unsigned int)pushIntervalMs);
        }
    }
    else if (strcmp(type, "config") == 0)
    {
        rxConfig++;
        ConfigMessage message;
        if (fromJson(document.as<JsonVariantConst>(), message))
        {
            applyConfig(message);
            if (message.hasId && !message.id.isEmpty())
            {
                sendAck(message.id);
            }
        }
    }
    else if (strcmp(type, "resource_update") == 0)
    {
        rxUpdate++;
        ResourceUpdateMessage message;
        if (fromJson(document.as<JsonVariantConst>(), message))
        {
            latest = message.data;
            hasLatest = true;
            lastMetricsAt = millis();
            ScreenManager::onMetrics();
        }
    }
    else if (strcmp(type, "ping") == 0)
    {
        rxPing++;
        sendPong(String(document["id"] | ""));
    }
    else if (strcmp(type, "pong") == 0)
    {
        rxPong++;
        // heartbeat reply, nothing to do
    }
    else if (strcmp(type, "error") == 0)
    {
        Serial.print("Server error: ");
        Serial.println(document["data"]["code"] | "?");
    }
    else
    {
        sendError("UNSUPPORTED_TYPE", "unknown message type");
    }
}

void webSocketEvent(WStype_t type, uint8_t *payload, size_t length)
{
    switch (type)
    {
    case WStype_CONNECTED:
        Serial.printf("[%lu] WebSocket connected\n", (unsigned long)millis());
        sendHello();
        break;

    case WStype_DISCONNECTED:
        Serial.printf("[%lu] WebSocket disconnected", (unsigned long)millis());
        if (payload != nullptr && length > 0)
        {
            Serial.print(" (");
            Serial.write(payload, length);
            Serial.println(")");
        }
        else
        {
            Serial.println();
        }
        welcomeReceived = false;
        break;

    case WStype_TEXT:
    {
        eventsText++;
        String text;
        text.concat((char *)payload, length);
        handleText(text);
        break;
    }

    case WStype_ERROR:
        Serial.print("WebSocket error");
        if (payload != nullptr && length > 0)
        {
            Serial.print(": ");
            Serial.write(payload, length);
            Serial.println();
        }
        else
        {
            Serial.println();
        }
        break;

    default:
        break;
    }
}
}

namespace MonitorClient
{
void begin(const String &configuredTimezone)
{
    effectiveTimezone = configuredTimezone;
    deviceId = String("esp") + String(ESP.getChipId(), HEX);
}

void loop()
{
    if (!serverDiscovered)
    {
        const uint32_t discoveryNow = millis();
        if (discoveryNow - lastDiscoveryAt >= DISCOVERY_INTERVAL_MS)
        {
            lastDiscoveryAt = discoveryNow;
            if (!mdnsStarted)
            {
                mdnsStarted = MDNS.begin("resmon24-device");
            }

            uint32_t count = MDNS.queryService(MDNS_SERVICE, MDNS_PROTOCOL);
            if (count > 0)
            {
                serverIp = MDNS.IP(0);
                uint16_t discoveredPort = MDNS.port(0);
                serverPort = discoveredPort != 0 ? discoveredPort : DEFAULT_SERVER_PORT;
                serverDiscovered = true;

                Serial.print("Desktop found: ");
                Serial.print(serverIp);
                Serial.print(":");
                Serial.println(serverPort);

                webSocket.begin(serverIp, serverPort, "/");
                webSocket.onEvent(webSocketEvent);
                webSocket.setReconnectInterval(5000);
                webSocket.enableHeartbeat(15000, 5000, 2);
            }
        }
        return;
    }

    webSocket.loop();

    // Capture time AFTER webSocket.loop() so `now` can never be older than
    // lastMessageAt (captured during message handling). Otherwise the unsigned
    // subtraction below underflows and the link timeout fires immediately.
    const uint32_t now = millis();

    if (welcomeReceived)
    {
        if (now - lastHeartbeatAt >= HEARTBEAT_INTERVAL_MS)
        {
            lastHeartbeatAt = now;

            using namespace resmon24::protocol;
            PingMessage message;
            message.type = "ping";
            message.ts = millis();
            char id[16];
            snprintf(id, sizeof(id), "hb-%u", ++heartbeatSeq);
            message.id = String(id);
            message.hasId = true;

            JsonDocument document;
            JsonObject root = document.to<JsonObject>();
            toJson(message, root);
            sendJson(document);
        }

        if (now - lastMessageAt >= LINK_TIMEOUT_MS)
        {
            Serial.printf(
                "[%lu] Link timeout, reconnecting (text=%u rx=%u welcome=%u config=%u update=%u "
                "ping=%u pong=%u fail=%u heap=%u wifi=%d rssi=%d)\n",
                (unsigned long)millis(), eventsText, messagesReceived, rxWelcome, rxConfig,
                rxUpdate, rxPing, rxPong, rxFail, (unsigned int)ESP.getFreeHeap(),
                (int)WiFi.status(), (int)WiFi.RSSI());
            welcomeReceived = false;
            webSocket.disconnect();
        }
    }
}

bool sessionActive()
{
    return welcomeReceived;
}

const resmon24::protocol::ResourceUpdateMessageData *latestData()
{
    return hasLatest ? &latest : nullptr;
}

uint32_t lastUpdateAt()
{
    return lastMetricsAt;
}

uint32_t intervalMs()
{
    return pushIntervalMs;
}
}
