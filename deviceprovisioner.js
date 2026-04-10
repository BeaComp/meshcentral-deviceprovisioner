'use strict';

/**
 * MeshCentral Plugin: Device Provisioner
 *
 * Objetivo: Detetar quando um dispositivo é movido do grupo de quarentena
 * para qualquer outro grupo (aprovação), e chamar uma API POST com as
 * informações do dispositivo (node_id, meshid, hostname, MACs, serial, etc.)
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

    // -------------------------------------------------------------------------
    // CORREÇÃO 1: Carregar configuração de forma robusta
    // Tenta 3 fontes por ordem de prioridade:
    //   1. pluginsConfig no config.json do servidor (domínio raiz)
    //   2. pluginsConfig em qualquer domínio configurado
    //   3. pluginConfig no config.json do próprio plugin
    // -------------------------------------------------------------------------
    function loadConfig() {
        try {
            let raw = null;

            // Fonte 1: config.json do servidor → domains[""].pluginsConfig.deviceprovisioner
            const serverConfig = parent.parent && parent.parent.config;
            if (serverConfig && serverConfig.domains) {
                for (const domainKey of Object.keys(serverConfig.domains)) {
                    const domain = serverConfig.domains[domainKey];
                    if (domain && domain.pluginsConfig && domain.pluginsConfig.deviceprovisioner) {
                        raw = domain.pluginsConfig.deviceprovisioner;
                        log('info', `Configuração carregada do servidor (domínio: "${domainKey}")`);
                        break;
                    }
                }
            }

            // Fonte 2: config.json do próprio plugin (campo pluginConfig)
            if (!raw) {
                try {
                    const pluginConfigFile = require(path.join(__dirname, 'config.json'));
                    if (pluginConfigFile && pluginConfigFile.pluginConfig) {
                        raw = pluginConfigFile.pluginConfig;
                        log('info', 'Configuração carregada do config.json do plugin.');
                    }
                } catch (e2) {
                    log('warn', 'Não foi possível ler config.json do plugin: ' + e2.message);
                }
            }

            config = Object.assign({
                quarantineMeshName: 'quarentena',
                quarantineMeshId: null,
                provisioningApiUrl: '',
                provisioningApiToken: '',
                apiTimeoutMs: 10000,
                retryOnFailure: true,
                maxRetries: 3,
                logLevel: 'info'
            }, raw || {});

            // Se o config.json do servidor já tiver o meshId direto, usamo-lo
            if (config.quarantineMeshId) {
                quarantineMeshId = config.quarantineMeshId;
                log('info', `quarantineMeshId definido diretamente na config: ${quarantineMeshId}`);
            }

            log('info', 'Configuração final:', config);
        } catch (e) {
            log('error', 'Erro ao carregar configuração: ' + e.message);
        }
    }

    // -------------------------------------------------------------------------
    // CORREÇÃO 2: Resolver o _id do grupo de quarentena
    // Usa parent.parent.meshes (em memória) em vez de GetAllMeshes (DB),
    // evitando problemas de timing e assinaturas incorretas.
    // -------------------------------------------------------------------------
    function resolveQuarantineMeshId(callback) {
        // Se já temos o ID da config, não precisamos de pesquisar
        if (quarantineMeshId) {
            return callback(quarantineMeshId);
        }

        // Tentar usar o objeto em memória parent.parent.meshes
        const meshes = parent.parent && parent.parent.meshes;
        if (meshes && typeof meshes === 'object') {
            const keys = Object.keys(meshes);
            for (const key of keys) {
                const m = meshes[key];
                if (m && (m.name || '').toLowerCase() === config.quarantineMeshName.toLowerCase()) {
                    log('info', `Grupo de quarentena resolvido (memória): ${m._id}`);
                    return callback(m._id);
                }
            }
        }

        // Fallback: tentar via DB se GetAllMeshes existir
        const db = parent.parent && parent.parent.db;
        if (db && typeof db.GetAllMeshes === 'function') {
            db.GetAllMeshes('', function (err, meshList) {
                if (err || !meshList) {
                    log('error', 'Erro ao listar grupos via DB: ' + (err || 'lista vazia'));
                    return callback(null);
                }
                const match = meshList.find(function (m) {
                    return (m.name || '').toLowerCase() === config.quarantineMeshName.toLowerCase();
                });
                if (!match) {
                    log('warn', `Grupo "${config.quarantineMeshName}" não encontrado. Cria o grupo e recarrega o plugin.`);
                    return callback(null);
                }
                log('info', `Grupo de quarentena resolvido (DB): ${match._id}`);
                callback(match._id);
            });
        } else {
            log('warn', 'parent.parent.meshes vazio e db.GetAllMeshes indisponível. ' +
                'Define quarantineMeshId diretamente na config ou reinicia após criar o grupo.');
            callback(null);
        }
    }

    // -------------------------------------------------------------------------
    // Chamar a API de provisionamento
    // -------------------------------------------------------------------------
    function callProvisioningApi(payload, nodeId, attempt) {
        if (!config.provisioningApiUrl) {
            log('warn', 'provisioningApiUrl não configurado. Saltar chamada à API.');
            return;
        }

        attempt = attempt || 1;
        log('info', `Chamando API de provisionamento (tentativa ${attempt}) para ${nodeId}`, payload);

        const parsed = url.parse(config.provisioningApiUrl);
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

        const transport = isHttps ? https : http;
        const req = transport.request(options, function (res) {
            let data = '';
            res.on('data', function (chunk) { data += chunk; });
            res.on('end', function () {
                if (res.statusCode >= 200 && res.statusCode < 300) {
                    log('info', `API respondeu ${res.statusCode} para ${nodeId}:`, data);
                    delete pendingRetries[nodeId];
                } else {
                    log('warn', `API respondeu ${res.statusCode} para ${nodeId}. Body: ${data}`);
                    scheduleRetry(payload, nodeId, attempt);
                }
            });
        });

        req.on('timeout', function () {
            req.destroy();
            log('warn', `Timeout na chamada à API para ${nodeId}`);
            scheduleRetry(payload, nodeId, attempt);
        });

        req.on('error', function (e) {
            log('error', `Erro na chamada à API para ${nodeId}: ${e.message}`);
            scheduleRetry(payload, nodeId, attempt);
        });

        req.write(body);
        req.end();
    }

    function scheduleRetry(payload, nodeId, attempt) {
        if (!config.retryOnFailure || attempt >= config.maxRetries) {
            log('error', `Máximo de tentativas atingido para ${nodeId}. Desistindo.`);
            delete pendingRetries[nodeId];
            return;
        }
        const delay = Math.min(30000, 5000 * attempt);
        log('info', `Retry em ${delay / 1000}s para ${nodeId} (tentativa ${attempt + 1}/${config.maxRetries})`);
        pendingRetries[nodeId] = { attempt, payload };
        setTimeout(function () {
            callProvisioningApi(payload, nodeId, attempt + 1);
        }, delay);
    }

    // -------------------------------------------------------------------------
    // Montar o payload com todas as informações do dispositivo
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
            payload.hardware = {
                serial_number: hw.identifiers && hw.identifiers.product_serial ? hw.identifiers.product_serial : null,
                product_name: hw.identifiers && hw.identifiers.product_name ? hw.identifiers.product_name : null,
                uuid: hw.identifiers && hw.identifiers.product_uuid ? hw.identifiers.product_uuid : null,
                macs: hw.macs || [],
                cpus: (hw.cpus || []).map(function (c) { return c.name || c; }),
                total_ram_mb: hw.memory && hw.memory.total ? Math.round(hw.memory.total / (1024 * 1024)) : null,
                storage: (hw.storage || []).map(function (d) {
                    return { name: d.name, size_gb: d.size ? Math.round(d.size / 1e9) : null };
                })
            };
        }

        return payload;
    }

    // -------------------------------------------------------------------------
    // Processar aprovação: buscar sysinfo e chamar API
    // -------------------------------------------------------------------------
    function processApproval(nodeId) {
        parent.parent.db.Get(nodeId, function (err, nodes) {
            if (err || !nodes || nodes.length === 0) {
                log('error', `Não foi possível obter o node ${nodeId} da DB: ${err}`);
                return;
            }
            const node = nodes[0];
            parent.parent.db.GetSysInfo(nodeId, function (err2, sysinfo) {
                const payload = buildPayload(node, sysinfo);
                callProvisioningApi(payload, nodeId, 1);
            });
        });
    }

    // -------------------------------------------------------------------------
    // HOOK: server_startup
    // -------------------------------------------------------------------------
    plugin.server_startup = function () {
        loadConfig();

        // Tentar resolver logo; se falhar, tentar novamente após 5s (DB pode
        // ainda não estar pronta no momento exato do startup)
        resolveQuarantineMeshId(function (meshId) {
            quarantineMeshId = meshId;
            if (!meshId) {
                log('warn', 'Grupo de quarentena não resolvido no startup — nova tentativa em 5s.');
                setTimeout(function () {
                    resolveQuarantineMeshId(function (id) {
                        quarantineMeshId = id;
                    });
                }, 5000);
            }
        });

        // Iniciar polling para detetar mudanças de grupo
        startPolling();

        log('info', 'Plugin DeviceProvisioner iniciado.');
    };

    // -------------------------------------------------------------------------
    // Receção de eventos do servidor
    // -------------------------------------------------------------------------
    // Cache: nodeId -> último meshId conhecido (para detetar mudança de grupo)
    let nodeLastMesh = {};
    let pollingTimer = null;

    // -------------------------------------------------------------------------
    // Polling periódico à DB para detetar mudanças de grupo
    // Lê todos os nodes da quarentena e verifica se algum mudou de grupo.
    // Esta abordagem é robusta e não depende do sistema de eventos interno.
    // -------------------------------------------------------------------------
    function startPolling() {
        if (pollingTimer) return; // já está a correr
        pollingTimer = setInterval(function () {
            pollForGroupChanges();
        }, 5000); // verifica a cada 5 segundos
        log('info', 'Polling iniciado (intervalo: 5s).');
    }

    function pollForGroupChanges() {
        if (!quarantineMeshId) return;
        const db = parent.parent && parent.parent.db;
        
        // CORREÇÃO: O MeshCentral usa db.GetAllType em vez de db.GetAllNodes
        if (!db || typeof db.GetAllType !== 'function') {
            log('warn', 'Função GetAllType não encontrada na DB do MeshCentral.');
            return;
        }

        // Buscar todos os documentos do tipo 'node' no domínio raiz ('')
        db.GetAllType('node', '', function (err, nodes) {
            if (err || !nodes) return;

            nodes.forEach(function (node) {
                const nodeId     = node._id;
                const currentMesh = node.meshid;
                const prevMesh   = nodeLastMesh[nodeId];

                // Primeira vez que vemos este node — apenas registar
                if (prevMesh === undefined) {
                    nodeLastMesh[nodeId] = currentMesh;
                    return;
                }

                // Mesh não mudou
                if (prevMesh === currentMesh) return;

                // Mesh mudou — atualizar cache
                nodeLastMesh[nodeId] = currentMesh;

                log('info', '[POLL] Node ' + nodeId +
                    ' mudou de ' + prevMesh + ' para ' + currentMesh);

                // Veio da quarentena para outro grupo?
                if (prevMesh === quarantineMeshId && currentMesh !== quarantineMeshId) {
                    log('info', 'Dispositivo aprovado detetado via polling: node=' +
                        nodeId + ', de ' + prevMesh + ' para ' + currentMesh);
                    processApproval(nodeId);
                }
            });
        });
    }

    // HandleEvent mantido por compatibilidade mas não é o mecanismo principal
    plugin.HandleEvent = function (event, domain) { };

    // -------------------------------------------------------------------------
    // HOOK: hook_agentCoreIsStable
    // -------------------------------------------------------------------------
    plugin.hook_agentCoreIsStable = function (meshAgent) {
        const nodeId = meshAgent.dbNodeKey;
        const meshId = meshAgent.dbMeshKey;

        if (meshId === quarantineMeshId) {
            log('info', `Novo dispositivo em quarentena: ${nodeId} (aguarda aprovação manual)`);
        } else {
            log('debug', `Agente online: ${nodeId} no grupo ${meshId}`);
        }
    };

    // -------------------------------------------------------------------------
    // CORREÇÃO 3: hook_setupHttpHandlers — suporta Express direto ou wrapper
    // Em versões recentes do MeshCentral o argumento pode ser um objeto
    // webserver; o Express está em app.expressApp ou app.app.
    // -------------------------------------------------------------------------
    plugin.hook_setupHttpHandlers = function (app) {

        // Resolver o objeto Express correto
        const express = app && (app.expressApp || app.app || (typeof app.get === 'function' ? app : null));
        if (!express || typeof express.get !== 'function') {
            log('warn', 'hook_setupHttpHandlers: não foi possível obter o objeto Express. ' +
                'Endpoints HTTP do plugin não serão registados.');
            return;
        }

        // GET /plugin/deviceprovisioner/status
        express.get('/plugin/deviceprovisioner/status', function (req, res) {
            if (!req.session || !req.session.userid) {
                return res.status(401).json({ error: 'Não autenticado' });
            }
            res.json({
                ok: true,
                quarantineMeshId,
                pendingRetries: Object.keys(pendingRetries).length,
                config: {
                    quarantineMeshName: config.quarantineMeshName,
                    provisioningApiUrl: config.provisioningApiUrl,
                    retryOnFailure: config.retryOnFailure,
                    maxRetries: config.maxRetries,
                    logLevel: config.logLevel
                }
            });
        });

        // POST /plugin/deviceprovisioner/test?nodeId=node//...
        express.post('/plugin/deviceprovisioner/test', function (req, res) {
            if (!req.session || !req.session.userid) {
                return res.status(401).json({ error: 'Não autenticado' });
            }
            const nodeId = req.query.nodeId;
            if (!nodeId) {
                return res.status(400).json({ error: 'Parâmetro nodeId obrigatório' });
            }
            processApproval(nodeId);
            res.json({ ok: true, message: `Chamada de aprovação iniciada para ${nodeId}` });
        });

        // POST /plugin/deviceprovisioner/reload
        express.post('/plugin/deviceprovisioner/reload', function (req, res) {
            if (!req.session || !req.session.userid) {
                return res.status(401).json({ error: 'Não autenticado' });
            }
            loadConfig();
            resolveQuarantineMeshId(function (meshId) {
                quarantineMeshId = meshId;
                res.json({ ok: true, quarantineMeshId });
            });
        });

        log('info', 'Endpoints HTTP registados em /plugin/deviceprovisioner/*');
    };

    return plugin;
};
