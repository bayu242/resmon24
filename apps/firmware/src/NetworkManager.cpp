#include "NetworkManager.h"

#include <DNSServer.h>
#include <ESP8266WebServer.h>
#include <ESP8266WiFi.h>

#include "ConfigStore.h"

namespace
{
constexpr uint8_t WIFI_CONNECT_ATTEMPTS = 5;
constexpr uint32_t WIFI_CONNECT_TIMEOUT_MS = 8000;
constexpr uint32_t WIFI_RETRY_INTERVAL_MS = 5000;
constexpr char SETUP_AP_SSID[] = "Resmon24-Setup";

ESP8266WebServer server(80);
DNSServer dnsServer;

bool apPortalActive = false;
bool wifiConnecting = false;
uint8_t connectAttempt = 0;
uint32_t connectStartedAt = 0;
uint32_t nextConnectAt = 0;

ConfigStore::WifiConfig wifiConfig;
bool hasWifiConfig = false;

const char FORM_HEAD[] PROGMEM =
    "<!DOCTYPE html><html><head><meta charset='utf-8'><meta name='viewport' "
    "content='width=device-width,initial-scale=1'>"
    "<title>resmon24 setup</title>"
    "<style>"
    "*{box-sizing:border-box;border-radius:0}"
    "body{margin:0;padding:24px;background:#fff;color:#000;"
    "font-family:'Work Sans',system-ui,sans-serif;font-size:16px;line-height:1.6}"
    "h1{margin:0;font-family:'Archivo Black','Arial Black',Impact,sans-serif;"
    "font-weight:900;font-size:32px;line-height:1.1;text-transform:uppercase}"
    ".rule{height:5px;background:#000;width:96px;margin-top:24px}"
    "form{max-width:32rem}"
    "label{display:block;margin-top:40px;font-weight:900;"
    "font-family:'Archivo Black','Arial Black',Impact,sans-serif;"
    "font-size:14px;text-transform:uppercase}"
    "input,select{display:block;width:100%;margin-top:4px;background:#f0f0f0;"
    "color:#000;border:3px solid #000;"
    "font-family:'Space Mono',ui-monospace,monospace;font-size:15px;padding:10px 12px}"
    "input:hover,select:hover{background:#e8e8e8}"
    "input:focus,select:focus{border-width:5px;padding:8px 10px;background:#fff;"
    "outline:none}"
    ".hint{font-size:12px;line-height:1.4;color:#555;margin-top:4px}"
    "button{margin-top:40px;font-family:'Work Sans',system-ui,sans-serif;"
    "font-size:14px;font-weight:600;text-transform:uppercase;letter-spacing:2px;"
    "padding:10px 24px;border:3px solid #000;cursor:pointer}"
    ".primary{background:#000;color:#fff}"
    ".primary:hover,.primary:active{background:#fff;color:#000}"
    ".danger{background:#f00;color:#fff}"
    ".danger:hover{background:#000;color:#f00}"
    ".error{border:3px solid #f00;color:#f00;padding:12px;font-size:14px;"
    "margin-top:24px}"
    ".note{border:3px solid #000;padding:16px;font-size:14px;margin-top:40px}"
    "</style></head>"
    "<body><h1>resmon24 setup</h1><div class='rule'></div>";

const char FORM_TAIL[] PROGMEM =
    "<button type='submit' class='primary'>Save and connect</button>"
    "</form>"
    "<form method='post' action='/reset'>"
    "<button type='submit' class='danger'>Reset settings</button>"
    "</form></body></html>";

struct TimezoneOption
{
    const char *value;
    const char *label;
};

const TimezoneOption TIMEZONE_OPTIONS[] = {
    {"UTC", "UTC"},
    {"WIB-7", "WIB-7 (Western Indonesia)"},
    {"WITA-8", "WITA-8 (Central Indonesia)"},
    {"WIT-9", "WIT-9 (Eastern Indonesia)"},
    {"SGT-8", "SGT-8 (Singapore)"},
    {"JST-9", "JST-9 (Tokyo)"},
    {"IST-5:30", "IST-5:30 (India)"},
    {"GMT+7", "GMT+7"},
    {"GMT+8", "GMT+8"},
    {"EST5EDT,M3.2.0,M11.1.0", "US Eastern (EST5EDT)"},
    {"CET-1CEST,M3.5.0,M10.5.0/3", "Europe Central (CET)"},
    {"PST8PDT,M3.2.0,M11.1.0", "US Pacific (PST8PDT)"},
};

String htmlEscape(String value)
{
    value.replace("&", "&amp;");
    value.replace("<", "&lt;");
    value.replace(">", "&gt;");
    value.replace("\"", "&quot;");
    value.replace("'", "&#39;");
    return value;
}

String timezoneOptions(const String &current)
{
    String html;
    bool found = false;
    for (const auto &option : TIMEZONE_OPTIONS)
    {
        html += "<option value='";
        html += htmlEscape(option.value);
        html += "'";
        if (current == option.value)
        {
            html += " selected";
            found = true;
        }
        html += ">";
        html += option.label;
        html += "</option>";
    }
    if (!found && !current.isEmpty())
    {
        html += "<option value='";
        html += htmlEscape(current);
        html += "' selected>";
        html += htmlEscape(current);
        html += " (custom)</option>";
    }
    return html;
}

void sendForm(const String &error)
{
    String html = FPSTR(FORM_HEAD);
    if (!error.isEmpty())
    {
        html += "<p class='error'>";
        html += htmlEscape(error);
        html += "</p>";
    }
    html += "<form method='post' action='/save'>";
    html += "<label>WiFi SSID<input name='ssid' required value='";
    html += htmlEscape(wifiConfig.ssid);
    html += "'></label>";
    html += "<label>WiFi password<input name='password' type='password' value='";
    html += htmlEscape(wifiConfig.password);
    html += "'></label>";
    html += "<label>Timezone<select name='timezone'>";
    html += timezoneOptions(wifiConfig.timezone);
    html += "</select></label>";
    html += "<div class='hint'>The desktop app is found automatically on the "
            "network (mDNS).</div>";
    html += FPSTR(FORM_TAIL);

    server.send(200, "text/html", html);
}

void sendSaved()
{
    String html = FPSTR(FORM_HEAD);
    html += "<p class='note'>Settings saved. Attempting to join the WiFi "
            "network...<br>You can close this page. The device shows connection "
            "status on its display.</p></body></html>";
    server.send(200, "text/html", html);
}

void handleRoot()
{
    sendForm("");
}

void handleSave()
{
    String ssid = server.arg("ssid");
    String password = server.arg("password");
    String timezone = server.arg("timezone");
    ssid.trim();
    timezone.trim();

    if (ssid.isEmpty())
    {
        sendForm("SSID is required.");
        return;
    }
    if (!ConfigStore::isValidTimezone(timezone))
    {
        sendForm("Invalid timezone. Choose one from the list.");
        return;
    }

    wifiConfig.ssid = ssid;
    wifiConfig.password = password;
    wifiConfig.timezone = timezone;
    hasWifiConfig = true;
    ConfigStore::saveWifiConfig(wifiConfig);

    Serial.print("Saved WiFi config for ");
    Serial.println(wifiConfig.ssid);

    sendSaved();

    if (apPortalActive)
    {
        dnsServer.stop();
        WiFi.softAPdisconnect(true);
        WiFi.mode(WIFI_STA);
        apPortalActive = false;
    }

    connectAttempt = 0;
    wifiConnecting = true;
    connectStartedAt = millis();
    WiFi.mode(WIFI_STA);
    WiFi.persistent(false);
    WiFi.setSleepMode(WIFI_NONE_SLEEP);
    WiFi.disconnect();
    delay(150);
    WiFi.begin(wifiConfig.ssid.c_str(), wifiConfig.password.c_str());
}

void handleReset()
{
    Serial.println("Reset requested: clearing WiFi config and rebooting");
    ConfigStore::clearWifiConfig();
    server.send(200, "text/html",
                "<!DOCTYPE html><html><body style='margin:0;padding:24px;"
                "background:#fff;color:#000;font-family:system-ui,sans-serif'>"
                "<p style='border:3px solid #000;padding:16px;font-size:14px'>"
                "Settings cleared. Rebooting...</p></body></html>");
    delay(500);
    ESP.restart();
}

void startConfigPortal()
{
    Serial.print("Starting setup portal: ");
    Serial.println(SETUP_AP_SSID);

    wifiConnecting = false;
    WiFi.persistent(false);
    WiFi.disconnect(true);
    delay(150);
    WiFi.mode(WIFI_AP);
    WiFi.softAP(SETUP_AP_SSID);

    dnsServer.start(53, "*", WiFi.softAPIP());
    apPortalActive = true;
}

void beginConnect()
{
    wifiConnecting = true;
    connectStartedAt = millis();
    WiFi.mode(WIFI_STA);
    WiFi.persistent(false);
    WiFi.setSleepMode(WIFI_NONE_SLEEP);
    WiFi.disconnect();
    delay(150);
    WiFi.begin(wifiConfig.ssid.c_str(), wifiConfig.password.c_str());
}

bool finishConnectCheck()
{
    if (WiFi.status() == WL_CONNECTED)
    {
        wifiConnecting = false;
        connectAttempt = 0;
        ConfigStore::saveWifiConfig(wifiConfig);
        Serial.print("Connected to ");
        Serial.print(WiFi.SSID());
        Serial.print(" at ");
        Serial.println(WiFi.localIP());
        return true;
    }
    return false;
}
}

