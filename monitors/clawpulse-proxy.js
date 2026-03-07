#!/usr/bin/env node

/**
 * ClawPulse proxy server
 *
 * Functions:
 * 1. Connect to OpenClaw Gateway and perform Ed25519 auth
 * 2. Receive Gateway events (agent, cron, approval, chat, health, etc.)
 * 3. Multi-session support
 * 4. Relay to browser via HTTP + SSE
 * 5. Supplemental polling via RPC
 */

const http = require('http');
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { Buffer } = require('buffer');

// ==================== 配置 ====================

const PROXY_PORT = 18790;
const GATEWAY_HOST = '127.0.0.1';
const GATEWAY_PORT = 18789;

const CONFIG_PATH = path.join(os.homedir(), '.openclaw', 'openclaw.json');
const IDENTITY_PATH = path.join(os.homedir(), '.openclaw', 'identity', 'device.json');

// ==================== 事件类型定义 ====================

const EVENT_TYPES = {
    AGENT: 'agent',
    CHAT: 'chat',
    PRESENCE: 'presence',
    CRON: 'cron',
    EXEC_APPROVAL_REQUESTED: 'exec.approval.requested',
    EXEC_APPROVAL_RESOLVED: 'exec.approval.resolved',
    HEALTH: 'health',
    TICK: 'tick',
    CONNECT_CHALLENGE: 'connect.challenge',
    DEVICE_PAIR_REQUESTED: 'device.pair.requested',
    DEVICE_PAIR_RESOLVED: 'device.pair.resolved'
};

// ==================== 加载配置 ====================

let config, identity;

try {
    config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    identity = JSON.parse(fs.readFileSync(IDENTITY_PATH, 'utf8'));
    console.log('✅ 配置和身份加载成功');
} catch (err) {
    console.error('❌ 无法加载配置:', err.message);
    console.error('Please ensure OpenClaw is configured correctly.');
    process.exit(1);
}

// ==================== WebSocket 客户端实现 ====================

class WebSocketClient {
    constructor(host, port) {
        this.host = host;
        this.port = port;
        this.socket = null;
        this.connected = false;
        this.messageQueue = [];
        this.frameBuffer = Buffer.alloc(0);

        this.onopen = null;
        this.onmessage = null;
        this.onclose = null;
        this.onerror = null;
    }

    connect() {
        const net = require('net');
        this.socket = net.createConnection(this.port, this.host);

        this.socket.on('connect', () => {
            console.log('📡 TCP 连接成功，发起 WebSocket 握手...');
            this.performHandshake();
        });

        this.socket.on('data', (chunk) => {
            if (!this.connected) {
                const response = chunk.toString();
                if (response.includes('101 Switching Protocols')) {
                    console.log('✅ WebSocket 握手成功');
                    this.connected = true;
                    if (this.onopen) this.onopen();

                    while (this.messageQueue.length > 0) {
                        const msg = this.messageQueue.shift();
                        this.sendRaw(msg);
                    }
                }
            } else {
                this.handleFrame(chunk);
            }
        });

        this.socket.on('error', (err) => {
            console.error('❌ Socket 错误:', err.message);
            if (this.onerror) this.onerror(err);
        });

        this.socket.on('close', () => {
            console.log('⚠️ Socket 关闭');
            this.connected = false;
            if (this.onclose) this.onclose();
        });
    }

    performHandshake() {
        const key = crypto.randomBytes(16).toString('base64');
        const handshake = [
            `GET / HTTP/1.1`,
            `Host: ${this.host}:${this.port}`,
            `Upgrade: websocket`,
            `Connection: Upgrade`,
            `Sec-WebSocket-Key: ${key}`,
            `Sec-WebSocket-Version: 13`,
            ``,
            ``
        ].join('\r\n');

        this.socket.write(handshake);
    }

