# MeshCentral Device Provisioner Plugin

Plugin para MeshCentral que deteta quando um dispositivo é movido do grupo de **quarentena** para qualquer grupo aprovado, e chama uma API POST com todas as informações do dispositivo.

## Como funciona

```
Dispositivo liga → entra no grupo "quarentena" → Admin move para grupo de produção
                                                        ↓
                                          Plugin deteta evento 'meshchange'
                                                        ↓
                                          Busca node + sysinfo na DB local
                                                        ↓
                                          POST /api/devices/approved com payload JSON
```

## Payload enviado à API

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

## Instalação

### 1. Ativar plugins no config.json do MeshCentral

```json
{
  "settings": {
    "plugins": { "enabled": true }
  }
}
```

### 2. Criar o grupo de quarentena

Na interface do MeshCentral, cria um Device Group com o nome **exatamente igual** ao configurado em `quarantineMeshName` (default: `"quarentena"`). Os agentes novos devem ser instalados com o instalador **deste grupo**.

### 3. Instalar o plugin

No MeshCentral, vai a **My Server → Plugins → Download Plugin** e introduz o URL do repositório.

Ou manualmente:
```bash
cp -r meshcentral-deviceprovisioner /opt/meshcentral/meshcentral-data/plugins/
```

### 4. Configurar no config.json do MeshCentral

```json
{
  "settings": {
    "plugins": { "enabled": true }
  },
  "domains": {
    "": {
      "pluginsConfig": {
        "deviceprovisioner": {
          "quarantineMeshName": "quarentena",
          "provisioningApiUrl": "https://tua-api/api/devices/approved",
          "provisioningApiToken": "Bearer SEU_TOKEN",
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

### 5. Reiniciar o MeshCentral

```bash
systemctl restart meshcentral
```

## Endpoints de administração

| Método | URL | Descrição |
|--------|-----|-----------|
| GET | `/plugin/deviceprovisioner/status` | Estado do plugin e configuração |
| POST | `/plugin/deviceprovisioner/test?nodeId=node//...` | Forçar chamada para um node específico |
| POST | `/plugin/deviceprovisioner/reload` | Recarregar config sem reiniciar |

## Notas importantes

- O `sysinfo` (MACs, serial, CPU) pode ainda não estar disponível se o agente acabou de fazer check-in. O plugin envia o que existir; os dados de hardware aparecem tipicamente 30–60 segundos após a primeira ligação do agente.
- Se a API falhar, o plugin faz retry com backoff exponencial (5s, 10s, 15s...) até `maxRetries`.
- O evento interno `meshchange` é real e emitido pelo `webserver.js` do MeshCentral quando um node muda de grupo via interface ou API.