
'use strict';
/**
 * MeshCentral Plugin: Device Provisioner
 * =======================================
 *
 * @file        index.js
 * @author      Beatriz Faria <beatrizfaria@ipb.pt>
 * @description MeshCentral plugin that automates device lifecycle management
 *              in a Smart City IoT deployment using Ubuntu Core and Serial Vault.
 *
 * Overview
 * --------
 * This plugin monitors device group changes within MeshCentral and triggers
 * corresponding API calls to a Serial Vault proxy, enforcing a three-stage
 * device lifecycle:
 *
 *   QUARANTINE → PRODUCTION  (commissioning)
 *   ANY GROUP  → REVOKED     (revocation)
 *
 * When a device is moved from the quarantine group to any other group,
 * the plugin calls the provisioning API endpoint, which marks the device
 * as commissioned in the Serial Vault proxy. Snaps on the device
 * (e.g. telemetry, MeshCentral agent) poll this status and begin normal
 * operation only after commissioning.
 *
 * When a device is moved to the revoked group, the plugin calls the
 * revocation API endpoint, which removes the device from the pre-approved
 * serial list and marks it as revoked. Snaps on the device detect this
 * and terminate permanently.
 *
 * Architecture
 * ------------
 *
 *   Engineer (MeshCentral UI)
 *       │
 *       │  moves device between groups
 *       ▼
 *   MeshCentral Server
 *       │
 *       │  plugin detects group change (polling every 5s)
 *       ▼
 *   Device Provisioner Plugin (this file)
 *       │
 *       ├── commissioning → POST /webhook/commissioned
 *       │                       Serial Vault Proxy
 *       │                           │
 *       │                           └── marks device as "commissioned"
 *       │
 *       └── revocation   → POST /webhook/revoke
 *                               Serial Vault Proxy
 *                                   │
 *                                   ├── marks device as "revoked"
 *                                   └── removes from approved_serials table
 *
 * Hooks used (all officially documented MeshCentral plugin hooks)
 * ---------------------------------------------------------------
 *   server_startup          → load configuration, resolve group IDs, start polling
 *   hook_agentCoreIsStable  → detect new agents and log their initial group
 *   hook_setupHttpHandlers  → (reserved) expose admin endpoint for config
 *
 * Configuration
 * -------------
 * Add the following to your meshcentral-data/config.json under the domain:
 *
 *   "pluginsConfig": {
 *     "deviceprovisioner": {
 *       "quarantineMeshName": "QUARANTINE",
 *       "productionMeshName": "PRODUCTION",
 *       "revokedMeshName":    "REVOKED",
 *       "provisioningApiUrl": "http://YOUR_PROXY_IP:8082/webhook/commissioned",
 *       "revocationApiUrl":   "http://YOUR_PROXY_IP:8082/webhook/revoke",
 *       "provisioningApiToken": "Bearer YOUR_TOKEN",
 *       "apiTimeoutMs":  10000,
 *       "retryOnFailure": true,
 *       "maxRetries": 3,
 *       "logLevel": "info"
 *     }
 *   }
 *
 * Alternatively, you can hardcode the mesh group IDs to skip name resolution:
 *
 *       "quarantineMeshId": "mesh//XXXXXXXX...",
 *       "productionMeshId": "mesh//YYYYYYYY...",
 *       "revokedMeshId":    "mesh//ZZZZZZZZ..."
 *
 * Retry behaviour
 * ---------------
 * If an API call fails (timeout, non-2xx response, network error), the plugin
 * retries with exponential backoff (5s, 10s, 15s, ...) up to maxRetries.
 * Failed calls that exhaust retries are logged and discarded.
 *
 * Security notes
 * --------------
 * - The provisioningApiToken is sent as the Authorization header on every
 *   API call. Keep it secret and rotate it periodically.
 * - The plugin does not validate TLS certificates when calling HTTP endpoints.
 *   Use HTTPS with a valid certificate in production.
 * - The revocation flow removes the device from the pre-approved serial list
 *   in the Serial Vault proxy database, permanently blocking re-registration.
 */