    handleFrame(chunk) {
        this.frameBuffer = Buffer.concat([this.frameBuffer, chunk]);

        while (this.frameBuffer.length >= 2) {
            const byte1 = this.frameBuffer[0];
            const byte2 = this.frameBuffer[1];

            const fin = (byte1 & 0x80) !== 0;
            const opcode = byte1 & 0x0F;
            const masked = (byte2 & 0x80) !== 0;
            let payloadLen = byte2 & 0x7F;

            let offset = 2;

            if (payloadLen === 126) {
                if (this.frameBuffer.length < 4) return;
                payloadLen = this.frameBuffer.readUInt16BE(2);
                offset = 4;
            } else if (payloadLen === 127) {
                if (this.frameBuffer.length < 10) return;
                payloadLen = Number(this.frameBuffer.readBigUInt64BE(2));
                offset = 10;
            }

            if (masked) {
                offset += 4;
            }

            if (this.frameBuffer.length < offset + payloadLen) {
                return;
            }

            let payload = this.frameBuffer.slice(offset, offset + payloadLen);

            if (masked) {
                const maskKey = this.frameBuffer.slice(offset - 4, offset);
                for (let i = 0; i < payload.length; i++) {
                    payload[i] ^= maskKey[i % 4];
                }
            }

            this.frameBuffer = this.frameBuffer.slice(offset + payloadLen);

            if (opcode === 0x01) {
                const message = payload.toString('utf8');
                if (this.onmessage) {
                    this.onmessage({ data: message });
                }
            } else if (opcode === 0x08) {
                console.log('收到关闭帧');
                this.socket.end();
            } else if (opcode === 0x09) {
                this.sendPong(payload);
            }
        }
    }

    send(data) {
        if (!this.connected) {
            this.messageQueue.push(data);
            return;
        }
        this.sendRaw(data);
    }

    sendRaw(data) {
        const payload = Buffer.from(data, 'utf8');
        const frame = Buffer.allocUnsafe(10 + payload.length);

        frame[0] = 0x81;

        if (payload.length < 126) {
            frame[1] = 0x80 | payload.length;
            const mask = crypto.randomBytes(4);
            mask.copy(frame, 2);
            for (let i = 0; i < payload.length; i++) {
                frame[6 + i] = payload[i] ^ mask[i % 4];
            }
            this.socket.write(frame.slice(0, 6 + payload.length));
        } else if (payload.length < 65536) {
            frame[1] = 0x80 | 126;
            frame.writeUInt16BE(payload.length, 2);
            const mask = crypto.randomBytes(4);
            mask.copy(frame, 4);
            for (let i = 0; i < payload.length; i++) {
                frame[8 + i] = payload[i] ^ mask[i % 4];
            }
            this.socket.write(frame.slice(0, 8 + payload.length));
        } else {
            frame[1] = 0x80 | 127;
            frame.writeBigUInt64BE(BigInt(payload.length), 2);
            const mask = crypto.randomBytes(4);
            mask.copy(frame, 10);
            const maskedPayload = Buffer.allocUnsafe(payload.length);
            for (let i = 0; i < payload.length; i++) {
                maskedPayload[i] = payload[i] ^ mask[i % 4];
            }
            this.socket.write(Buffer.concat([frame.slice(0, 14), maskedPayload]));
        }
    }

    sendPong(data) {
        const frame = Buffer.allocUnsafe(2 + data.length);
        frame[0] = 0x8A;
        frame[1] = data.length;
        data.copy(frame, 2);
        this.socket.write(frame);
    }

    close() {
        if (this.socket) {
            this.socket.end();
        }
    }
}

// ==================== 状态管理 ====================

let gatewayWs = null;
let gatewayConnected = false;
let gatewayNonce = null;
let reconnectTimer = null;

const browserClients = new Set();
const eventHistory = [];
const MAX_HISTORY = 500;

// Session 管理
const sessions = new Map();

// Cron 任务管理
const cronJobs = new Map();

// Approval 请求管理
const approvalRequests = new Map();

// 统计信息
const stats = {
    totalEvents: 0,
    agentEvents: 0,
    cronEvents: 0,
    approvalEvents: 0,
    chatEvents: 0,
    sessions: 0,
    startTime: Date.now()
};

// ==================== Gateway 连接管理 ====================

function connectToGateway() {
    console.log('\n🔄 连接到 Gateway:', `ws://${GATEWAY_HOST}:${GATEWAY_PORT}`);

    if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
    }

    gatewayWs = new WebSocketClient(GATEWAY_HOST, GATEWAY_PORT);

    gatewayWs.onopen = () => {
        console.log('✅ Gateway WebSocket 连接建立');
    };

    gatewayWs.onmessage = (event) => {
        try {
            const frame = JSON.parse(event.data);
            handleGatewayMessage(frame);
        } catch (err) {
            console.error('❌ 解析 Gateway 消息失败:', err.message);
        }
    };

    gatewayWs.onerror = (err) => {
        console.error('❌ Gateway 连接错误:', err.message);
    };

    gatewayWs.onclose = () => {
        console.log('⚠️ Gateway 连接断开');
        gatewayConnected = false;
        broadcastToBrowsers({
            type: 'system',
            event: 'gateway_disconnected',
            message: 'Gateway 连接断开，3秒后重连...'
        });

        reconnectTimer = setTimeout(() => {
            console.log('🔄 尝试重新连接...');
            connectToGateway();
        }, 3000);
    };

    gatewayWs.connect();
}

