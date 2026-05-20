# MeshCentral Device Provisioner Plugin

Plugin for MeshCentral that detects when a device is moved from the **quarantine** group to any approved group, and calls a POST API with all device information.

## How it works

```
Device connects → joins "quarantine" group → Admin moves to production group
                                                        ↓
                                          Plugin detects 'meshchange' event
                                                        ↓
                                          Fetches node + sysinfo from local DB
                                                        ↓
                                          POST /api/devices/approved with JSON payload
```

## Payload sent to the API

```json
{
  "event": "device_approved",
  "timestamp": "2026-04-08T10:00:00.000Z",
  "node_id": "node//dominio/abc123",
  "hostname": "raspberry-pi-001",
  "mesh_id": "mesh//dominio/xyz456",
  "domain": "",
  "agent_version": 3,
  "tags": [],
  "hardware": {
    "serial_number": "C02XY1234",
    "product_name": "Raspberry Pi 4 Model B",
    "uuid": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
    "macs": ["dc:a6:32:aa:bb:cc"],
    "cpus": ["ARMv7 Processor rev 3 (v7l)"],
    "total_ram_mb": 3926,
    "storage": [
      { "name": "mmcblk0", "size_gb": 32 }
    ]
  }
}
```

## Installation

### 1. Enable plugins in MeshCentral's config.json

```json
{
  "settings": {
    "plugins": { "enabled": true }
  }
}
```

### 2. Create the quarantine group

In the MeshCentral interface, create a Device Group with a name **exactly matching** the value configured in `quarantineMeshName` (default: `"quarentena"`). New agents must be installed using the installer from **this group**.

### 3. Install the plugin

In MeshCentral, go to **My Server → Plugins → Download Plugin** and enter the repository URL.

Or manually:
```bash
cp -r meshcentral-deviceprovisioner /opt/meshcentral/meshcentral-data/plugins/
```

### 4. Configure in MeshCentral's config.json

```json
{
  "settings": {
    "plugins": { "enabled": true }
  },
  "domains": {
    "": {
      "pluginsConfig": {
        "deviceprovisioner": {
          "quarantineMeshId": "XXXXXXXX",
          "provisioningApiUrl": "https://your-api/api/devices/approved",
          "provisioningApiToken": "Bearer YOUR_TOKEN",
          "apiTimeoutMs": 10000,
          "retryOnFailure": true,
          "maxRetries": 3,
          "logLevel": "info"
        }
      }
    }
  }
}
```

### 5. Restart MeshCentral

```bash
systemctl restart meshcentral
```

## Administration endpoints

| Method | URL | Description |
|--------|-----|-------------|
| GET | `/plugin/deviceprovisioner/status` | Plugin status and configuration |
| POST | `/plugin/deviceprovisioner/test?nodeId=node//...` | Force a call for a specific node |
| POST | `/plugin/deviceprovisioner/reload` | Reload config without restarting |

## Important notes

- `sysinfo` (MACs, serial, CPU) may not yet be available if the agent just checked in. The plugin sends whatever is available; hardware data typically appears 30–60 seconds after the agent's first connection.
- If the API call fails, the plugin retries with exponential backoff (5s, 10s, 15s...) up to `maxRetries`.
- The internal `meshchange` event is real and emitted by MeshCentral's `webserver.js` whenever a node changes group via the UI or API.
