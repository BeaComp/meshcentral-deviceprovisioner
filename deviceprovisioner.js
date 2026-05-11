'use strict';

/**
 * MeshCentral Plugin: Device Provisioner
 *
 * Objetivo: Detetar quando um dispositivo é movido do grupo de quarentena
 * para qualquer outro grupo (aprovação), e quando é movido para o grupo
 * revogado (revogação), chamando a API correspondente em cada caso.
 *
 * Hooks utilizados (todos documentados oficialmente):
 *   - server_startup              → inicialização e carregamento de config
 *   - hook_agentCoreIsStable      → detetar novos agentes e registar o seu meshid inicial
 *   - hook_setupHttpHandlers      → expor endpoint de admin para configurar o plugin
 */

module.exports.deviceprovisioner = function (parent) {
    const plugin = { name: 'deviceprovisioner' };
    const https = require('https');
    const http = require('http');
    const url = require('url');
    const path = require('path');

    // -------------------------------------------------------------------------
    // Estado interno
    // -------------------------------------------------------------------------
    let config = {};
    let quarantineMeshId = null;
    let revokedMeshId = null;
    let productionMeshId = null;
    let pendingRetries = {};

    // -------------------------------------------------------------------------
    // Utilitários de log
    // -------------------------------------------------------------------------
    function log(level, msg, data) {
        const levels = { debug: 0, info: 1, warn: 2, error: 3 };
        const cfgLevel = levels[config.logLevel || 'info'] ?? 1;
        if ((levels[level] ?? 1) < cfgLevel) return;
        const prefix = `[DeviceProvisioner][${level.toUpperCase()}]`;
        if (data) console.log(prefix, msg, JSON.stringify(data, null, 2));
        else console.log(prefix, msg);
    }

    function loadConfig() {
        try {
            let raw = null;
            let source = null;

            // ── Prioridade 1: meshcentral-data/config.json (servidor) ─────────
            // Adicionar aqui:
            //   "domains": { "": { "pluginsConfig": { "deviceprovisioner": { ... } } } }
            const serverConfig = parent.parent && parent.parent.config;
            if (serverConfig && serverConfig.domains) {
                for (const domainKey of Object.keys(serverConfig.domains)) {
                    const domain = serverConfig.domains[domainKey];
                    if (domain &&
                        domain.pluginsConfig &&
                        domain.pluginsConfig.deviceprovisioner) {
                        raw = domain.pluginsConfig.deviceprovisioner;
                        source = `meshcentral-data/config.json (domínio: "${domainKey}")`;
                        break;
                    }
                }
            }

            // ── Prioridade 2: config.json do plugin (fallback) ────────────────
            // Localização: meshcentral-data/plugins/deviceprovisioner/config.json
            if (!raw) {
                try {
                    const pluginConfigFile = require(path.join(__dirname, 'config.json'));
                    if (pluginConfigFile && pluginConfigFile.pluginConfig) {
                        raw = pluginConfigFile.pluginConfig;
                        source = 'plugin/config.json (fallback)';
                    }
                } catch (e2) {
                    log('warn', 'Não foi possível ler config.json do plugin: ' + e2.message);
                }
            }

            if (!raw) {
                log('warn',
                    'Nenhuma configuração encontrada — usando defaults. ' +
                    'Recomendado: adicionar "pluginsConfig.deviceprovisioner" ' +
                    'ao meshcentral-data/config.json no domínio correcto.'
                );
            }

            // ── Aplicar defaults + configuração encontrada ────────────────────
            config = Object.assign({
                quarantineMeshName: 'QUARANTINE',
                quarantineMeshId: null,
                productionMeshName: 'PRODUCTION',
                productionMeshId: null,
                revokedMeshName: 'REVOKED',
                revokedMeshId: null,
                provisioningApiUrl: '',
                revocationApiUrl: '',
                provisioningApiToken: '',
                apiTimeoutMs: 10000,
                retryOnFailure: true,
                maxRetries: 3,
                logLevel: 'info'
            }, raw || {});

            // Pré-carregar IDs se definidos directamente na config
            if (config.quarantineMeshId) quarantineMeshId = config.quarantineMeshId;
            if (config.productionMeshId) productionMeshId = config.productionMeshId;
            if (config.revokedMeshId) revokedMeshId = config.revokedMeshId;

            log('info', `Configuração carregada de: ${source || 'defaults'}`);
            log('info', 'Configuração final:', config);

        } catch (e) {
            log('error', 'Erro ao carregar configuração: ' + e.message);
        }
    }

    // -------------------------------------------------------------------------
    // Normalização de IDs — o MeshCentral usa o prefixo "mesh//" internamente
    // mas os configs normalmente não o incluem. Normalizar antes de comparar.
    // -------------------------------------------------------------------------

    function normalizeMeshId(id) {
        if (!id) return null;
        // Remover prefixo se existir, para comparar sempre sem prefixo
        return id.replace(/^mesh\/\//, '');
    }

    function meshIdsEqual(a, b) {
        return normalizeMeshId(a) === normalizeMeshId(b);
    }

    // -------------------------------------------------------------------------
    // Resolver mesh IDs por nome (quarentena, produção, revogado)
    // -------------------------------------------------------------------------

    function resolveMeshIdByName(meshName, onResolved) {
        // 1. Tentar em memória primeiro
        const meshes = parent.parent && parent.parent.meshes;
        if (meshes && typeof meshes === 'object') {
            for (const key of Object.keys(meshes)) {
                const m = meshes[key];
                if (m && (m.name || '').toLowerCase() === meshName.toLowerCase()) {
                    log('info', `Grupo "${meshName}" resolvido em memória: ${m._id}`);
                    return onResolved(m._id);
                }
            }
        }

        // 2. Fallback para DB
        const db = parent.parent && parent.parent.db;
        if (db && typeof db.GetAllMeshes === 'function') {
            db.GetAllMeshes('', function (err, meshList) {
                if (err || !meshList) {
                    log('error', `Erro ao listar grupos para "${meshName}": ` + (err || 'lista vazia'));
                    return onResolved(null);
                }
                const match = meshList.find(m =>
                    (m.name || '').toLowerCase() === meshName.toLowerCase()
                );
                if (!match) {
                    log('warn', `Grupo "${meshName}" não encontrado. Cria o grupo e recarrega o plugin.`);
                    return onResolved(null);
                }
                log('info', `Grupo "${meshName}" resolvido via DB: ${match._id}`);
                onResolved(match._id);
            });
        } else {
            log('warn', `Não foi possível resolver o grupo "${meshName}" — define o meshId directamente na config.`);
            onResolved(null);
        }
    }

    function resolveQuarantineMeshId(callback) {
        if (quarantineMeshId) return callback(quarantineMeshId);
        resolveMeshIdByName(config.quarantineMeshName, callback);
    }

    // [NOVO] Resolver o grupo revogado — mesmo padrão do quarentena
    function resolveRevokedMeshId(callback) {
        if (revokedMeshId) return callback(revokedMeshId);
        resolveMeshIdByName(config.revokedMeshName, callback);
    }

    // -------------------------------------------------------------------------
    // Chamar API genérica com retry
    // -------------------------------------------------------------------------
    function callApi(apiUrl, payload, nodeId, attempt, label) {
        if (!apiUrl) {
            log('warn', `${label}: URL não configurado. Saltar chamada.`);
            return;
        }

        attempt = attempt || 1;
        log('info', `${label}: chamada (tentativa ${attempt}) para ${nodeId}`, payload);

        const parsed = url.parse(apiUrl);
        const isHttps = parsed.protocol === 'https:';
        const body = JSON.stringify(payload);

        const options = {
            hostname: parsed.hostname,
            port: parsed.port || (isHttps ? 443 : 80),
            path: parsed.path,
            method: 'POST',
            timeout: config.apiTimeoutMs,
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(body),
                'Authorization': config.provisioningApiToken || ''
            }
        };

        const req = (isHttps ? https : http).request(options, function (res) {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', function () {
                if (res.statusCode >= 200 && res.statusCode < 300) {
                    log('info', `${label}: API respondeu ${res.statusCode} para ${nodeId}`);
                    delete pendingRetries[`${label}-${nodeId}`];
                } else {
                    log('warn', `${label}: API respondeu ${res.statusCode} para ${nodeId}. Body: ${data}`);
                    scheduleRetry(apiUrl, payload, nodeId, attempt, label);
                }
            });
        });

        req.on('timeout', function () {
            req.destroy();
            log('warn', `${label}: timeout para ${nodeId}`);
            scheduleRetry(apiUrl, payload, nodeId, attempt, label);
        });

        req.on('error', function (e) {
            log('error', `${label}: erro para ${nodeId}: ${e.message}`);
            scheduleRetry(apiUrl, payload, nodeId, attempt, label);
        });

        req.write(body);
        req.end();
    }

    function scheduleRetry(apiUrl, payload, nodeId, attempt, label) {
        const key = `${label}-${nodeId}`;
        if (!config.retryOnFailure || attempt >= config.maxRetries) {
            log('error', `${label}: máximo de tentativas atingido para ${nodeId}. Desistindo.`);
            delete pendingRetries[key];
            return;
        }
        const delay = Math.min(30000, 5000 * attempt);
        log('info', `${label}: retry em ${delay / 1000}s para ${nodeId} (tentativa ${attempt + 1}/${config.maxRetries})`);
        pendingRetries[key] = { attempt, payload };
        setTimeout(function () {
            callApi(apiUrl, payload, nodeId, attempt + 1, label);
        }, delay);
    }

    // Mantém a função original para não quebrar código existente
    function callProvisioningApi(payload, nodeId, attempt) {
        callApi(config.provisioningApiUrl, payload, nodeId, attempt, 'PROVISIONING');
    }

    // -------------------------------------------------------------------------
    // Montar payload de aprovação (sem alterações ao teu código original)
    // -------------------------------------------------------------------------
    function buildPayload(node, sysinfo) {
        const payload = {
            event: 'device_approved',
            timestamp: new Date().toISOString(),
            node_id: node._id,
            hostname: node.name || null,
            mesh_id: node.meshid || null,
            domain: node.domain || '',
            agent_version: (node.agent && node.agent.ver) ? node.agent.ver : null,
            tags: node.tags || [],
            icon: node.icon || null,
            hardware: {}
        };

        if (sysinfo) {
            const hw = sysinfo.hardware || {};
            const ids = hw.identifiers || {};
            payload.hardware = {
                // Raspberry Pi / Linux usa board_serial e board_name
                serial_number: ids.board_serial || ids.product_serial || null,
                product_name: ids.board_name || ids.product_name || null,
                board_vendor: ids.board_vendor || null,
                uuid: ids.product_uuid || null,
                cpu_name: ids.cpu_name || null,
                bios_mode: ids.bios_mode || null,
                // macs/cpus/memory/storage só presentes em agentes Windows
                macs: hw.macs || [],
                cpus: (hw.cpus || []).map(c => c.name || c),
                total_ram_mb: (hw.memory && hw.memory.total)
                    ? Math.round(hw.memory.total / (1024 * 1024))
                    : null,
                storage: (hw.storage || []).map(d => ({
                    name: d.name,
                    size_gb: d.size ? Math.round(d.size / 1e9) : null
                }))
            };
        }

        return payload;
    }

    // [NOVO] Montar payload de revogação
    function buildRevocationPayload(node, sysinfo) {
        const base = buildPayload(node, sysinfo);

        // Sobrescrever apenas o que muda em relação ao payload de aprovação
        base.event = 'device_revoked';

        // O Proxy precisa do serial para remover da lista de pré-aprovados
        // Tenta extrair de várias fontes por ordem de fiabilidade
        const hw = (sysinfo && sysinfo.hardware) || {};
        base.serial = hw.identifiers && hw.identifiers.product_serial
            ? hw.identifiers.product_serial
            : (node.tags && node.tags.find(t => t.startsWith('serial:')))
                ? node.tags.find(t => t.startsWith('serial:')).replace('serial:', '')
                : node.name || null;

        return base;
    }

    // -------------------------------------------------------------------------
    // Processar aprovação
    // -------------------------------------------------------------------------
    function processApproval(nodeId) {
        parent.parent.db.Get(nodeId, function (err, nodes) {
            if (err || !nodes || nodes.length === 0) {
                log('error', `Não foi possível obter o node ${nodeId} da DB: ${err}`);
                return;
            }
            const node = nodes[0];

            // Formato real do sysinfo na DB: _id = "si" + nodeId
            // Ex: "sinode//ABC..." para nodeId "node//ABC..."
            const sysinfoId = 'si' + nodeId;
            parent.parent.db.Get(sysinfoId, function (err2, docs) {
                const sysinfo = (!err2 && docs && docs.length > 0) ? docs[0] : null;
                if (!sysinfo) log('warn', `Sysinfo não encontrado para ${nodeId} (id tentado: ${sysinfoId})`);
                const payload = buildPayload(node, sysinfo);
                callProvisioningApi(payload, nodeId, 1);
            });
        });
    }

    // Processar revogação
    function processRevocation(nodeId) {
        parent.parent.db.Get(nodeId, function (err, nodes) {
            if (err || !nodes || nodes.length === 0) {
                log('error', `Revogação: não foi possível obter o node ${nodeId} da DB: ${err}`);
                return;
            }
            const node = nodes[0];

            const sysinfoId = 'si' + nodeId;
            parent.parent.db.Get(sysinfoId, function (err2, docs) {
                const sysinfo = (!err2 && docs && docs.length > 0) ? docs[0] : null;
                const payload = buildRevocationPayload(node, sysinfo);
                log('info', `Revogando dispositivo: ${nodeId}`, payload);
                callApi(config.revocationApiUrl, payload, nodeId, 1, 'REVOCATION');
            });
        });
    }

    // -------------------------------------------------------------------------
    // HOOK: server_startup
    // -------------------------------------------------------------------------
    plugin.server_startup = function () {
        loadConfig();

        // Resolver grupo de quarentena
        resolveQuarantineMeshId(function (meshId) {
            quarantineMeshId = meshId;
            if (!meshId) {
                log('warn', 'Grupo de quarentena não resolvido no startup — nova tentativa em 5s.');
                setTimeout(function () {
                    resolveQuarantineMeshId(id => { quarantineMeshId = id; });
                }, 5000);
            }
        });

        // [NOVO] Resolver grupo de revogados — mesmo padrão
        resolveRevokedMeshId(function (meshId) {
            revokedMeshId = meshId;
            if (!meshId) {
                log('warn', 'Grupo de revogados não resolvido no startup — nova tentativa em 5s.');
                setTimeout(function () {
                    resolveRevokedMeshId(id => { revokedMeshId = id; });
                }, 5000);
            }
        });

        startPolling();
        log('info', 'Plugin DeviceProvisioner iniciado.');
    };

    // -------------------------------------------------------------------------
    // Polling — detectar mudanças de grupo
    // -------------------------------------------------------------------------
    let nodeLastMesh = {};
    let pollingTimer = null;

    function startPolling() {
        if (pollingTimer) return;
        pollingTimer = setInterval(pollForGroupChanges, 5000);
        log('info', 'Polling iniciado (intervalo: 5s).');
    }

    function pollForGroupChanges() {
        // Aguardar que pelo menos o quarantineMeshId esteja resolvido
        if (!quarantineMeshId) return;

        const db = parent.parent && parent.parent.db;
        if (!db || typeof db.GetAllType !== 'function') {
            log('warn', 'Função GetAllType não encontrada na DB do MeshCentral.');
            return;
        }

        db.GetAllType('node', function (err, nodes) {
            if (err || !nodes) return;

            nodes.forEach(function (node) {
                if (node.domain !== '') return;

                const nodeId = node._id;
                const currentMesh = node.meshid;
                const prevMesh = nodeLastMesh[nodeId];

                // Primeira vez que vemos este node — só registar, não processar
                if (prevMesh === undefined) {
                    nodeLastMesh[nodeId] = currentMesh;
                    return;
                }

                // Sem mudança — ignorar
                if (prevMesh === currentMesh) return;

                // Mudança detectada — actualizar estado
                nodeLastMesh[nodeId] = currentMesh;
                log('info', `[POLL] Node ${nodeId} mudou de ${prevMesh} para ${currentMesh}`);
                log('debug', `[POLL] Comparando: prev=${normalizeMeshId(prevMesh)} quarantine=${normalizeMeshId(quarantineMeshId)} revoked=${normalizeMeshId(revokedMeshId)}`);

                // ── Aprovação: saiu da quarentena ─────────────────────────────
                if (meshIdsEqual(prevMesh, quarantineMeshId) && !meshIdsEqual(currentMesh, quarantineMeshId)) {

                    // Se foi para o grupo revogado directamente da quarentena,
                    // tratar como revogação (não como aprovação)
                    if (revokedMeshId && meshIdsEqual(currentMesh, revokedMeshId)) {
                        log('info', `Dispositivo movido da quarentena directamente para revogados: ${nodeId}`);
                        processRevocation(nodeId);
                        return;
                    }

                    log('info', `Dispositivo aprovado via polling: ${nodeId}`);
                    processApproval(nodeId);
                    return;
                }

                // Revogação: foi para o grupo revogado (de qualquer grupo)
                if (revokedMeshId && meshIdsEqual(currentMesh, revokedMeshId) && !meshIdsEqual(prevMesh, revokedMeshId)) {
                    log('info', `Dispositivo revogado via polling: ${nodeId} (era grupo ${prevMesh})`);
                    processRevocation(nodeId);
                    return;
                }
            });
        });
    }

    plugin.HandleEvent = function (event, domain) { };

    // -------------------------------------------------------------------------
    // HOOK: hook_agentCoreIsStable (sem alterações)
    // -------------------------------------------------------------------------
    plugin.hook_agentCoreIsStable = function (meshAgent) {
        const nodeId = meshAgent.dbNodeKey;
        const meshId = meshAgent.dbMeshKey;

        if (meshIdsEqual(meshId, quarantineMeshId)) {
            log('info', `Novo dispositivo em quarentena: ${nodeId} (aguarda aprovação manual)`);
        } else if (revokedMeshId && meshIdsEqual(meshId, revokedMeshId)) {
            log('warn', `Dispositivo REVOGADO tentou reconectar: ${nodeId} — ignorar`);
        } else {
            log('debug', `Agente online: ${nodeId} no grupo ${meshId}`);
        }
    };

    return plugin;
};