// ==================== Gateway 消息处理 ====================

function handleGatewayMessage(frame) {
    stats.totalEvents++;

    // 处理认证挑战
    if (frame.event === EVENT_TYPES.CONNECT_CHALLENGE) {
        console.log('📨 收到认证挑战');
        gatewayNonce = frame.payload?.nonce;
        console.log('🔑 Nonce:', gatewayNonce);
        if (gatewayNonce) {
            console.log('⏰ 立即发送认证请求...');
            sendConnectRequest();
        } else {
            console.error('❌ Challenge 中没有 nonce');
        }
        return;
    }

    // 处理连接响应
    if (frame.type === 'res' && frame.payload?.type === 'hello-ok') {
        console.log('✅ Gateway 认证成功！');
        console.log('📡 开始接收所有事件...\n');
        gatewayConnected = true;

        broadcastToBrowsers({
            type: 'system',
            event: 'gateway_connected',
            message: 'Gateway 认证成功'
        });

        // 启动定期轮询
        startPeriodicPolling();

        // Start JSONL file tailing (for tool events)
        startJsonlWatcher();
        return;
    }

    // 处理各类事件
    if (gatewayConnected) {
        switch (frame.event) {
            case EVENT_TYPES.AGENT:
                handleAgentEvent(frame);
                break;
            case EVENT_TYPES.CRON:
                handleCronEvent(frame);
                break;
            case EVENT_TYPES.EXEC_APPROVAL_REQUESTED:
                handleApprovalRequested(frame);
                break;
            case EVENT_TYPES.EXEC_APPROVAL_RESOLVED:
                handleApprovalResolved(frame);
                break;
            case EVENT_TYPES.CHAT:
                handleChatEvent(frame);
                break;
            case EVENT_TYPES.HEALTH:
            case EVENT_TYPES.TICK:
            case EVENT_TYPES.PRESENCE:
            case EVENT_TYPES.DEVICE_PAIR_REQUESTED:
            case EVENT_TYPES.DEVICE_PAIR_RESOLVED:
                handleOtherEvent(frame);
                break;
            default:
                // 未知事件，仍然转发
                handleOtherEvent(frame);
        }

        // 记录历史
        eventHistory.push({
            timestamp: Date.now(),
            frame: frame
        });
        if (eventHistory.length > MAX_HISTORY) {
            eventHistory.shift();
        }
    }
}

// ==================== 事件处理函数 ====================

function handleAgentEvent(frame) {
    stats.agentEvents++;
    const payload = frame.payload;
    const sessionId = payload.sessionId || 'main';

    // 更新或创建 session
    if (!sessions.has(sessionId)) {
        const sessionInfo = {
            id: sessionId,
            type: detectSessionType(payload),
            createdAt: Date.now(),
            status: 'active',
            runId: payload.runId,
            parentRunId: payload.parentRunId,
            cronId: payload.cronId
        };
        sessions.set(sessionId, sessionInfo);
        stats.sessions = sessions.size;
        console.log(`📌 新 Session: ${sessionId} (${sessionInfo.type})`);
    }

    const sessionInfo = sessions.get(sessionId);

    // 更新 session 状态
    if (payload.stream === 'lifecycle') {
        if (payload.data.phase === 'end' || payload.data.phase === 'error') {
            sessionInfo.status = 'completed';
            sessionInfo.completedAt = Date.now();
        }
    }

    // 附加 session 信息后转发
    broadcastToBrowsers({
        ...frame,
        sessionInfo: sessionInfo,
        allSessions: Array.from(sessions.values())
    });

    // 日志输出
    logAgentEvent(payload, sessionId);
}

function detectSessionType(payload) {
    if (payload.parentRunId) return 'sub-agent';
    if (payload.cronId) return 'cron';
    return 'main';
}