module.exports.deviceprovisioner = function (parent) {
    const plugin = { name: 'deviceprovisioner' };
    const https = require('https');
    const http = require('http');
    const url = require('url');
    const path = require('path');

    // =========================================================================
    // Internal state
    // =========================================================================
    let config = {};
    let quarantineMeshId = null;
    let revokedMeshId = null;
    let productionMeshId = null;
    let pendingRetries = {};

    // =========================================================================
    // Logging utility
    //
    // Respects config.logLevel (debug < info < warn < error).
    // Falls back to "info" if not configured.
    // =========================================================================
    function log(level, msg, data) {
        const levels = { debug: 0, info: 1, warn: 2, error: 3 };
        const cfgLevel = levels[config.logLevel || 'info'] ?? 1;
        if ((levels[level] ?? 1) < cfgLevel) return;
        const prefix = `[DeviceProvisioner][${level.toUpperCase()}]`;
        if (data) console.log(prefix, msg, JSON.stringify(data, null, 2));
        else console.log(prefix, msg);
    }

    // =========================================================================
    // Configuration loader
    //
    // Tries three sources in order of priority:
    //   1. parent.parent.config (in-memory server config, already parsed)
    //   2. meshcentral-data/config.json (read from disk)
    //   3. plugin/config.json (fallback, local to the plugin directory)
    //
    // Merges the found config with safe defaults.
    // =========================================================================
    function loadConfig() {
        try {
            let raw = null;
            let source = null;

            // Priority 1: in-memory server config
            const serverConfig = parent.parent && parent.parent.config;
            if (serverConfig && serverConfig.domains) {
                for (const domainKey of Object.keys(serverConfig.domains)) {
                    const domain = serverConfig.domains[domainKey];
                    if (domain &&
                        domain.pluginsConfig &&
                        domain.pluginsConfig.deviceprovisioner) {
                        raw = domain.pluginsConfig.deviceprovisioner;
                        source = `parent.parent.config (domain: "${domainKey}")`;
                        break;
                    }
                }
            }

            // Priority 2: read meshcentral-data/config.json from disk
            if (!raw) {
                try {
                    const fs = require('fs');
                    const serverConfigPath = path.join(__dirname, '..', '..', 'config.json');
                    if (fs.existsSync(serverConfigPath)) {
                        const serverConfigFile = JSON.parse(
                            fs.readFileSync(serverConfigPath, 'utf8')
                        );
                        const domains = serverConfigFile.domains || {};
                        for (const domainKey of Object.keys(domains)) {
                            const domain = domains[domainKey];
                            if (domain &&
                                domain.pluginsConfig &&
                                domain.pluginsConfig.deviceprovisioner) {
                                raw = domain.pluginsConfig.deviceprovisioner;
                                source = `meshcentral-data/config.json (domain: "${domainKey}")`;
                                break;
                            }
                        }
                    } else {
                        log('warn', 'File not found: ' + serverConfigPath);
                    }
                } catch (e3) {
                    log('warn', 'Error reading server config.json: ' + e3.message);
                }
            }

            // Priority 3: plugin-local config.json (fallback)
            if (!raw) {
                try {
                    const pluginConfigFile = require(path.join(__dirname, 'config.json'));
                    if (pluginConfigFile && pluginConfigFile.pluginConfig) {
                        raw = pluginConfigFile.pluginConfig;
                        source = 'plugin/config.json (fallback)';
                    }
                } catch (e2) {
                    log('warn', 'Could not read plugin config.json: ' + e2.message);
                }
            }

            if (!raw) {
                log('warn',
                    'No configuration found — using defaults. ' +
                    'Add "pluginsConfig.deviceprovisioner" to meshcentral-data/config.json'
                );
            } else {
                log('info', 'Configuration loaded from: ' + source);
            }

            // Merge with defaults
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

            // Apply hardcoded IDs if provided (skip name resolution)
            if (config.quarantineMeshId) quarantineMeshId = config.quarantineMeshId;
            if (config.productionMeshId) productionMeshId = config.productionMeshId;
            if (config.revokedMeshId) revokedMeshId = config.revokedMeshId;

        } catch (e) {
            log('error', 'Error loading configuration: ' + e.message);
        }
    }

    // =========================================================================
    // Mesh ID normalisation
    //
    // MeshCentral stores mesh IDs internally with a "mesh//" prefix, but
    // configuration files typically omit it. Always strip the prefix before
    // comparing to ensure consistent matching regardless of the source.
    // =========================================================================
    function normalizeMeshId(id) {
        if (!id) return null;
        return id.replace(/^mesh\/\//, '');
    }

    function meshIdsEqual(a, b) {
        return normalizeMeshId(a) === normalizeMeshId(b);
    }

    // =========================================================================
    // Mesh ID resolver
    //
    // Resolves a group name to its internal mesh ID.
    // Tries the in-memory meshes object first (fast path), then falls back
    // to a database query. Calls onResolved(meshId) when done.
    // =========================================================================
    function resolveMeshIdByName(meshName, onResolved) {
        // Fast path: in-memory meshes map
        const meshes = parent.parent && parent.parent.meshes;
        if (meshes && typeof meshes === 'object') {
            for (const key of Object.keys(meshes)) {
                const m = meshes[key];
                if (m && (m.name || '').toLowerCase() === meshName.toLowerCase()) {
                    log('info', `Group "${meshName}" resolved from memory: ${m._id}`);
                    return onResolved(m._id);
                }
            }
        }

        // Slow path: database query
        const db = parent.parent && parent.parent.db;
        if (db && typeof db.GetAllMeshes === 'function') {
            db.GetAllMeshes('', function (err, meshList) {
                if (err || !meshList) {
                    log('error', `Error listing groups for "${meshName}": ` + (err || 'empty list'));
                    return onResolved(null);
                }
                const match = meshList.find(m =>
                    (m.name || '').toLowerCase() === meshName.toLowerCase()
                );
                if (!match) {
                    log('warn',
                        `Group "${meshName}" not found. ` +
                        'Create the group in MeshCentral and reload the plugin.'
                    );
                    return onResolved(null);
                }
                log('info', `Group "${meshName}" resolved from DB: ${match._id}`);
                onResolved(match._id);
            });
        } else {
            log('warn',
                `Cannot resolve group "${meshName}" — ` +
                'define the meshId directly in the plugin configuration.'
            );
            onResolved(null);
        }
    }

    function resolveQuarantineMeshId(callback) {
        if (quarantineMeshId) return callback(quarantineMeshId);
        resolveMeshIdByName(config.quarantineMeshName, callback);
    }

    function resolveRevokedMeshId(callback) {
        if (revokedMeshId) return callback(revokedMeshId);
        resolveMeshIdByName(config.revokedMeshName, callback);
    }

    // =========================================================================
    // Generic API caller with exponential-backoff retry
    //
    // @param {string} apiUrl   - Full URL of the endpoint to call
    // @param {object} payload  - JSON body to send
    // @param {string} nodeId   - MeshCentral node ID (for logging and retry key)
    // @param {number} attempt  - Current attempt number (1-based)
    // @param {string} label    - Human-readable label for log messages
    // =========================================================================
    function callApi(apiUrl, payload, nodeId, attempt, label) {
        if (!apiUrl) {
            log('warn', `${label}: URL not configured. Skipping API call.`);
            return;
        }

        attempt = attempt || 1;
        log('info', `${label}: calling API (attempt ${attempt}) for ${nodeId}`, payload);

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
                    log('info', `${label}: API returned ${res.statusCode} for ${nodeId}`);
                    delete pendingRetries[`${label}-${nodeId}`];
                } else {
                    log('warn',
                        `${label}: API returned ${res.statusCode} for ${nodeId}. ` +
                        `Body: ${data}`
                    );
                    scheduleRetry(apiUrl, payload, nodeId, attempt, label);
                }
            });
        });

        req.on('timeout', function () {
            req.destroy();
            log('warn', `${label}: request timed out for ${nodeId}`);
            scheduleRetry(apiUrl, payload, nodeId, attempt, label);
        });

        req.on('error', function (e) {
            log('error', `${label}: request error for ${nodeId}: ${e.message}`);
            scheduleRetry(apiUrl, payload, nodeId, attempt, label);
        });

        req.write(body);
        req.end();
    }

    /**
     * Schedules a retry for a failed API call using exponential backoff.
     * Gives up after config.maxRetries attempts.
     */
    function scheduleRetry(apiUrl, payload, nodeId, attempt, label) {
        const key = `${label}-${nodeId}`;
        if (!config.retryOnFailure || attempt >= config.maxRetries) {
            log('error',
                `${label}: max retries reached for ${nodeId}. Giving up.`
            );
            delete pendingRetries[key];
            return;
        }
        const delay = Math.min(30000, 5000 * attempt);
        log('info',
            `${label}: retrying in ${delay / 1000}s for ${nodeId} ` +
            `(attempt ${attempt + 1}/${config.maxRetries})`
        );
        pendingRetries[key] = { attempt, payload };
        setTimeout(function () {
            callApi(apiUrl, payload, nodeId, attempt + 1, label);
        }, delay);
    }

    /** Convenience wrapper for the provisioning (commissioning) API. */
    function callProvisioningApi(payload, nodeId, attempt) {
        callApi(config.provisioningApiUrl, payload, nodeId, attempt, 'PROVISIONING');
    }

    // =========================================================================
    // Payload builders
    //
    // Both payloads share the same base structure. The commissioning payload
    // uses event "device_approved"; the revocation payload uses "device_revoked"
    // and adds a top-level "serial" field used by the proxy to remove the device
    // from the pre-approved list in the Serial Vault database.
    //
    // Hardware fields are extracted from the MeshCentral sysinfo document
    // (stored as "si" + nodeId in the database). For Raspberry Pi / Linux
    // devices, the relevant fields are board_serial and board_name from
    // hardware.identifiers. Windows agents expose additional fields (macs,
    // cpus, memory, storage) which are included when present.
    // =========================================================================

    /**
     * Builds the commissioning payload for a device node.
     *
     * @param {object} node     - MeshCentral node document from the database
     * @param {object} sysinfo  - MeshCentral sysinfo document (may be null)
     * @returns {object} payload
     */
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
                // Raspberry Pi / Linux: board_serial and board_name
                serial_number: ids.board_serial || ids.product_serial || null,
                product_name: ids.board_name || ids.product_name || null,
                board_vendor: ids.board_vendor || null,
                uuid: ids.product_uuid || null,
                cpu_name: ids.cpu_name || null,
                bios_mode: ids.bios_mode || null,
                // Windows agents provide additional fields
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

    /**
     * Builds the revocation payload for a device node.
     * Extends the base payload with event "device_revoked" and a top-level
     * "serial" field. The serial is extracted from hardware.identifiers,
     * device tags (format "serial:<value>"), or falls back to the node name.
     *
     * @param {object} node     - MeshCentral node document from the database
     * @param {object} sysinfo  - MeshCentral sysinfo document (may be null)
     * @returns {object} payload
     */
    function buildRevocationPayload(node, sysinfo) {
        const base = buildPayload(node, sysinfo);
        base.event = 'device_revoked';

        // Extract serial from the most reliable source available
        const hw = (sysinfo && sysinfo.hardware) || {};
        const serialFromHw = hw.identifiers && hw.identifiers.product_serial;
        const serialFromTags = node.tags && node.tags
            .find(t => t.startsWith('serial:'));

        base.serial = serialFromHw
            || (serialFromTags ? serialFromTags.replace('serial:', '') : null)
            || node.name
            || null;

        return base;
    }

    // =========================================================================
    // Device lifecycle processors
    // =========================================================================

    /**
     * Fetches the node and its sysinfo from the database, builds the
     * commissioning payload, and calls the provisioning API.
     *
     * @param {string} nodeId - MeshCentral node ID
     */
    function processApproval(nodeId) {
        parent.parent.db.Get(nodeId, function (err, nodes) {
            if (err || !nodes || nodes.length === 0) {
                log('error', `Cannot retrieve node ${nodeId} from DB: ${err}`);
                return;
            }
            const node = nodes[0];
            // Sysinfo is stored as "si" + nodeId
            // e.g. "sinode//ABC..." for nodeId "node//ABC..."
            const sysinfoId = 'si' + nodeId;
            parent.parent.db.Get(sysinfoId, function (err2, docs) {
                const sysinfo = (!err2 && docs && docs.length > 0) ? docs[0] : null;
                if (!sysinfo) {
                    log('warn',
                        `Sysinfo not found for ${nodeId} (tried ID: ${sysinfoId})`
                    );
                }
                const payload = buildPayload(node, sysinfo);
                callProvisioningApi(payload, nodeId, 1);
            });
        });
    }

    /**
     * Fetches the node and its sysinfo from the database, builds the
     * revocation payload, and calls the revocation API.
     *
     * @param {string} nodeId - MeshCentral node ID
     */
    function processRevocation(nodeId) {
        parent.parent.db.Get(nodeId, function (err, nodes) {
            if (err || !nodes || nodes.length === 0) {
                log('error',
                    `Revocation: cannot retrieve node ${nodeId} from DB: ${err}`
                );
                return;
            }
            const node = nodes[0];
            const sysinfoId = 'si' + nodeId;
            parent.parent.db.Get(sysinfoId, function (err2, docs) {
                const sysinfo = (!err2 && docs && docs.length > 0) ? docs[0] : null;
                const payload = buildRevocationPayload(node, sysinfo);
                log('info', `Revoking device: ${nodeId}`, payload);
                callApi(config.revocationApiUrl, payload, nodeId, 1, 'REVOCATION');
            });
        });
    }

    // =========================================================================
    // HOOK: server_startup
    //
    // Called by MeshCentral when the server starts. Loads configuration,
    // resolves group IDs, and starts the polling loop.
    // =========================================================================
    plugin.server_startup = function () {
        loadConfig();

        // Resolve quarantine group ID (retry once after 5s if not found)
        resolveQuarantineMeshId(function (meshId) {
            quarantineMeshId = meshId;
            if (!meshId) {
                log('warn',
                    'Quarantine group not resolved at startup — retrying in 5s.'
                );
                setTimeout(function () {
                    resolveQuarantineMeshId(id => { quarantineMeshId = id; });
                }, 5000);
            }
        });

        // Resolve revoked group ID (retry once after 5s if not found)
        resolveRevokedMeshId(function (meshId) {
            revokedMeshId = meshId;
            if (!meshId) {
                log('warn',
                    'Revoked group not resolved at startup — retrying in 5s.'
                );
                setTimeout(function () {
                    resolveRevokedMeshId(id => { revokedMeshId = id; });
                }, 5000);
            }
        });

        startPolling();
        log('info', 'DeviceProvisioner plugin started.');
    };

    // =========================================================================
    // Polling loop
    //
    // Polls the database every 5 seconds for all node documents and compares
    // each node's current meshid against its previously recorded meshid.
    //
    // Detected transitions:
    //   QUARANTINE → any group (not REVOKED) → commissioning
    //   QUARANTINE → REVOKED                 → revocation
    //   any group  → REVOKED                 → revocation
    //
    // The first time a node is seen it is recorded without triggering any
    // action, to avoid false positives on plugin startup.
    // =========================================================================
    let nodeLastMesh = {};
    let pollingTimer = null;

    function startPolling() {
        if (pollingTimer) return;
        pollingTimer = setInterval(pollForGroupChanges, 5000);
        log('info', 'Polling started (interval: 5s).');
    }

    function pollForGroupChanges() {
        // Wait until the quarantine group ID is resolved
        if (!quarantineMeshId) return;

        const db = parent.parent && parent.parent.db;
        if (!db || typeof db.GetAllType !== 'function') {
            log('warn', 'GetAllType not available on MeshCentral DB object.');
            return;
        }

        db.GetAllType('node', function (err, nodes) {
            if (err || !nodes) return;

            nodes.forEach(function (node) {
                // Only process nodes in the default domain
                if (node.domain !== '') return;

                const nodeId = node._id;
                const currentMesh = node.meshid;
                const prevMesh = nodeLastMesh[nodeId];

                // First time seeing this node — record and skip
                if (prevMesh === undefined) {
                    nodeLastMesh[nodeId] = currentMesh;
                    return;
                }

                // No change — skip
                if (prevMesh === currentMesh) return;

                // Group changed — update recorded state
                nodeLastMesh[nodeId] = currentMesh;
                log('info',
                    `[POLL] Node ${nodeId} moved from ${prevMesh} to ${currentMesh}`
                );
                log('debug',
                    `[POLL] Comparing: prev=${normalizeMeshId(prevMesh)} ` +
                    `quarantine=${normalizeMeshId(quarantineMeshId)} ` +
                    `revoked=${normalizeMeshId(revokedMeshId)}`
                );

                // Commissioning: left the quarantine group
                if (meshIdsEqual(prevMesh, quarantineMeshId) &&
                    !meshIdsEqual(currentMesh, quarantineMeshId)) {

                    // Special case: moved from quarantine directly to revoked
                    if (revokedMeshId && meshIdsEqual(currentMesh, revokedMeshId)) {
                        log('info',
                            `Device moved from quarantine directly to revoked: ${nodeId}`
                        );
                        processRevocation(nodeId);
                        return;
                    }

                    log('info', `Device commissioned via polling: ${nodeId}`);
                    processApproval(nodeId);
                    return;
                }

                // Revocation: moved to the revoked group from any other group
                if (revokedMeshId &&
                    meshIdsEqual(currentMesh, revokedMeshId) &&
                    !meshIdsEqual(prevMesh, revokedMeshId)) {
                    log('info',
                        `Device revoked via polling: ${nodeId} ` +
                        `(was in group ${prevMesh})`
                    );
                    processRevocation(nodeId);
                    return;
                }
            });
        });
    }

    /** Required by the MeshCentral plugin interface. */
    plugin.HandleEvent = function (event, domain) { };

    // =========================================================================
    // HOOK: hook_agentCoreIsStable
    //
    // Called by MeshCentral when an agent has connected and its core is stable.
    // Used here only for logging: identifies new quarantine devices and warns
    // about revoked devices attempting to reconnect.
    //
    // @param {object} meshAgent - MeshCentral agent object
    //   meshAgent.dbNodeKey  - node ID in the database
    //   meshAgent.dbMeshKey  - mesh (group) ID in the database
    // =========================================================================
    plugin.hook_agentCoreIsStable = function (meshAgent) {
        const nodeId = meshAgent.dbNodeKey;
        const meshId = meshAgent.dbMeshKey;

        if (meshIdsEqual(meshId, quarantineMeshId)) {
            log('info',
                `New device in quarantine: ${nodeId} (awaiting manual commissioning)`
            );
        } else if (revokedMeshId && meshIdsEqual(meshId, revokedMeshId)) {
            log('warn',
                `REVOKED device attempted to reconnect: ${nodeId} — ignoring`
            );
        } else {
            log('debug', `Agent online: ${nodeId} in group ${meshId}`);
        }
    };

    return plugin;
};