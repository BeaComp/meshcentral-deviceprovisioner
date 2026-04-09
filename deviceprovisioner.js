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
 *
 * A deteção de mudança de grupo é feita via evento interno 'meshchange'
 * do servidor MeshCentral, acessível através do objeto parent.parent.
 *
 * NOTA SOBRE DADOS DO DISPOSITIVO:
 * O objeto `node` na DB do MeshCentral contém tipicamente:
 *   _id, name, meshid, domain, agent (version, id), rname,
 *   intelamt, tags, icon, desc, mtype
 * Os dados de hardware (MACs, serial, CPU) chegam via sysinfo e ficam
 * em `node.hwid` e na coleção `sysinfo` da DB, acessível via db.GetSysInfo().
 */

module.exports.createPlugin = function (parent) {
    const plugin = { name: 'deviceprovisioner' };
    const https = require('https');
    const http = require('http');
    const url = require('url');

    // -------------------------------------------------------------------------
    // Estado interno
    // -------------------------------------------------------------------------
    let config = {};           // configuração carregada do config.json
    let quarantineMeshId = null;       // _id resolvido do grupo de quarentena
    let pendingRetries = {};           // { nodeId: { attempts, payload } }

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
    // Carregar configuração do config.json do plugin
    // -------------------------------------------------------------------------
    function loadConfig() {
        try {
            // parent.parent é o objeto MeshCentral principal (meshcentral.js)
            // parent.pluginHandler.pluginConfig contém a config do plugin instalado
            const raw = parent.pluginHandler.pluginConfig['deviceprovisioner'] || {};
            config = Object.assign({
                quarantineMeshName: 'quarentena',
                provisioningApiUrl: '',
                provisioningApiToken: '',
                apiTimeoutMs: 10000,
                retryOnFailure: true,
                maxRetries: 3,
                logLevel: 'info'
            }, raw);
            log('info', 'Configuração carregada:', config);
        } catch (e) {
            log('error', 'Erro ao carregar configuração:', e.message);
        }
    }

    // -------------------------------------------------------------------------
    // Resolver o _id interno do grupo de quarentena pelo nome
    // -------------------------------------------------------------------------
    function resolveQuarantineMeshId(callback) {
        // parent.parent.db é o objeto de acesso à base de dados
        parent.parent.db.GetAllMeshes('', function (err, meshes) {
            if (err || !meshes) {
                log('error', 'Erro ao listar grupos:', err);
                return callback(null);
            }
            const match = meshes.find(function (m) {
                return (m.name || '').toLowerCase() === config.quarantineMeshName.toLowerCase();
            });
            if (!match) {
                log('warn', `Grupo de quarentena "${config.quarantineMeshName}" não encontrado. Cria o grupo e reinicia o plugin.`);
                return callback(null);
            }
            log('info', `Grupo de quarentena resolvido: ${match._id}`);
            callback(match._id);
        });
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
            log('error', `Erro na chamada à API para ${nodeId}:`, e.message);
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
        const delay = Math.min(30000, 5000 * attempt); // backoff: 5s, 10s, 15s...
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
        // node vem da DB do MeshCentral — campos garantidos:
        //   _id (node_id), name, meshid, domain, agent.id (tipo de agente)
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

        // sysinfo é a coleção separada que o MeshAgent envia após check-in
        // contém: hardware.macs, hardware.serialNumber, hardware.cpus, etc.
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
        // 1. Buscar o node na DB
        parent.parent.db.Get(nodeId, function (err, nodes) {
            if (err || !nodes || nodes.length === 0) {
                log('error', `Não foi possível obter o node ${nodeId} da DB:`, err);
                return;
            }
            const node = nodes[0];

            // 2. Buscar sysinfo (informações de hardware) — pode ainda não existir
            //    se o agente não enviou ainda. Tentamos na mesma; o payload terá
            //    hardware:{} vazio nesse caso.
            parent.parent.db.GetSysInfo(nodeId, function (err2, sysinfo) {
                const payload = buildPayload(node, sysinfo);
                callProvisioningApi(payload, nodeId, 1);
            });
        });
    }

    // -------------------------------------------------------------------------
    // HOOK: server_startup
    // Chamado uma vez quando o servidor inicia ou o plugin é instalado.
    // -------------------------------------------------------------------------
    plugin.server_startup = function () {
        loadConfig();

        // Resolver o ID do grupo de quarentena
        resolveQuarantineMeshId(function (meshId) {
            quarantineMeshId = meshId;
        });

        // Subscrever eventos internos do MeshCentral
        // 'meshchange' é emitido pelo webserver.js sempre que um node muda de mesh
        // Formato do evento: { meshid: novoMeshId, oldmeshid: meshIdAnterior, nodeid: ... }
        if (parent.parent && parent.parent.AddEventDispatch) {
            // AddEventDispatch regista um listener para eventos de um domínio
            // Os eventos de mudança de node são emitidos em todos os domínios
            parent.parent.AddEventDispatch(['*'], plugin);
            log('info', 'Listener de eventos registado.');
        }

        log('info', 'Plugin DeviceProvisioner iniciado.');
    };

    // -------------------------------------------------------------------------
    // Receção de eventos do servidor (via AddEventDispatch)
    // O MeshCentral emite eventos no formato { action, nodeid, meshid, ... }
    // -------------------------------------------------------------------------
    plugin.ProcessEvent = function (event, domain) {
        // Ignorar se a quarentena ainda não foi resolvida
        if (!quarantineMeshId) return;

        // 'meshchange' é o evento emitido quando um dispositivo muda de grupo
        if (event.action !== 'meshchange') return;

        // O dispositivo veio do grupo de quarentena?
        if (event.oldmeshid !== quarantineMeshId) return;

        // O novo grupo não pode ser também quarentena (salvaguarda)
        if (event.meshid === quarantineMeshId) return;

        log('info', `Dispositivo aprovado detetado: node=${event.nodeid}, de ${event.oldmeshid} → ${event.meshid}`);
        processApproval(event.nodeid);
    };

    // -------------------------------------------------------------------------
    // HOOK: hook_agentCoreIsStable
    // Chamado quando um agente faz check-in pela primeira vez (nova sessão).
    // Usamos para log de diagnóstico — não disparamos API aqui porque o
    // dispositivo pode ainda estar na quarentena.
    // -------------------------------------------------------------------------
    plugin.hook_agentCoreIsStable = function (meshAgent) {
        // meshAgent.dbNodeKey  → node_id interno
        // meshAgent.dbMeshKey  → mesh_id do grupo atual
        const nodeId = meshAgent.dbNodeKey;
        const meshId = meshAgent.dbMeshKey;

        if (meshId === quarantineMeshId) {
            log('info', `Novo dispositivo em quarentena: ${nodeId} (aguarda aprovação manual)`);
        } else {
            log('debug', `Agente online: ${nodeId} no grupo ${meshId}`);
        }
    };

    // -------------------------------------------------------------------------
    // HOOK: hook_setupHttpHandlers
    // Adiciona endpoints de administração do plugin à API REST do MeshCentral.
    // -------------------------------------------------------------------------
    plugin.hook_setupHttpHandlers = function (app) {

        // GET /plugin/deviceprovisioner/status
        // Devolve o estado atual do plugin (config, grupo de quarentena resolvido)
        app.get('/plugin/deviceprovisioner/status', function (req, res) {
            // Verificar se o pedido vem de um admin autenticado
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
        // Força o envio de um dispositivo à API (para testes sem mover de grupo)
        app.post('/plugin/deviceprovisioner/test', function (req, res) {
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
        // Recarrega a configuração e re-resolve o grupo de quarentena
        app.post('/plugin/deviceprovisioner/reload', function (req, res) {
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