function handleCronEvent(frame) {
    stats.cronEvents++;
    const payload = frame.payload;
    const cronId = payload.cronId;

    if (!cronJobs.has(cronId)) {
        cronJobs.set(cronId, {
            id: cronId,
            name: payload.name,
            schedule: payload.schedule,
            history: [],
            lastStatus: null,
            lastRun: null
        });
        console.log(`⏰ 新 Cron 任务: ${payload.name} (${payload.schedule})`);
    }

    const cron = cronJobs.get(cronId);
    const historyEntry = {
        status: payload.status,
        timestamp: Date.now(),
        startedAt: payload.startedAt,
        completedAt: payload.completedAt,
        error: payload.error
    };

    cron.history.push(historyEntry);
    cron.lastStatus = payload.status;
    cron.lastRun = Date.now();

    // 保留最近 50 条历史
    if (cron.history.length > 50) {
        cron.history.shift();
    }

    const statusIcon = {
        'triggered': '⏰',
        'running': '▶️',
        'completed': '✅',
        'failed': '❌'
    };

    console.log(`${statusIcon[payload.status] || '📋'} [${payload.name}] ${payload.status}`);

    // 转发带完整信息的事件
    broadcastToBrowsers({
        ...frame,
        cronInfo: cron,
        allCrons: Array.from(cronJobs.values())
    });
}

function handleApprovalRequested(frame) {
    stats.approvalEvents++;
    const payload = frame.payload;
    const approvalId = payload.approvalId;

    const approval = {
        id: approvalId,
        command: payload.command,
        context: payload.context,
        requestedAt: payload.requestedAt,
        expiresAt: payload.expiresAt,
        status: 'pending',
        remainingSeconds: Math.floor((payload.expiresAt - Date.now()) / 1000)
    };

    approvalRequests.set(approvalId, approval);

    console.log(`🔐 审批请求: ${payload.command}`);
    console.log(`   上下文: ${payload.context}`);
    console.log(`   过期: ${new Date(payload.expiresAt).toLocaleTimeString()} (${approval.remainingSeconds}秒)`);

    broadcastToBrowsers({
        ...frame,
        approvalInfo: approval,
        allApprovals: Array.from(approvalRequests.values())
    });
}

function handleApprovalResolved(frame) {
    const payload = frame.payload;
    const approvalId = payload.approvalId;

    if (approvalRequests.has(approvalId)) {
        const approval = approvalRequests.get(approvalId);
        approval.status = payload.approved ? 'approved' : 'rejected';
        approval.resolvedAt = payload.resolvedAt;
        approval.resolvedBy = payload.resolvedBy;

        console.log(`🔐 审批结果: ${approval.command}`);
        console.log(`   ${payload.approved ? '✅ 通过' : '❌ 拒绝'} (by ${approval.resolvedBy || 'unknown'})`);

        // 5 秒后从列表移除
        setTimeout(() => {
            approvalRequests.delete(approvalId);
        }, 5000);
    }

    broadcastToBrowsers({
        ...frame,
        allApprovals: Array.from(approvalRequests.values())
    });
}

function handleChatEvent(frame) {
    stats.chatEvents++;
    const payload = frame.payload;

    const directionIcon = payload.direction === 'incoming' ? '📥' : '📤';
    const stateIcon = {
        'queued': '⏳',
        'running': '▶️',
        'done': '✅'
    };

    console.log(`💬 [${payload.channel}] ${directionIcon} ${stateIcon[payload.state] || '📋'} ${payload.state}`);

    broadcastToBrowsers(frame);
}

function handleOtherEvent(frame) {
    console.log(`📥 [${frame.event}]`, JSON.stringify(frame).substring(0, 150));
    broadcastToBrowsers(frame);
}

// ==================== 日志输出 ====================

function logAgentEvent(payload, sessionId) {
    const runIdShort = payload.runId ? payload.runId.substring(0, 8) : '?';
    const sessionPrefix = sessionId === 'main' ? '' : `[${sessionId.substring(0, 8)}] `;

    if (payload.stream === 'lifecycle') {
        console.log(`🔵 ${sessionPrefix}[${runIdShort}] lifecycle.${payload.data.phase}`);
    } else if (payload.stream === 'assistant') {
        const text = payload.data.text || payload.data.delta || '';
        if (text.length > 50) {
            console.log(`💭 ${sessionPrefix}[${runIdShort}] assistant: ${text.length} 字符`);
        } else if (text.length > 0) {
            console.log(`💭 ${sessionPrefix}[${runIdShort}] assistant: ${text}`);
        }
    } else if (payload.stream === 'tool') {
        const phase = payload.data.phase;
        const name = payload.data.name;
        console.log(`🔧 ${sessionPrefix}[${runIdShort}] tool.${phase}: ${name || '?'}`);
    } else if (payload.stream === 'compaction') {
        const phase = payload.data.phase;
        const ratio = payload.data.compressionRatio;
        console.log(`🗜️  ${sessionPrefix}[${runIdShort}] compaction.${phase}${ratio ? ` (${ratio.toFixed(2)}x)` : ''}`);
    } else if (payload.stream === 'error') {
        const error = payload.data.error;
        console.log(`❌ ${sessionPrefix}[${runIdShort}] error: ${error}`);
    }
}