namespace NetworkManager
{
void begin()
{
    server.on("/", HTTP_GET, handleRoot);
    server.on("/save", HTTP_POST, handleSave);
    server.on("/reset", HTTP_POST, handleReset);
    server.onNotFound(handleRoot);
    server.begin();

    hasWifiConfig = ConfigStore::loadWifiConfig(wifiConfig);

    if (!hasWifiConfig)
    {
        startConfigPortal();
    }
    else
    {
        beginConnect();
    }
}

void loop()
{
    dnsServer.processNextRequest();
    server.handleClient();

    if (apPortalActive)
    {
        return;
    }

    if (wifiConnecting)
    {
        if (finishConnectCheck())
        {
            return;
        }

        if (millis() - connectStartedAt >= WIFI_CONNECT_TIMEOUT_MS)
        {
            wifiConnecting = false;
            connectAttempt++;
            Serial.print("Connection attempt ");
            Serial.print(connectAttempt);
            Serial.println(" failed");

            if (connectAttempt >= WIFI_CONNECT_ATTEMPTS)
            {
                startConfigPortal();
            }
            else
            {
                nextConnectAt = millis() + WIFI_RETRY_INTERVAL_MS;
            }
        }
        return;
    }

    if (WiFi.status() != WL_CONNECTED)
    {
        if (millis() >= nextConnectAt)
        {
            beginConnect();
        }
    }
}

bool connected()
{
    return WiFi.status() == WL_CONNECTED;
}

bool portalActive()
{
    return apPortalActive;
}

String ssid()
{
    return WiFi.SSID();
}

String ipAddress()
{
    return WiFi.localIP().toString();
}

const char *apSsid()
{
    return SETUP_AP_SSID;
}

String apIp()
{
    return WiFi.softAPIP().toString();
}
}