// ==================== 认证 ====================

function sendConnectRequest() {
    const authToken = config.gateway?.auth?.token || '';
    const deviceId = identity.deviceId;
    const privateKeyPem = identity.privateKeyPem;
    const publicKeyPem = identity.publicKeyPem;

    const signedAtMs = Date.now();
    const version = 'v2';
    const clientId = 'openclaw-probe';
    const clientMode = 'backend';  // backend 模式接收完整事件
    const role = 'operator';
    const scopes = ['operator.admin'];

    const payload = [
        version,
        deviceId,
        clientId,
        clientMode,
        role,
        scopes.join(','),
        String(signedAtMs),
        authToken,
        gatewayNonce
    ].join('|');

    console.log('📝 构建签名 payload...');

    const key = crypto.createPrivateKey(privateKeyPem);
    const sig = crypto.sign(null, Buffer.from(payload, 'utf8'), key);
    const signature = sig.toString('base64url');

    const pubKeyDer = crypto.createPublicKey(publicKeyPem).export({
        type: 'spki',
        format: 'der'
    });
    const publicKeyRaw = pubKeyDer.slice(12).toString('base64url');

    const connectRequest = {
        type: 'req',
        id: crypto.randomUUID(),
        method: 'connect',
        params: {
            minProtocol: 3,
            maxProtocol: 3,
            client: {
                id: clientId,
                displayName: 'ClawPulse',
                version: '6.0.0',
                platform: process.platform,
                mode: clientMode
            },
            role: role,
            scopes: scopes,
            auth: {
                token: authToken
            },
            device: {
                id: deviceId,
                publicKey: publicKeyRaw,
                signature: signature,
                signedAt: signedAtMs,
                nonce: gatewayNonce
            }
        }
    };

    console.log('📤 发送认证请求...');
    gatewayWs.send(JSON.stringify(connectRequest));
    console.log('✅ 请求已发送');
}

// ==================== RPC 支持 ====================

function sendRpcRequest(method, params = {}) {
    if (!gatewayConnected) return;

    const request = {
        type: 'req',
        id: crypto.randomUUID(),
        method,
        params
    };

    console.log(`📞 RPC: ${method}`);
    gatewayWs.send(JSON.stringify(request));
}

function startPeriodicPolling() {
    // 每 30 秒轮询一次
    setInterval(() => {
        if (gatewayConnected) {
            sendRpcRequest('sessions.list');
            sendRpcRequest('health');
        }
    }, 30000);

    console.log('⏰ 启动定期 RPC 轮询 (30秒)');
}

// ==================== JSONL Tool event tailing ====================
// Gateway WebSocket 不推送 tool stream 事件，所以我们直接 tail session JSONL 文件

let jsonlWatcher = null;
let jsonlFileSize = 0;
let watchedSessionFile = null;

function startJsonlWatcher() {
    const sessionsDir = path.join(os.homedir(), '.openclaw', 'agents', 'main', 'sessions');

    // 找最新的 session 文件
    function findActiveSession() {
        try {
            const files = fs.readdirSync(sessionsDir)
                .filter(f => f.endsWith('.jsonl'))
                .map(f => ({ name: f, mtime: fs.statSync(path.join(sessionsDir, f)).mtimeMs }))
                .sort((a, b) => b.mtime - a.mtime);
            return files.length > 0 ? path.join(sessionsDir, files[0].name) : null;
        } catch(e) { return null; }
    }

    function watchFile(filePath) {
        if (watchedSessionFile === filePath && jsonlWatcher) return;

        // 清理旧 watcher
        if (jsonlWatcher) {
            jsonlWatcher.close();
            jsonlWatcher = null;
        }

        watchedSessionFile = filePath;
        try {
            jsonlFileSize = fs.statSync(filePath).size;
        } catch(e) {
            jsonlFileSize = 0;
        }

        console.log(`📄 Tailing JSONL: ${path.basename(filePath)}`);

        jsonlWatcher = fs.watch(filePath, (eventType) => {
            if (eventType !== 'change') return;

            try {
                const newSize = fs.statSync(filePath).size;
                if (newSize <= jsonlFileSize) return;

                // 读取新增内容
                const fd = fs.openSync(filePath, 'r');
                const buf = Buffer.alloc(newSize - jsonlFileSize);
                fs.readSync(fd, buf, 0, buf.length, jsonlFileSize);
                fs.closeSync(fd);
                jsonlFileSize = newSize;

                const newLines = buf.toString('utf8').split('\n').filter(l => l.trim());

                for (const line of newLines) {
                    try {
                        const entry = JSON.parse(line);
                        if (entry.type !== 'message') continue;
                        const msg = entry.message;
                        if (!msg) continue;

                        // toolCall → tool start
                        if (msg.role === 'assistant' && Array.isArray(msg.content)) {
                            for (const block of msg.content) {
                                if (block.type === 'toolCall') {
                                    const toolEvent = {
                                        type: 'event',
                                        event: 'agent',
                                        payload: {
                                            stream: 'tool',
                                            data: {
                                                phase: 'start',
                                                name: block.name,
                                                callId: block.id,
                                                params: block.arguments || block.params || {}  // JSONL中使用arguments字段
                                            },
                                            runId: entry.id,
                                            sessionKey: 'agent:main:main'
                                        }
                                    };
                                    broadcastToBrowsers(toolEvent);
                                    const argsStr = block.arguments ? JSON.stringify(block.arguments).substring(0, 100) : '';
                                    console.log(`🔧 tool.start: ${block.name}`, argsStr ? `params: ${argsStr}` : '');
                                }
                            }
                        }

                        // toolResult → tool end
                        if (msg.role === 'toolResult') {
                            let resultText = '';
                            if (Array.isArray(msg.content)) {
                                for (const c of msg.content) {
                                    if (c && typeof c === 'object') resultText += (c.text || '');
                                }
                            }
                            const isNoOutput = resultText.trim() === '(no output)';
                            const isError = msg.isError === true;

                            const toolEvent = {
                                type: 'event',
                                event: 'agent',
                                payload: {
                                    stream: 'tool',
                                    data: {
                                        phase: 'end',
                                        name: msg.toolName,
                                        callId: msg.toolCallId,
                                        status: isError ? 'error' : isNoOutput ? 'no_output' : 'success',
                                        result: resultText,  // 添加完整结果
                                        error: msg.isError ? (msg.error || resultText) : null  // 添加错误信息
                                    },
                                    runId: entry.id,
                                    sessionKey: 'agent:main:main'
                                }
                            };
                            broadcastToBrowsers(toolEvent);
                            console.log(`🔧 tool.end: ${msg.toolName} [${isError ? 'error' : isNoOutput ? 'no_output' : 'ok'}] result: ${resultText.substring(0, 100)}`);
                        }
                    } catch(e) { /* skip malformed lines */ }
                }
            } catch(e) {
                // file might be temporarily locked
            }
        });
    }

    // Initial tailing
    const activeFile = findActiveSession();
    if (activeFile) watchFile(activeFile);

    // 定期检查是否有新的 session 文件
    setInterval(() => {
        const activeFile = findActiveSession();
        if (activeFile && activeFile !== watchedSessionFile) {
            console.log(`📄 切换到新 session: ${path.basename(activeFile)}`);
            watchFile(activeFile);
        }
    }, 5000);
}

// ==================== 浏览器客户端管理 ====================

function broadcastToBrowsers(data) {
    const message = `data: ${JSON.stringify(data)}\n\n`;

    browserClients.forEach(res => {
        try {
            res.write(message);
        } catch (err) {
            // 忽略写入失败
        }
    });
}

// ==================== HTTP 服务器 ====================

const server = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        res.writeHead(200);
        res.end();
        return;
    }

    if (req.url === '/events') {
        // SSE 端点
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no'
        });

        console.log('🌐 浏览器客户端连接');
        browserClients.add(res);

        // 发送初始状态
        res.write(`data: ${JSON.stringify({
            type: 'system',
            event: 'connected',
            message: gatewayConnected ? 'Gateway 已连接' : '等待 Gateway 连接...',
            gatewayConnected: gatewayConnected,
            stats: stats,
            sessions: Array.from(sessions.values()),
            crons: Array.from(cronJobs.values()),
            approvals: Array.from(approvalRequests.values())
        })}\n\n`);

        // 发送最近的历史事件
        const recentHistory = eventHistory.slice(-20);
        if (recentHistory.length > 0) {
            res.write(`data: ${JSON.stringify({
                type: 'system',
                event: 'history',
                data: recentHistory
            })}\n\n`);
        }

        req.on('close', () => {
            console.log('🌐 浏览器客户端断开');
            browserClients.delete(res);
        });

    } else if (req.url === '/status') {
        // 状态端点
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            gatewayConnected: gatewayConnected,
            browserClients: browserClients.size,
            eventHistorySize: eventHistory.length,
            stats: stats,
            sessions: Array.from(sessions.entries()).map(([id, info]) => ({
                id,
                type: info.type,
                status: info.status,
                duration: info.completedAt ?
                    info.completedAt - info.createdAt :
                    Date.now() - info.createdAt
            })),
            crons: Array.from(cronJobs.entries()).map(([id, cron]) => ({
                id,
                name: cron.name,
                schedule: cron.schedule,
                lastStatus: cron.lastStatus,
                lastRun: cron.lastRun,
                historyCount: cron.history.length
            })),
            approvals: Array.from(approvalRequests.values())
        }, null, 2));

    } else if (req.url === '/api/sessions') {
        // 列出所有 session JSONL 文件
        const sessionsDir = path.join(os.homedir(), '.openclaw', 'agents', 'main', 'sessions');
        try {
            const files = fs.readdirSync(sessionsDir).filter(f => f.endsWith('.jsonl'));
            const sessionList = files.map(f => {
                const filePath = path.join(sessionsDir, f);
                const stat = fs.statSync(filePath);
                // 读第一行获取 session 元信息
                let meta = {};
                try {
                    const fd = fs.openSync(filePath, 'r');
                    const buf = Buffer.alloc(1024);
                    const bytesRead = fs.readSync(fd, buf, 0, 1024, 0);
                    fs.closeSync(fd);
                    const firstLine = buf.slice(0, bytesRead).toString().split('\n')[0];
                    meta = JSON.parse(firstLine);
                } catch(e) {}
                return {
                    id: f.replace('.jsonl', ''),
                    file: f,
                    size: stat.size,
                    modified: stat.mtime.toISOString(),
                    timestamp: meta.timestamp || null,
                    type: meta.type || 'unknown'
                };
            }).sort((a, b) => new Date(b.modified) - new Date(a.modified));
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(sessionList));
        } catch(e) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: e.message }));
        }

    } else if (req.url.startsWith('/api/sessions/') && req.url.endsWith('/events')) {
        // 解析指定 session 的 tool call 历史
        const sessionId = req.url.replace('/api/sessions/', '').replace('/events', '');
        const sessionsDir = path.join(os.homedir(), '.openclaw', 'agents', 'main', 'sessions');
        const filePath = path.join(sessionsDir, sessionId + '.jsonl');

        if (!fs.existsSync(filePath)) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Session not found' }));
            return;
        }

        try {
            const content = fs.readFileSync(filePath, 'utf8');
            const lines = content.split('\n').filter(l => l.trim());
            const toolEvents = [];
            const lifecycleEvents = [];
            let sessionMeta = null;

            for (const line of lines) {
                try {
                    const entry = JSON.parse(line);

                    // Session 元信息
                    if (entry.type === 'session') {
                        sessionMeta = entry;
                        continue;
                    }

                    // 提取 toolCall 事件
                    if (entry.type === 'message' && entry.message) {
                        const msg = entry.message;
                        if (msg.role === 'assistant' && Array.isArray(msg.content)) {
                            for (const block of msg.content) {
                                if (block.type === 'toolCall') {
                                    toolEvents.push({
                                        phase: 'start',
                                        name: block.name,
                                        timestamp: entry.timestamp,
                                        callId: block.id
                                    });
                                }
                            }
                        }
                        if (msg.role === 'toolResult') {
                            // 提取结果文本判断状态
                            let resultText = '';
                            const content = msg.content;
                            if (Array.isArray(content)) {
                                for (const c of content) {
                                    if (c && typeof c === 'object') resultText += (c.text || '');
                                }
                            } else if (typeof content === 'string') {
                                resultText = content;
                            }
                            const isNoOutput = resultText.trim() === '(no output)';
                            const isError = msg.isError === true;
                            toolEvents.push({
                                phase: 'end',
                                name: msg.toolName,
                                timestamp: entry.timestamp,
                                callId: msg.toolCallId,
                                status: isError ? 'error' : isNoOutput ? 'no_output' : 'success'
                            });
                        }
                    }
                } catch(e) { /* skip malformed lines */ }
            }

            // 统计每个工具的调用次数和结果分布
            const toolCounts = {};
            const resultStats = { success: 0, no_output: 0, error: 0 };
            const toolResultDetails = {}; // tool -> {success, no_output, error}
            for (const evt of toolEvents) {
                if (evt.phase === 'start') {
                    toolCounts[evt.name] = (toolCounts[evt.name] || 0) + 1;
                }
                if (evt.phase === 'end' && evt.status) {
                    resultStats[evt.status] = (resultStats[evt.status] || 0) + 1;
                    if (!toolResultDetails[evt.name]) {
                        toolResultDetails[evt.name] = { success: 0, no_output: 0, error: 0 };
                    }
                    toolResultDetails[evt.name][evt.status]++;
                }
            }

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                sessionId,
                meta: sessionMeta,
                toolCounts,
                resultStats,
                toolResultDetails,
                totalToolCalls: Object.values(toolCounts).reduce((a, b) => a + b, 0),
                toolEvents: toolEvents.slice(-200),
                eventCount: toolEvents.length
            }));
        } catch(e) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: e.message }));
        }

    } else if (req.url === '/' || req.url === '/monitor') {
        // Default dashboard page
        const htmlPath = path.join(__dirname, 'clawpulse.html');
        try {
            const html = fs.readFileSync(htmlPath, 'utf8');
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(html);
        } catch (e) {
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            res.end('ClawPulse HTML not found: ' + htmlPath);
        }

    } else {
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        const uptime = Math.floor((Date.now() - stats.startTime) / 1000);
        res.end(`ClawPulse proxy server

状态:
  Gateway 连接: ${gatewayConnected ? '✅ 已连接' : '❌ 未连接'}
  浏览器客户端: ${browserClients.size}
  运行时间: ${uptime}秒

统计:
  总事件数: ${stats.totalEvents}
  Agent 事件: ${stats.agentEvents}
  Cron 事件: ${stats.cronEvents}
  Approval 事件: ${stats.approvalEvents}
  Chat 事件: ${stats.chatEvents}
  活跃 Sessions: ${stats.sessions}

Sessions:
${Array.from(sessions.values()).map(s =>
    `  - ${s.id}: ${s.type} (${s.status})`
).join('\n') || '  无'}

Cron 任务:
${Array.from(cronJobs.values()).map(c =>
    `  - ${c.name}: ${c.lastStatus || 'N/A'} (${c.schedule})`
).join('\n') || '  无'}

待审批:
${Array.from(approvalRequests.values()).map(a =>
    `  - ${a.command} (${a.status})`
).join('\n') || '  无'}

端点:
  /events  - SSE 事件流
  /status  - JSON 状态
`);
    }
});

// ==================== 启动服务器 ====================

server.listen(PROXY_PORT, '127.0.0.1', () => {
    console.log('\n' + '='.repeat(60));
    console.log('🚀 ClawPulse proxy started');
    console.log('='.repeat(60));
    console.log(`📡 Listening: ${PROXY_PORT}`);
    console.log(`🖥️  Dashboard: http://127.0.0.1:${PROXY_PORT}/`);
    console.log(`🔗 Events: http://127.0.0.1:${PROXY_PORT}/events`);
    console.log(`📊 Status: http://127.0.0.1:${PROXY_PORT}/status`);
    console.log('='.repeat(60));

    // Connect to Gateway
    connectToGateway();
});

// ==================== 优雅退出 ====================

process.on('SIGINT', () => {
    console.log('\n\n👋 关闭服务器...');
    if (gatewayWs) {
        gatewayWs.close();
    }
    if (reconnectTimer) {
        clearTimeout(reconnectTimer);
    }
    server.close();
    process.exit(0);
});

process.on('uncaughtException', (err) => {
    console.error('❌ 未捕获的异常:', err);
});

process.on('unhandledRejection', (reason) => {
    console.error('❌ 未处理的 Promise 拒绝:', reason);
});
