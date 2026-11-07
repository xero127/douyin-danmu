// ==UserScript==
// @name         抖音直播后台依旧加载弹幕-摸鱼奎恩 | Douyin Live
// @name:zh      抖音直播后台依旧加载弹幕-摸鱼奎恩 | Douyin Live
// @name:en      Douyin Live Chat Keeps Loading in Background - Mr.Quin | Douyin Live
// @namespace    http://tampermonkey.net/
// @version      2.0
// @description  [支持抖音直播画面显示到b站]直播间页面在后台时依旧能加载弹幕、去除挂机时的节能暂停播放
// @description:en  [Show Douyin live video on Bilibili] Live room pages keep loading chat in the background and prevent energy-saving playback pauses while idle.
// @author       xero127
// @icon         https://p-pc-weboff.byteimg.com/tos-cn-i-9r5gewecjs/favicon.png
// @match        *://live.bilibili.com/*
// @match        *://live.douyin.com/*
// @require      https://cdn.jsdelivr.net/npm/mpegts.js@1.8.2/dist/mpegts.min.js
// @require      https://cdn.jsdelivr.net/npm/hls.js@1.7.2/dist/hls.min.js
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// @grant        GM_addValueChangeListener
// @grant        GM_addStyle
// @grant        unsafeWindow
// @run-at       document-start
// @noframes
// @license      MIT
// ==/UserScript==

// 2.0 修复：切换页面不清空B站弹幕，保留后台保护并同步原生弹幕时钟。
// 1.9 修复：脚本追加的抖音音量按钮在 B 站播放器控制栏自动隐藏后仍常驻画面。
// 1.8.1 修复：分屏模式下进出全屏 / 从全屏游戏切回浏览器后，B 站播放器重建 video
// 或替换播放器容器导致分屏错位（B 站画面仍占满全屏、抖音画面压在下半屏）。

// 第三方库说明
// 引入 mpegts.js 播放器内核：用于在B站页面解码播放抖音的 FLV 格式直播流
// 引入 hls.js 播放器内核：用于在B站页面解码播放抖音的 HLS (.m3u8) 格式直播流
/* global mpegts, Hls */ // mpegts/Hls 来自 @require；unsafeWindow 已由油猴/ESLint 环境内置，不能重复声明

(function () {
    'use strict';//严格模式

    // 只在顶层直播页面注册菜单和面板，避免 iframe 实例同时响应油猴菜单。
    if (window.self !== window.top) return;

    const IS_BILI = location.hostname.includes('live.bilibili.com');
    const IS_DOUYIN = location.hostname.includes('live.douyin.com');

    // B站首页和分类页也匹配域名，但不应运行直播间播放器及防休眠逻辑。
    if (IS_BILI && !/^\/(?:blanc\/)?\d+\/?$/.test(location.pathname)) return;

    const DEFAULT_BILI_URL = 'https://live.bilibili.com/545318';
    const DEFAULT_DY_URL = 'https://live.douyin.com/200525029536';
    // 抖音网页端 LLS/RTM 播放内核。固定到已验证的构建，避免每次打开直播间
    // 都因 CDN 上游变更而得到不可预测的播放器行为。
    // 旧 77147f6a 构建在实测的部分 LLS 音轨上创建 96 kHz 上下文；
    // 此构建与抖音当前网页一致，同源对照为 48 kHz，避免沿用异常音频路径。
    const LLS_PLAYER_SCRIPT_URL = 'https://lf-webcast-platform.bytetos.com/obj/webcast-platform-cdn/webcast/douyin_live//libs/new-player-merged.91d4e3c1.js';

    // @run-at document-start 时通常尚未有 body；脚本更新或 SPA 返回时也可能已经完成加载。
    // 统一用这个入口，避免只监听 DOMContentLoaded 而错过初始化。
    const whenDocumentReady = (callback) => {
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', callback, { once: true });
        } else {
            callback();
        }
    };

    const extractRoomId = (url) => {
        if (!url) return '';
        try {
            let clean = url.split('?')[0].split('#')[0];
            let parts = clean.split('/').filter(p => p.length > 0);
            return parts[parts.length - 1] || '';
        } catch (e) {
            return '';
        }
    };

    // 断流自动恢复开关。B 站页与抖音页共用同一个 GM 配置。
    const AUTO_RECOVER_ENABLED_KEY = 'AUTO_RECOVER_ENABLED';
    const isAutoRecoverEnabled = () => GM_getValue(AUTO_RECOVER_ENABLED_KEY, false) === true;

    // 抖音原生页面没有可安全调用的播放器重载接口，只能在确认停滞后刷新页面。
    // 用 sessionStorage 限制刷新频率并做逐次退避，避免主播长时间离线时无限刷新。
    const reloadPageForRecovery = (reason, minInterval = 60000) => {
        if (!isAutoRecoverEnabled()) return false;
        const now = Date.now();
        let state = {};
        try {
            state = JSON.parse(sessionStorage.getItem('DL_AUTO_RELOAD_STATE') || '{}') || {};
        } catch (e) {}
        const lastAt = Number(state.at) || 0;
        const count = now - lastAt > 10 * 60 * 1000 ? 0 : (Number(state.count) || 0);
        const interval = Math.min(5 * 60 * 1000, minInterval * Math.pow(1.6, Math.min(count, 5)));
        if (lastAt && now - lastAt < interval) {
            console.debug('[DualLive] 自动刷新冷却中:', Math.ceil((interval - (now - lastAt)) / 1000), '秒');
            return false;
        }
        try {
            sessionStorage.setItem('DL_AUTO_RELOAD_STATE', JSON.stringify({ at: now, count: count + 1, reason }));
        } catch (e) {}
        console.warn('[DualLive] 自动刷新页面恢复直播:', reason);
        setTimeout(() => location.reload(), 600);
        return true;
    };

    const getBiliLiveRoomId = (value) => {
        try {
            const url = new URL(String(value || ''));
            if (!['http:', 'https:'].includes(url.protocol) || url.hostname !== 'live.bilibili.com') return '';
            return url.pathname.match(/^\/(?:blanc\/)?(\d+)\/?$/)?.[1] || '';
        } catch (e) { return ''; }
    };

    // 只解码官网已有连接的普通评论；不新建连接、不发送消息、不扫描 DOM 历史。
    const readDouyinProto = (bytes) => {
        const fields = new Map();
        let offset = 0, budget = 20000;
        const readVarint = () => {
            let value = 0n, shift = 0n;
            for (let i = 0; i < 10; i++) {
                if (offset >= bytes.length) throw new Error('直播消息不完整');
                const byte = bytes[offset++];
                if (i === 9 && byte > 1) throw new Error('直播消息整数无效');
                value |= BigInt(byte & 127) << shift;
                if (!(byte & 128)) return value;
                shift += 7n;
            }
            throw new Error('直播消息整数无效');
        };
        while (offset < bytes.length) {
            if (--budget < 0) throw new Error('直播消息字段过多');
            const tag = readVarint();
            if (tag > 0xffffffffn || (tag >> 3n) === 0n) throw new Error('直播消息字段无效');
            const field = Number(tag >> 3n), wire = Number(tag & 7n);
            let value;
            if (wire === 0) value = readVarint();
            else if (wire === 2 || wire === 1 || wire === 5) {
                const length = wire === 2 ? Number(readVarint()) : wire === 1 ? 8 : 4;
                if (!Number.isSafeInteger(length) || length < 0 || offset + length > bytes.length) {
                    throw new Error('直播消息长度无效');
                }
                value = bytes.subarray(offset, offset + length);
                offset += length;
            } else throw new Error('不支持的直播消息字段');
            if (!fields.has(field)) fields.set(field, []);
            fields.get(field).push(value);
        }
        return fields;
    };

    const decodeDouyinChatFrame = async (data, receivedAt = Date.now(), clock = null, onResponse = null) => {
        const limit = 4 * 1024 * 1024;
        let bytes;
        if (Object.prototype.toString.call(data) === '[object ArrayBuffer]') bytes = new Uint8Array(data);
        else if (ArrayBuffer.isView(data)) bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
        else if (data && typeof data.arrayBuffer === 'function' && data.size <= limit) bytes = new Uint8Array(await data.arrayBuffer());
        else return [];
        if (!bytes.length || bytes.length > limit) return [];
        const text = new TextDecoder();
        const getBytes = (fields, field) => fields.get(field)?.[0] instanceof Uint8Array ? fields.get(field)[0] : new Uint8Array();
        const getText = (fields, field) => text.decode(getBytes(fields, field));
        const toMillis = value => {
            const number = Number(value);
            return Number.isSafeInteger(number) && number > 0 ? (number < 1000000000000 ? number * 1000 : number) : 0;
        };
        const frame = readDouyinProto(bytes);
        if (getText(frame, 7) !== 'msg') return [];
        let payload = getBytes(frame, 8);
        if (payload[0] === 0x1f && payload[1] === 0x8b) {
            if (typeof DecompressionStream === 'undefined') return [];
            const reader = new Blob([payload]).stream().pipeThrough(new DecompressionStream('gzip')).getReader();
            const chunks = [];
            let size = 0;
            try {
                while (true) {
                    const result = await reader.read();
                    if (result.done) break;
                    size += result.value.length;
                    if (size > limit) throw new Error('直播消息解压后过大');
                    chunks.push(result.value);
                }
            } finally { try { await reader.cancel(); } catch (e) {} }
            payload = new Uint8Array(size);
            let offset = 0;
            for (const chunk of chunks) { payload.set(chunk, offset); offset += chunk.length; }
        }
        const response = readDouyinProto(payload);
        if (onResponse) onResponse(frame, response);
        let serverNow = toMillis(response.get(4)?.[0]);
        for (const header of frame.get(5) || []) {
            const fields = readDouyinProto(header);
            if (getText(fields, 1) === 'im-now') serverNow = toMillis(getText(fields, 2)) || serverNow;
        }
        if (!serverNow) return []; // 没有服务端时间就不能证明是新消息。
        const offset = receivedAt - serverNow;
        // 同一连接沿用最小时间差；恢复后台积压时，不能把迟到帧重新标成“刚发送”。
        if (clock) clock.offset = Math.min(clock.offset ?? Infinity, offset);
        const items = [];
        for (const rawMessage of (response.get(1) || []).slice(0, 200)) {
            const message = readDouyinProto(rawMessage);
            if (getText(message, 1) !== 'WebcastChatMessage') continue;
            const chat = readDouyinProto(getBytes(message, 2));
            const common = readDouyinProto(getBytes(chat, 1));
            const user = readDouyinProto(getBytes(chat, 2));
            const nickname = getText(user, 3).trim(), content = getText(chat, 3).trim();
            // 当前协议使用 ChatMessage.eventTime(15)，兼容旧 Common.createTime(4)。
            const sourceCreatedAt = toMillis(chat.get(15)?.[0]) || toMillis(common.get(4)?.[0]);
            const id = common.get(2)?.[0] || message.get(3)?.[0];
            if (!id || !sourceCreatedAt || !nickname || !content || nickname.length > 60 || content.length > 200) continue;
            // 用服务端消息年龄换算成本机时间，避免用户电脑时钟偏差造成误判。
            const createdAt = Math.min(receivedAt, sourceCreatedAt + (clock?.offset ?? offset));
            items.push({ nickname, content, messageId: String(id), observedAt: receivedAt, createdAt });
        }
        return items;
    };

    const observeDouyinChatSocket = (pageWindow, onItems, onConnection = null) => {
        const NativeWebSocket = pageWindow.WebSocket;
        if (typeof NativeWebSocket !== 'function') return;
        const seen = new Set();
        pageWindow.WebSocket = new Proxy(NativeWebSocket, {
            construct(target, args, newTarget) {
                const socket = Reflect.construct(target, args, newTarget);
                let url;
                try { url = new URL(String(args[0]), location.href); } catch (e) { return socket; }
                const roomId = extractRoomId(location.href);
                if (url.protocol !== 'wss:' || !/(^|\.)douyin\.com$/.test(url.hostname) ||
                    !url.pathname.startsWith('/webcast/im/push/') || !/^\d+$/.test(roomId)) return socket;
                const connectedAt = Date.now();
                if (onConnection) socket.addEventListener('open', () => onConnection({
                    roomId, url: url.href, capturedAt: Date.now()
                }), { once: true });
                const clock = { offset: null };
                let chain = Promise.resolve(), pending = 0;
                socket.addEventListener('message', event => {
                    if (pending >= 20) return;
                    const receivedAt = Date.now(), data = event.data;
                    pending++;
                    chain = chain.then(async () => {
                        if (extractRoomId(location.href) !== roomId) return;
                        const items = (await decodeDouyinChatFrame(data, receivedAt, clock)).filter(item => {
                            if (item.createdAt <= connectedAt || seen.has(item.messageId)) return false;
                            seen.add(item.messageId);
                            if (seen.size > 5000) seen.delete(seen.values().next().value);
                            return true;
                        });
                        if (items.length) onItems(items, roomId);
                    }).catch(() => {}).finally(() => { pending--; });
                });
                return socket;
            }
        });
    };

    const encodeDouyinControl = (type, logId = null, payload = '') => {
        const bytes = [], text = new TextEncoder();
        const integer = value => {
            let number = BigInt(value);
            do { const part = Number(number & 127n); number >>= 7n; bytes.push(part | (number ? 128 : 0)); } while (number);
        };
        const field = (id, value) => {
            const data = text.encode(value);
            integer(id * 8 + 2); integer(data.length); bytes.push(...data);
        };
        if (logId !== null) { integer(16); integer(logId); }
        field(7, type);
        if (payload) field(8, payload);
        return new Uint8Array(bytes);
    };

    // 由 B站页独立维持弹幕连接，无需直播页面、播放器或额外媒体请求。
    const createDouyinDirectClient = (onItems, onState) => {
        let socket = null, heartbeat = null, retryTimer = null, watchdog = null;
        let entry = null, generation = 0, attempts = 0;
        const stop = () => {
            generation++;
            clearInterval(heartbeat); clearTimeout(retryTimer); clearTimeout(watchdog);
            heartbeat = retryTimer = watchdog = null;
            const old = socket; socket = null; entry = null;
            try { old?.close(); } catch (e) {}
        };
        const start = next => {
            let url;
            try {
                url = new URL(next?.url);
                if (url.protocol !== 'wss:' || !/(^|\.)douyin\.com$/.test(url.hostname) ||
                    !url.pathname.startsWith('/webcast/im/push/') || !/^\d+$/.test(next.roomId)) return false;
            } catch (e) { return false; }
            if (entry?.url === next.url && entry.roomId === next.roomId) return true;
            stop(); entry = { ...next }; attempts = 0;
            const token = generation, clock = { offset: null }, seen = new Set();
            const connect = () => {
                if (token !== generation) return;
                onState('连接中');
                let current;
                try { current = socket = new WebSocket(url.href); }
                catch (e) { onState('连接被浏览器阻止'); return; }
                current.binaryType = 'arraybuffer';
                let pending = Promise.resolve(), lastFrame = Date.now(), openedAt = 0, queued = 0;
                watchdog = setTimeout(() => current.close(), 15000);
                current.addEventListener('open', () => {
                    if (token !== generation || socket !== current) return;
                    clearTimeout(watchdog);
                    openedAt = Date.now();
                    heartbeat = setInterval(() => {
                        if (current.readyState !== 1) return;
                        if (Date.now() - lastFrame > 45000) { current.close(); return; }
                        current.send(encodeDouyinControl('hb'));
                    }, 10000);
                });
                current.addEventListener('message', event => {
                    if (queued >= 20) return;
                    const receivedAt = Date.now(); lastFrame = receivedAt; queued++;
                    pending = pending.then(async () => {
                        if (token !== generation || socket !== current) return;
                        const items = await decodeDouyinChatFrame(event.data, receivedAt, clock, (frame, response) => {
                            if (response.get(9)?.[0] && current.readyState === 1) {
                                const internal = response.get(5)?.[0];
                                current.send(encodeDouyinControl('ack', frame.get(2)?.[0] ?? 0n,
                                    internal instanceof Uint8Array ? new TextDecoder().decode(internal) : ''));
                            }
                        });
                        if (token !== generation || socket !== current) return;
                        // 只有连接持续收到数据一段时间后才清零，避免快速断线无限重试。
                        if (openedAt && receivedAt - openedAt >= 30000) attempts = 0;
                        onState('已连接');
                        const fresh = items.filter(item => {
                            if (seen.has(item.messageId)) return false;
                            seen.add(item.messageId);
                            if (seen.size > 10000) seen.delete(seen.values().next().value);
                            return true;
                        });
                        if (fresh.length) onItems(fresh, entry.roomId);
                    }).catch(() => {}).finally(() => queued--);
                });
                current.addEventListener('close', () => {
                    if (token !== generation || socket !== current) return;
                    clearInterval(heartbeat); clearTimeout(watchdog);
                    if (++attempts <= 3) {
                        onState('重连中'); retryTimer = setTimeout(connect, attempts * 3000);
                    } else onState('连接失效，请打开抖音刷新参数');
                });
                current.addEventListener('error', () => {}); // close 统一处理失败和有界重试。
            };
            connect(); return true;
        };
        return { start, stop };
    };

    // 抖音当前会在 HTTPS 页面中下发 http://*.douyincdn.com / *.douyinliving.com 播放地址。
    // 对已验证支持 HTTPS 的抖音 CDN 升级协议，避免浏览器拦截主动混合内容。
    const normalizeStreamUrl = (rawUrl) => {
        if (!rawUrl) return '';
        try {
            const parsed = new URL(rawUrl, location.href);
            const isDouyinCdn = parsed.hostname === 'douyincdn.com' ||
                parsed.hostname.endsWith('.douyincdn.com') ||
                parsed.hostname === 'douyinliving.com' ||
                parsed.hostname.endsWith('.douyinliving.com');
            if (parsed.protocol === 'http:' && isDouyinCdn) parsed.protocol = 'https:';
            return parsed.href;
        } catch (e) {
            return rawUrl;
        }
    };

    const parseResolutionPair = (value) => {
        const match = String(value || '').match(/(\d{3,5})\s*[x×](\d{3,5})/i);
        return match ? [Math.round(Number(match[1])), Math.round(Number(match[2]))] : null;
    };

    // 下拉框使用短画质标签。按短边显示，横屏 1920x1080 -> 1080p，
    // 竖屏源也不会把长边误当成画质级别；没有真实尺寸时保留前端给出的 p 标签。
    const formatShortResolution = (width, height, fallback = '') => {
        let w = Number(width);
        let h = Number(height);
        if (!(w > 0 && h > 0)) {
            const text = String(fallback || '');
            const pair = parseResolutionPair(text);
            if (pair) {
                [w, h] = pair;
            } else {
                const pMatch = text.match(/(\d{3,5})\s*[pP]\b/);
                if (pMatch) return `${Math.round(Number(pMatch[1]))}p`;
            }
        }
        if (!(w > 0 && h > 0)) return '未知';
        return `${Math.round(Math.min(w, h))}p`;
    };

    // 实时监控必须显示真实的完整尺寸；只有拿到 WxH 才显示，不能把 1080p
    // 反推成一个可能错误的宽高。
    const formatFullResolution = (width, height, fallback = '') => {
        let w = Number(width);
        let h = Number(height);
        if (!(w > 0 && h > 0)) {
            const pair = parseResolutionPair(fallback);
            if (pair) [w, h] = pair;
        }
        return w > 0 && h > 0 ? `${Math.round(w)}x${Math.round(h)}` : '未知';
    };

    // 仅安装到 LLS iframe。部分 CDN 的 OPTIONS 会 302，JSON POST 因预检失败无法发送。
    // 先用普通 GET 获取 CDN 返回的最终地址，再发送原样的 SDP JSON 文本，避免先触发一次必然失败的预检。
    // 不改解码器，不代理媒体数据，不放宽浏览器 CORS，也不改变正常线路的请求。
    function installLlsFetchFallback(sourceUrl) {
        const source = new URL(sourceUrl);
        // 个别 CDN 会在 SDP 地址末尾补一个斜杠；去掉尾斜杠只用于白名单比较，
        // 实际请求仍使用播放器传入的原地址。
        const sourcePath = decodeURIComponent(source.pathname || '').replace(/\/+$/, '');
        if (source.protocol !== 'https:' || !sourcePath.toLowerCase().endsWith('.sdp') ||
            !['.douyincdn.com', '.douyinliving.com'].some(suffix => source.hostname.endsWith(suffix))) return;
        const nativeFetch = window.fetch.bind(window);
        const isAllowedTarget = (rawUrl) => {
            try {
                const target = new URL(rawUrl);
                const targetPath = decodeURIComponent(target.pathname || '').replace(/\/+$/, '');
                const expectedPath = `/${source.hostname}${sourcePath}`;
                return target.protocol === 'https:' && !target.username && !target.password &&
                    (target.hostname.endsWith('.ourdvsssvip.com') || target.hostname.endsWith('.ourdvssvip.com')) &&
                    targetPath === expectedPath;
            } catch (e) {
                return false;
            }
        };
        const targetPromise = (() => {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 5000);
            return nativeFetch(source.href, {
                method: 'GET', mode: 'cors', credentials: 'omit', redirect: 'follow',
                cache: 'no-store', signal: controller.signal
            }).then(response => {
                const target = response.url && response.url !== source.href && isAllowedTarget(response.url)
                    ? response.url : '';
                try { response.body?.cancel(); } catch (e) {}
                return target;
            }).catch(() => '').finally(() => clearTimeout(timeout));
        })();
        window.fetch = async function(input, options) {
            let requested;
            try {
                requested = typeof input === 'string' ? new URL(input) :
                    input instanceof URL ? new URL(input.href) : new URL(input?.url || '');
            } catch (e) {}
            const method = String(options?.method || input?.method || 'GET').toUpperCase();
            const body = options?.body;
            let requestedPath = '';
            try { requestedPath = decodeURIComponent(requested?.pathname || '').replace(/\/+$/, ''); } catch (e) {}
            const isSignalingRequest = requested && requested.origin === source.origin &&
                requestedPath === sourcePath && method === 'POST' && typeof body === 'string';
            if (!isSignalingRequest) return nativeFetch(input, options);

            const headers = new Headers(options.headers || (input instanceof Request ? input.headers : undefined));
            if (headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json' ||
                [...headers.keys()].some(key => key !== 'content-type' && key !== 'accept') ||
                options?.credentials === 'include' || input instanceof Request && input.credentials === 'include' ||
                options?.signal?.aborted) return nativeFetch(input, options);
            const target = await targetPromise;
            if (!target) return nativeFetch(input, options);
            headers.set('Content-Type', 'text/plain');
            console.info('[DualLive LLS] 已解析 CDN 跳转，重试播放协商');
            // 此节点接受 JSON 文本，但未允许 application/json 的跨域预检。
            // 禁止二次跳转，防止 302 将 POST 转成 GET 丢失 SDP；继续沿用 SDK 的取消/超时。
            return nativeFetch(target, Object.assign({}, options, {
                headers, mode: 'cors', credentials: 'omit', redirect: 'error'
            }));
        };
    }

    const detectDouyinCodec = (rawUrl) => {
        const lowerUrl = String(rawUrl || '').toLowerCase();
        let path = lowerUrl.split('?')[0];
        try { path = decodeURIComponent(new URL(rawUrl, location.href).pathname).toLowerCase(); } catch (e) {}

        const isH265 = /hevc|bytevc1|h265/.test(lowerUrl) ||
                       /(?:^|[?&])codec=(?:1|hevc|h265)(?:&|$)/.test(lowerUrl) ||
                       /(?:^|[_-])(?:hiq|uiq)[a-z0-9]*5(?:[/_.-]|$)/.test(path) ||
                       /(?:^|[_-])(?:hd|sd|ld)5(?:[/_.-]|$)/.test(path);
        return isH265 ? 'h265' : 'h264';
    };

    // 仅采用前端明确下发的纯音频标志；不能把暂时没有画面的流猜成纯音频。
    const isAudioOnlyStream = (stream) => {
        if (stream?.audioOnly === true) return true;
        try { return new URL(stream?.url || '', location.href).searchParams.get('only_audio') === '1'; }
        catch (e) { return false; }
    };

    const describePlaybackFailure = (format, detail, code = '') => {
        const type = String(format || '媒体').toUpperCase();
        const text = String(detail?.message || detail || '');
        const http = text.match(/(?:http(?:\s+code)?|status(?:\s+code)?)\s*[:=]?\s*(\d{3})\b/i);
        if (http) {
            const status = Number(http[1]);
            if (status === 401 || status === 403) return `${type} 服务器拒绝访问（HTTP ${status}）`;
            if (status === 404) return `${type} 源在服务器上不可用（HTTP 404）`;
            return `${type} 网络请求失败（HTTP ${status}）`;
        }
        const serviceCode = text.match(/\bcode\s*[:=]\s*(401|403|404)\b/i);
        if (serviceCode) return `${type} 服务端拒绝播放（代码 ${serviceCode[1]}）`;
        if (/failed to fetch|networkerror|network error|cors/i.test(text)) {
            return `${type} 网络或跨域请求失败`;
        }
        if (/decode|codec.*(?:unsupported|not supported)|(?:unsupported|not supported).*codec/i.test(text)) {
            return `${type} 解码或编码格式不受支持`;
        }
        return `${type} 播放失败${code ? ` (${code})` : ''}`;
    };

    const normalizeCodecName = (value) => {
        const text = String(value || '').toLowerCase();
        if (/av1/.test(text)) return 'av1';
        if (/hevc|hvc1|hev1|bytevc1|h265|265/.test(text)) return 'h265';
        if (/avc|avc1|h264|264/.test(text)) return 'h264';
        return '';
    };

    // 两端使用同一分组规则，已有缓存也按 FLV/LLS/HLS 内 H.264 在前显示。
    const compareStreamTypeAndCodec = (a, b) => {
        const formats = { flv: 0, lls: 1, hls: 2 };
        const codecs = { h264: 0, h265: 1 };
        return ((formats[String(a.format || '').toLowerCase()] ?? 3) -
            (formats[String(b.format || '').toLowerCase()] ?? 3)) ||
            ((codecs[normalizeCodecName(a.codec)] ?? 2) - (codecs[normalizeCodecName(b.codec)] ?? 2));
    };

    // 隐藏B站小橙车提示浮窗
    GM_addStyle(`
        #shop-popover-vm,
        .shop-popover {
            display: none !important;
        }
    `);

    const nativeHiddenGetter = Object.getOwnPropertyDescriptor(Document.prototype, 'hidden')?.get;
    const isPageReallyHidden = () => nativeHiddenGetter ? nativeHiddenGetter.call(document) : document.hidden;

    // 保留后台保护；真实前台通知仍交给播放器，但切换页面不清空原生弹幕。
    const installPageVisibilityGuard = () => {
        try { Object.defineProperty(document, 'hidden', { value: false, writable: false }); } catch (e) {}
        try { Object.defineProperty(document, 'visibilityState', { value: 'visible', writable: false }); } catch (e) {}
        window.addEventListener('visibilitychange', e => {
            if (isPageReallyHidden() || !IS_BILI) e.stopImmediatePropagation();
        }, true);
        window.addEventListener('blur', e => e.stopImmediatePropagation(), true);
    };

    if (IS_BILI || IS_DOUYIN) installPageVisibilityGuard();

    // 只适配原生画面弹幕，不拦截官网消息接收和右侧评论栏。
    // rAF 在后台停帧时 manager 的时钟落后于消息时间，会算出超长动画和错误轨道。
    const patchedBiliDanmakuManagers = new WeakSet();
    const installBiliDanmakuClockGuard = () => {
        const pageWindow = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
        const prototype = pageWindow.LiveDanmakuEngine?.default?.prototype;
        if (typeof prototype?.handleSocketMessage !== 'function') return false;
        const handleSocketMessage = prototype.handleSocketMessage;
        prototype.handleSocketMessage = function (...args) {
            try {
                const core = this.danmaku?.core;
                const manager = core?.manager;
                if (manager && !patchedBiliDanmakuManagers.has(manager) &&
                    typeof manager.add === 'function' &&
                    typeof core.timeController?.updateTime === 'function') {
                    const add = manager.add;
                    manager.add = function (...items) {
                        // 仅跳过后台不可见的画面插入；不改正在滚动的节点，也不关弹幕开关。
                        if (isPageReallyHidden()) return;
                        try {
                            if (core.isRunning) {
                                core.timeController.updateTime();
                                const renderTime = core.renderTime, currentTime = core.currentTime;
                                if (Number.isFinite(renderTime) && Number.isFinite(currentTime)) {
                                    this.renderTime = renderTime;
                                    this.currentTime = currentTime;
                                }
                            }
                        } catch (error) { /* 站点改版时回退原生处理。 */ }
                        return add.apply(this, items);
                    };
                    patchedBiliDanmakuManagers.add(manager);
                }
            } catch (error) { /* 不让可选的适配阻断官网弹幕。 */ }
            return handleSocketMessage.apply(this, args);
        };
        return true;
    };
    if (IS_BILI && !installBiliDanmakuClockGuard()) {
        let attempts = 0;
        const attachTimer = window.setInterval(() => {
            if (installBiliDanmakuClockGuard() || ++attempts >= 120) clearInterval(attachTimer);
        }, 250);
    }


    if (IS_DOUYIN) {

        // 抖音去弹窗模块
        whenDocumentReady(() => {
            setInterval(() => {
                let closeBtn = document.querySelector('.xgplayer-close') || document.querySelector('[data-e2e="live-room-confirm-btn"]');
                if (closeBtn) closeBtn.click();
            }, 3000);
        });
    }

    // 获取抖音直播流地址模块
    if (IS_DOUYIN) {
        let danmakuSequence = 0;
        const danmakuSessionId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
        try {
            observeDouyinChatSocket(typeof unsafeWindow !== 'undefined' ? unsafeWindow : window, (items, roomId) => {
                GM_setValue('DY_DANMAKU_BATCH', {
                    roomId, source: 'websocket', time: Date.now(),
                    sequence: ++danmakuSequence, sessionId: danmakuSessionId, items: items.slice(-100)
                });
            }, connection => GM_setValue('DY_CHAT_CONNECTION', connection));
        } catch (error) { console.warn('[DualLive] 无法监听抖音原生弹幕连接:', error); }
        whenDocumentReady(() => {
            const currentRoomId = extractRoomId(location.href);

            setInterval(() => {
                if (!currentRoomId) return;
                const now = Date.now();
                // 心跳机制
                let hbMap = GM_getValue('DY_HEARTBEATS_MAP', {});
                hbMap[currentRoomId] = now;

                for (let rid in hbMap) {
                    if (now - hbMap[rid] > 10000) delete hbMap[rid];
                }
                GM_setValue('DY_HEARTBEATS_MAP', hbMap);
            }, 1500);

            // 提取推流源
            function extractDouyinStreams() {
                let extracted = [];
                try {
                    let html = document.documentElement.innerHTML;
                    let cleanHtml = html.replace(/\\"/g, '"').replace(/\\u0026/g, '&');

                    // 字符串兜底解析时 JSON 可能还保留转义斜杠；先还原 URL，
                    // 否则部分 SDP 会被 URL 构造器解析成错误路径。
                    const decodeStreamUrl = (value) => String(value || '')
                        .replace(/\\u002f/gi, '/')
                        .replace(/\\\//g, '/')
                        .replace(/\\u003a/gi, ':')
                        .replace(/\\u003f/gi, '?')
                        .replace(/\\u003d/gi, '=')
                        .replace(/\\u0026/gi, '&');

                    // 页面会同时下发 H.264 与 ByteVC1/H.265 的 qualities。
                    // 全量读取，并保留每条记录自己的 v_codec，避免把第一组数据套到所有编码上。
                    let qualities = [];
                    let qRegex = /"qualities":\[(.*?)\]\}/g;
                    let qMatch;
                    while ((qMatch = qRegex.exec(cleanHtml)) !== null) {
                        try {
                            const parsed = JSON.parse(`[${qMatch[1]}]`);
                            parsed.forEach(q => {
                                const rawCodec = String(q && q.v_codec || '').toLowerCase();
                                const codec = /bytevc1|hevc|265/.test(rawCodec)
                                    ? 'h265'
                                    : (/avc|264/.test(rawCodec) ? 'h264' : 'unknown');
                                qualities.push({ ...q, _codec: codec });
                            });
                        } catch(e) {}
                    }

                    let urlMap = {};
                    const parseDict = (regex, format) => {
                        let match;
                        while ((match = regex.exec(cleanHtml)) !== null) {
                            try {
                                let obj = JSON.parse(`{${match[1]}}`);
                                for (let key in obj) {
                                    const streamUrl = decodeStreamUrl(obj[key]);
                                    if (streamUrl && !urlMap[streamUrl]) urlMap[streamUrl] = { url: streamUrl, format: format, key: key };
                                }
                            } catch (e) {}
                        }
                    };

                    parseDict(/"flv_pull_url":\{([^}]+)\}/g, 'flv');
                    parseDict(/"hls_pull_url_map":\{([^}]+)\}/g, 'hls');
                    parseDict(/"lls_pull_url(?:_map)?":\{([^}]+)\}/g, 'lls');
                    parseDict(/"rtm_pull_url(?:_map)?":\{([^}]+)\}/g, 'lls');

                    // 某些版本把单条 LLS 地址直接放在字符串字段中，而不是 map。
                    const singleLlsReg = /"(?:lls_pull_url|rtm_pull_url)"\s*:\s*"([^"\\]*(?:\\.[^"\\]*)*)"/g;
                    let singleLlsMatch;
                    while ((singleLlsMatch = singleLlsReg.exec(cleanHtml)) !== null) {
                        const fUrl = decodeStreamUrl(singleLlsMatch[1]);
                        if (fUrl) urlMap[fUrl] = { url: fUrl, format: 'lls', key: 'unknown' };
                    }

                    // 补充解析 data 节点中的独立画质块
                    const parseDataQualities = (format) => {
                        const qualitiesKeys = ['origin', 'uhd', 'hd', 'sd', 'ld', 'md'];
                        for (let qKey of qualitiesKeys) {
                            let reg = new RegExp(`"${qKey}"\\s*:\\s*\\{([^}]+(?:\\{[^}]+\\}[^}]*)*)\\}`, 'g');
                            let match;
                            while ((match = reg.exec(cleanHtml)) !== null) {
                                let block = match[1];
                                let urlReg = /"(flv|hls|lls|rtm)"\s*:\s*"([^"]+)"/g;
                                let uMatch;
                                while ((uMatch = urlReg.exec(block)) !== null) {
                                    let fType = /^(lls|rtm)$/.test(uMatch[1]) ? 'lls' : uMatch[1];
                                    let fUrl = decodeStreamUrl(uMatch[2]);
                                    if (fType === format && !urlMap[fUrl]) {
                                        urlMap[fUrl] = { url: fUrl, format: format, key: qKey };
                                    }
                                }
                            }
                        }
                    };
                    parseDataQualities('flv');
                    parseDataQualities('hls');
                    parseDataQualities('lls');

                    const getQInfo = (url, key, codec) => {
                        if (!qualities.length) return null;

                        // 只在同一编码内匹配；前端没有对应编码信息时不跨组猜测。
                        const candidates = qualities.filter(q => q._codec === codec);
                        if (!candidates.length) return null;

                        const normalizedKey = String(key || '').toLowerCase();
                        const exactMatch = candidates.find(q => String(q.sdk_key || '').toLowerCase() === normalizedKey);
                        if (exactMatch) return exactMatch;

                        const lowerUrl = String(url || '').toLowerCase();
                        const sortedQ = [...candidates].sort((a, b) =>
                            String(b.sdk_key || '').length - String(a.sdk_key || '').length
                        );
                        return sortedQ.find(q => {
                            const sdkKey = String(q.sdk_key || '').toLowerCase();
                            return sdkKey && lowerUrl.includes(sdkKey);
                        }) || null;
                    };

                    let tempExtracted = Object.values(urlMap).map(item => {
                        const streamUrl = normalizeStreamUrl(item.url);
                        let codec = detectDouyinCodec(streamUrl);
                        let matchedQ = getQInfo(streamUrl, item.key, codec);
                        let v_bit_rate = matchedQ && Number(matchedQ.v_bit_rate) > 0 ? Number(matchedQ.v_bit_rate) : 0;
                        let fps = matchedQ && Number(matchedQ.fps) > 0 ? Number(matchedQ.fps) : 0;
                        let resolution = matchedQ && matchedQ.resolution ? matchedQ.resolution : '未知';
                        let sdkKey = matchedQ && matchedQ.sdk_key ? matchedQ.sdk_key : 'unknown';
                         // 只有 SDP 才是网页播放器的 RTM/LLS 信令；字段名为 rtm 但实际给出
                         // m3u8/flv 时按真实后缀降级，避免把普通源误送进 LLS 分支。
                         let format = item.format;
                         const lowerStreamUrl = streamUrl.toLowerCase().split('?')[0];
                         if (format === 'lls' && !lowerStreamUrl.endsWith('.sdp')) {
                             if (lowerStreamUrl.includes('.m3u8')) format = 'hls';
                             else if (lowerStreamUrl.includes('.flv')) format = 'flv';
                         }

                        // 画质名称完全采用前端 name；前端未提供时明确显示未知。
                        let currentQualityName = matchedQ && typeof matchedQ.name === 'string' && matchedQ.name.trim()
                            ? matchedQ.name.trim()
                            : '未知';

                        return {
                            name: currentQualityName,
                            url: streamUrl,
                            format: format,
                            codec: codec,
                            audioOnly: isAudioOnlyStream({ url: streamUrl }),
                            bitrate: v_bit_rate,
                            fps: fps,
                            resolution: resolution,
                            sdk_key: sdkKey
                        };
                    });

                    // 规则：不进行去重过滤，全量保留抓取到的所有不同源
                    extracted = tempExtracted;

                } catch(e) { console.error("解析流失败", e); }

                    // 排序规则：FLV -> LLS -> HLS；同格式内再按帧率、码率和编码排序。
                    extracted.sort((a, b) => {
                    const groupOrder = compareStreamTypeAndCodec(a, b);
                    if (groupOrder) return groupOrder;
                    const bothLls = a.format === 'lls' && b.format === 'lls';
                    // 帧率优先（60帧 > 45帧 > 30帧 > 未知0帧）
                    if (b.fps !== a.fps) return b.fps - a.fps;
                    // 前端未提供码率的未知源排在已知码率之后。
                    let aUnknownBitrate = (a.bitrate === 0) ? 1 : 0;
                    let bUnknownBitrate = (b.bitrate === 0) ? 1 : 0;
                    if (aUnknownBitrate !== bUnknownBitrate) return aUnknownBitrate - bUnknownBitrate;
                    if (b.bitrate !== a.bitrate) return b.bitrate - a.bitrate;
                    if (bothLls) {
                        // 同编码、同帧率、同码率时：Gravity > 带音轨的普通线路 > 可能仅含视频的备用线路。
                        const aGravity = /\/\/pull-lls-gravity-/i.test(a.url) ? 1 : 0;
                        const bGravity = /\/\/pull-lls-gravity-/i.test(b.url) ? 1 : 0;
                        if (aGravity !== bGravity) return bGravity - aGravity;
                        const aVolcLine = /[?&](?:volcSecret|volcTime)=/i.test(a.url) ? 1 : 0;
                        const bVolcLine = /[?&](?:volcSecret|volcTime)=/i.test(b.url) ? 1 : 0;
                        if (aVolcLine !== bVolcLine) return aVolcLine - bVolcLine;
                    }
                    return 0;
                    });

                return extracted;
            }

            let lastValidStreamJson = '';

            // 将抖音页面提取的地址库打包，通过 GM_setValue 存入公共内存区
            const tryPushStreams = (force = false) => {
                if (!currentRoomId) return;
                const streams = extractDouyinStreams();
                if (streams.length > 0) {
                    const hasValidBitrate = streams.some(s => s.bitrate > 0);
                    let streamMap = GM_getValue('DY_STREAM_MAP', {});
                    let existing = streamMap[currentRoomId];

                    if (hasValidBitrate || !existing || force) {
                        streamMap[currentRoomId] = {
                            roomId: currentRoomId,
                            time: Date.now(),
                            streams: streams
                        };
                        GM_setValue('DY_STREAM_MAP', streamMap);
                    }
                }
            };

            setInterval(() => tryPushStreams(false), 3000);

            GM_addValueChangeListener('DY_FORCE_EXTRACT', (name, old_val, new_val, remote) => {
                if (remote) tryPushStreams(true);
            });

            // 自动刷新抖音页后尽量恢复用户原本的静音/音量，避免重载后突然出声。
            let savedDouyinMediaState = null;
            try {
                savedDouyinMediaState = JSON.parse(sessionStorage.getItem('DL_DY_MEDIA_STATE') || 'null');
                sessionStorage.removeItem('DL_DY_MEDIA_STATE');
            } catch (e) {}
            const saveDouyinMediaState = (video) => {
                if (!video) return;
                try {
                    sessionStorage.setItem('DL_DY_MEDIA_STATE', JSON.stringify({
                        muted: !!video.muted,
                        volume: Number(video.volume)
                    }));
                } catch (e) {}
            };

            // 抖音原生页面没有可安全调用的播放器 reload 接口；
            // 只在页面处于前台且画面确实停住时刷新页面，避免后台误刷新。
            let dyAutoLastVideo = null;
            let dyAutoLastTime = NaN;
            let dyAutoLastProgressAt = Date.now();
            let dyAutoStableSince = Date.now();
            let dyAutoNextReloadAt = 0;

            const getDouyinNativeVideo = () => {
                const videos = Array.from(document.querySelectorAll('video')).filter(video =>
                    video.videoWidth > 0 && video.readyState >= 2);
                if (!videos.length) return null;
                return videos.sort((a, b) => {
                    const aRect = a.getBoundingClientRect();
                    const bRect = b.getBoundingClientRect();
                    return (bRect.width * bRect.height) - (aRect.width * aRect.height);
                })[0];
            };

            if (savedDouyinMediaState) {
                let restoreTries = 0;
                const restoreMediaState = () => {
                    const video = getDouyinNativeVideo();
                    if (video) {
                        if (Number.isFinite(Number(savedDouyinMediaState.volume))) {
                            video.volume = Math.max(0, Math.min(1, Number(savedDouyinMediaState.volume)));
                        }
                        video.muted = !!savedDouyinMediaState.muted;
                    }
                };
                const restoreTimer = window.setInterval(() => {
                    restoreMediaState();
                    if (++restoreTries >= 40) clearInterval(restoreTimer);
                }, 250);
                restoreMediaState();
            }

            const checkDouyinNativeRecovery = () => {
                if (!isAutoRecoverEnabled()) {
                    dyAutoLastVideo = null;
                    return;
                }
                const video = getDouyinNativeVideo();
                if (!video) {
                    dyAutoLastVideo = null;
                    dyAutoLastProgressAt = Date.now();
                    return;
                }
                const now = Date.now();
                if (video.paused) {
                    dyAutoLastVideo = video;
                    dyAutoLastTime = Number(video.currentTime);
                    dyAutoLastProgressAt = now;
                    return;
                }
                // 后台标签页可能被浏览器节流；这里只处理用户正在看的原生抖音页。
                // 作为 B 站分屏源时的恢复由 B 站页发出的 DY_REFRESH_REQUEST 负责。
                if (!document.hasFocus()) {
                    dyAutoLastVideo = video;
                    dyAutoLastTime = Number(video.currentTime);
                    dyAutoLastProgressAt = now;
                    return;
                }
                if (video !== dyAutoLastVideo) {
                    dyAutoLastVideo = video;
                    dyAutoLastTime = Number(video.currentTime);
                    dyAutoLastProgressAt = now;
                    dyAutoStableSince = now;
                    return;
                }
                const currentTime = Number(video.currentTime);
                if (Number.isFinite(currentTime) &&
                    (!Number.isFinite(dyAutoLastTime) ||
                        Math.abs(currentTime - dyAutoLastTime) > 2 ||
                        currentTime > dyAutoLastTime + 0.05)) {
                    dyAutoLastTime = currentTime;
                    dyAutoLastProgressAt = now;
                    dyAutoStableSince = dyAutoStableSince || now;
                    return;
                }
                dyAutoStableSince = 0;
                if (now - dyAutoLastProgressAt < 15000) return;
                if (now < dyAutoNextReloadAt) return;
                dyAutoNextReloadAt = now + 60000;
                saveDouyinMediaState(video);
                if (!reloadPageForRecovery('抖音原生直播画面停滞', 60000)) {
                    dyAutoNextReloadAt = now + 15000;
                }
            };
            window.setInterval(checkDouyinNativeRecovery, 2000);

            // B 站分屏反复重连仍失败时，会通过 GM 存储请求抖音页刷新，重新抓取推流地址。
            let lastHandledRefreshAt = 0;
            try {
                lastHandledRefreshAt = Number(sessionStorage.getItem('DL_DY_LAST_REFRESH_AT')) || 0;
            } catch (e) {}
            const handleDouyinRefreshRequest = (request) => {
                if (!request || !isAutoRecoverEnabled()) return;
                if (String(request.roomId) !== String(currentRoomId)) return;
                const at = Number(request.at) || 0;
                if (!at || at <= lastHandledRefreshAt) return;
                lastHandledRefreshAt = at;
                try { sessionStorage.setItem('DL_DY_LAST_REFRESH_AT', String(at)); } catch (e) {}
                saveDouyinMediaState(getDouyinNativeVideo());
                setTimeout(() => {
                    reloadPageForRecovery('B站画面请求刷新抖音源', 60000);
                }, 300);
            };
            GM_addValueChangeListener('DY_REFRESH_REQUEST', (name, oldVal, newVal, remote) => {
                if (remote) handleDouyinRefreshRequest(newVal);
            });

        });

    }


    // B站端模块
    if (IS_BILI) {
        // 只处理播放器中明确提示“登录即可畅享蓝光级画质”的横幅。
        // 不更改登录状态、画质或其他登录提示；页面改版时匹配不到便不操作。
        const dismissBiliQualityLoginBanner = () => {
            const player = document.querySelector('#live-player, #live-player-mounter, .bilibili-live-player, .web-player, .bpx-player-container');
            if (!player) return;
            const walker = document.createTreeWalker(player, NodeFilter.SHOW_TEXT);
            let node;
            while ((node = walker.nextNode())) {
                if (!/登录即可畅享蓝光级画质/.test(node.nodeValue || '')) continue;
                let element = node.parentElement;
                for (let depth = 0; element && element !== player && depth < 6; depth++, element = element.parentElement) {
                    const text = element.textContent || '';
                    if (text.length > 300 || !text.includes('注册')) continue;
                    const close = element.querySelector('button[aria-label*="关闭"], [role="button"][aria-label*="关闭"], [class*="close"], [title="关闭"]');
                    if (close && close instanceof HTMLElement) {
                        close.click();
                        return;
                    }
                }
            }
        };
        whenDocumentReady(() => {
            dismissBiliQualityLoginBanner();
            setInterval(dismissBiliQualityLoginBanner, 3000);
        });
        let isUIBuilt = false;
        let streamPlayer = null;
        let dyVideoElement = null;
        let dyDisplayElement = null;
        let playerInitToken = 0;
        let cachedBiliVideo = null;
        let manualDelayAdded = 0;
        let showSourceLabels = GM_getValue('SHOW_SOURCE_LABELS', false) === true;
        let showDouyinDanmaku = GM_getValue('SHOW_DOUYIN_DANMAKU', false) === true;
        let biliSourceLabel = null;
        let dySourceLabel = null;
        let douyinVolumeControl = null;
        let douyinVolumeInput = null;
        let douyinVolumeValue = 0.5;
        let lastNonZeroDouyinVolume = 0.5;
        let nativeVolumeAnchor = null;
        let nativeVolumeAnchorCleanup = null;
        let volumeControlHideTimer = 0;
        let volumeControlActivityContainer = null;
        let volumeControlActivityCleanup = null;
        let offlineBiliHost = null;
        let douyinDanmakuLayer = null;
        const douyinDanmakuQueue = [];
        const activeDanmakuNodes = new Set();
        const danmakuNodePool = [];
        const douyinSidebarHistory = [];
        let douyinSidebarFeed = null;
        const seenDanmakuBatchKeys = new Set();
        const seenDouyinMessageKeys = new Map();
        // 重连后服务端可能补发积压帧；只接收 12 秒内的消息，避免旧弹幕成批涌进评论栏。
        const MAX_DANMAKU_AGE_MS = 12000;
        let danmakuAcceptAfter = Date.now();
        let lastDanmakuRoomScope = '';

        let dyBpsHistory = [];
        let dyLastDecodedBytes = 0;
        let dyLastDecodedTime = Date.now();
        let dyLastFrames = 0, dyLastFrameTime = Date.now();
        let dyLastRenderedFrames = 0;
        let currentDyFormat = '';

        let biliBpsHistory = [];
        let biliLastDecodedBytes = 0;
        let biliLastDecodedTime = Date.now();
        let biliLastFrames = 0, biliLastFrameTime = Date.now();

        let sourceFailed = false;
        let sourceErrorMessage = '';
        let lastRenderedStreamsJson = '';
        let hadActiveBiliVideo = null;
        // 可用性结果只保存在当前 B 站页内；抖音页每 3 秒覆盖 DY_STREAM_MAP
        // 时不会丢失。虽然变量名保留了 LLS 兼容别名，但检测结果现在覆盖三种格式。
        const streamProbeResults = new Map();
        const unplayableStreams = new Set();
        const llsProbeResults = streamProbeResults;
        const unplayableLls = unplayableStreams;
        let streamProbeRunning = false;
        let currentStream = null;
        let lastDyMediaProgressAt = 0;
        let lastDyObservedTime = NaN;
        let overlayRecoveryAttempts = 0;
        let overlayRecoveryNextAt = 0;
        let overlayRecoveryTimer = 0;
        let overlayRecoveryCycleStartedAt = 0;

        // B 站原生播放器断流恢复状态。软重载会重新拉取 playurl，
        // 比整页刷新轻，也不会丢掉当前抖音分屏。
        let biliAutoLastVideo = null;
        let biliAutoLastTime = NaN;
        let biliAutoLastProgressAt = Date.now();
        let biliAutoStableSince = Date.now();
        let biliAutoReloadCount = 0;
        let biliAutoNextReloadAt = 0;
        let biliAutoErrorSince = 0;

        // 控制窗口状态
        let isBiliVisible = true;
        let isDyVisible = true;

        // 记录上次实际排版的节点。全屏切换/切出游戏后 B 站可能重建 video 或播放器容器，
        // 光看“有没有可用 video”无法发现节点已经被替换，需要比较节点身份。
        let lastLaidOutBiliVideo = null;
        let lastLaidOutContainer = null;
        let layoutTimers = [];
        let layoutObserver = null;
        let layoutObserverTarget = null;

        const getBiliVideoCandidates = () => Array.from(document.querySelectorAll('video')).filter(v =>
            v.id !== 'douyin-overlay-video' &&
            v !== dyVideoElement &&
            !v.closest('#douyin-overlay-player')
        );

        // 播放器里可能同时保留一个隐藏的备用 video。它也有 videoWidth/readyState，
        // 但不在视口内；若把分屏样式套到它身上，真正显示的 video 仍会占据整个播放器。
        const isBiliVideoVisible = (video) => {
            if (!video || !video.isConnected) return false;
            const rect = video.getBoundingClientRect();
            if (rect.width < 2 || rect.height < 2) return false;
            const style = window.getComputedStyle(video);
            return style.display !== 'none' &&
                style.visibility !== 'hidden' &&
                Number(style.opacity || 1) > 0;
        };

        // 定位B站Video节点
        const getBiliVideo = () => {
            if (cachedBiliVideo && document.contains(cachedBiliVideo) && cachedBiliVideo.videoWidth > 0 && cachedBiliVideo.readyState >= 2) {
                return cachedBiliVideo;
            }
            // 隔离注入的抖音视频节点
            const vids = getBiliVideoCandidates();
            if (vids.length === 0) return null;

            cachedBiliVideo = vids.find(v => v.videoWidth > 0 && v.readyState >= 2) || vids[0];
            return cachedBiliVideo;
        };

        // 离线直播间可能仍保留空 video；只有已有可解码画面的节点才参与分屏。
        // 优先选真正可见且面积最大的节点，避免选中隐藏的备用 video 后排版错位。
        const getActiveBiliVideo = () => {
            const playable = getBiliVideoCandidates().filter(v => v.videoWidth > 0 && v.readyState >= 2);
            if (playable.length === 0) return null;
            const visible = playable.filter(isBiliVideoVisible);
            const candidates = visible.length ? visible : playable;
            const active = candidates.slice().sort((a, b) => {
                const aRect = a.getBoundingClientRect();
                const bRect = b.getBoundingClientRect();
                return (bRect.width * bRect.height) - (aRect.width * aRect.height);
            })[0];
            if (active) cachedBiliVideo = active;
            return active || null;
        };

        const autoRecoveryPageStartedAt = Date.now();
        const autoRecoveryHistory = [];
        const renderAutoRecoveryHistory = () => {
            const el = document.getElementById('dl-auto-recover-history');
            if (!el) return;
            const timeText = time => new Date(time).toLocaleTimeString('zh-CN', { hour12: false });
            const heading = `本页自动恢复记录（打开于 ${timeText(autoRecoveryPageStartedAt)}）`;
            el.textContent = autoRecoveryHistory.length
                ? heading + '\n' + autoRecoveryHistory.slice().reverse().map(item =>
                    `${timeText(item.time)}｜${item.target}\n原因：${item.reason}\n操作：${item.result}`
                ).join('\n\n')
                : heading + '\n暂无自动重载或重连记录';
        };
        const recordAutoRecovery = (target, reason, result) => {
            autoRecoveryHistory.push({ time: Date.now(), target, reason: String(reason || '未提供原因'), result });
            renderAutoRecoveryHistory();
        };

        const setAutoRecoverStatus = (text, color = '#aaa') => {
            const el = document.getElementById('st-auto-recover');
            if (!el) return;
            if (el.innerText !== text) el.innerText = text;
            el.style.color = color;
        };

        const hasBiliPlayerErrorPanel = () => {
            const panel = document.querySelector('.web-player-error-panel');
            if (!(panel instanceof HTMLElement)) return false;
            const rect = panel.getBoundingClientRect();
            const style = window.getComputedStyle(panel);
            return rect.width > 2 && rect.height > 2 &&
                style.display !== 'none' && style.visibility !== 'hidden';
        };

        // B 站播放器实例的 reload() 会重新请求 playurl 并重建 video，
        // 不会丢页面、分屏和弹幕，优先用它恢复原生 B 站画面。
        const softReloadBiliPlayer = (reason) => {
            let player = null;
            try {
                player = (typeof unsafeWindow !== 'undefined' && unsafeWindow.EmbedPlayer &&
                    unsafeWindow.EmbedPlayer.instance) ||
                    (window.EmbedPlayer && window.EmbedPlayer.instance);
            } catch (error) {}
            if (!player || typeof player.reload !== 'function') return false;
            const oldVideo = getActiveBiliVideo();
            const oldVolume = oldVideo ? oldVideo.volume : null;
            const oldMuted = oldVideo ? oldVideo.muted : null;
            try {
                player.reload();
            } catch (error) {
                console.warn('[DualLive] B站播放器自动重载失败:', error);
                return false;
            }
            console.warn('[DualLive] B站原生播放停滞，已自动重载播放器:', reason);
            if (oldVolume !== null) {
                const restoreVolume = () => {
                    const video = getActiveBiliVideo();
                    if (video) {
                        video.volume = oldVolume;
                        video.muted = oldMuted;
                    }
                };
                // 新 video 创建时间不确定；前几秒快速轮询，避免重载后短暂用默认音量出声。
                let restoreTries = 0;
                const restoreTimer = window.setInterval(() => {
                    restoreVolume();
                    if (++restoreTries >= 40) clearInterval(restoreTimer);
                }, 100);
                setTimeout(restoreVolume, 1500);
                setTimeout(restoreVolume, 3500);
            }
            return true;
        };

        const tryRecoverBiliPlayer = (reason, now) => {
            if (now < biliAutoNextReloadAt) {
                setAutoRecoverStatus(`等待重载…${Math.ceil((biliAutoNextReloadAt - now) / 1000)}s`, '#ffb74d');
                return;
            }
            if (softReloadBiliPlayer(reason)) {
                recordAutoRecovery('B站', reason, '已发起播放器重载');
                biliAutoReloadCount++;
                biliAutoNextReloadAt = now + Math.min(60000, 12000 * Math.pow(1.7, biliAutoReloadCount - 1));
                biliAutoLastProgressAt = now;
                biliAutoStableSince = 0;
                biliAutoErrorSince = 0;
                setAutoRecoverStatus(`已重载播放器（第${biliAutoReloadCount}次）`, '#ffb74d');
            } else {
                recordAutoRecovery('B站', reason, '未能调用播放器重载，请手动刷新');
                biliAutoNextReloadAt = now + 60000;
                setAutoRecoverStatus('无法自动重载，请手动刷新', '#f44336');
            }
        };

        const checkBiliAutoRecovery = () => {
            if (!isAutoRecoverEnabled()) {
                biliAutoLastVideo = null;
                biliAutoErrorSince = 0;
                setAutoRecoverStatus('已关闭', '#888');
                return;
            }
            if (!isBiliVisible) {
                biliAutoLastVideo = null;
                biliAutoErrorSince = 0;
                setAutoRecoverStatus('B站画面已关闭', '#888');
                return;
            }
            const video = getActiveBiliVideo();
            if (!video) {
                biliAutoLastVideo = null;
                biliAutoLastProgressAt = Date.now();
                if (!hasBiliPlayerErrorPanel()) {
                    biliAutoErrorSince = 0;
                    setAutoRecoverStatus('等待B站播放器…', '#888');
                    return;
                }
                const now = Date.now();
                if (!biliAutoErrorSince) biliAutoErrorSince = now;
                if (now - biliAutoErrorSince >= 5000) tryRecoverBiliPlayer('播放器提示错误', now);
                else setAutoRecoverStatus('检测到播放器错误…', '#ffb74d');
                return;
            }
            if (video.paused) {
                biliAutoLastVideo = video;
                biliAutoLastTime = Number(video.currentTime);
                biliAutoLastProgressAt = Date.now();
                biliAutoErrorSince = 0;
                setAutoRecoverStatus('播放器已暂停', '#888');
                return;
            }

            const now = Date.now();
            if (video !== biliAutoLastVideo) {
                biliAutoLastVideo = video;
                biliAutoLastTime = Number(video.currentTime);
                biliAutoLastProgressAt = now;
                biliAutoStableSince = now;
                biliAutoErrorSince = 0;
                setAutoRecoverStatus('监测中', '#4caf50');
                return;
            }

            const currentTime = Number(video.currentTime);
            let progressed = false;
            if (Number.isFinite(currentTime)) {
                if (!Number.isFinite(biliAutoLastTime) ||
                    Math.abs(currentTime - biliAutoLastTime) > 2 ||
                    currentTime > biliAutoLastTime + 0.05) {
                    biliAutoLastTime = currentTime;
                    biliAutoLastProgressAt = now;
                    biliAutoStableSince = biliAutoStableSince || now;
                    progressed = true;
                }
            }

            if (progressed) {
                if (now - biliAutoStableSince >= 20000) biliAutoReloadCount = 0;
                setAutoRecoverStatus('监测中', '#4caf50');
            } else {
                biliAutoStableSince = 0;
            }

            const errorVisible = hasBiliPlayerErrorPanel();
            if (errorVisible) {
                if (!biliAutoErrorSince) biliAutoErrorSince = now;
            } else {
                biliAutoErrorSince = 0;
            }

            const stalledMs = now - biliAutoLastProgressAt;
            const needsRecovery = stalledMs >= 15000 ||
                (errorVisible && biliAutoErrorSince && now - biliAutoErrorSince >= 5000);
            if (!needsRecovery) return;
            const reason = errorVisible ? '播放器提示错误' : `画面停滞${Math.round(stalledMs / 1000)}秒`;
            tryRecoverBiliPlayer(reason, now);
        };

        const biliPlayerSelectors = [
            '#live-player',
            '#live-player-mounter',
            '.bilibili-live-player-video',
            '.live-player-mounter',
            '.web-player-container',
            '.web-player',
            '.bpx-player-container',
            '.bpx-player-video-wrap',
            '.live-player-ctnr',
            '.player-section',
            '.player-ctnr',
            '[class*="live-player-mounter"]',
            '[class*="live-player"]'
        ];

        const isUsableBiliContainer = (el) => {
            if (!(el instanceof HTMLElement) || el === document.body || el.closest('#dual-live-panel')) return false;
            const rect = el.getBoundingClientRect();
            return rect.width >= 200 && rect.height >= 120;
        };

        const findBiliContainer = () => {
            // 优先使用真正可见的播放器节点，避免把抖音画面挂到隐藏的备用 video 的父节点上。
            const vid = getActiveBiliVideo() || getBiliVideo();
            if (vid && vid.parentElement && !vid.parentElement.closest('#dual-live-panel') && isUsableBiliContainer(vid.parentElement)) {
                return vid.parentElement;
            }

            const candidates = [];
            for (const selector of biliPlayerSelectors) {
                document.querySelectorAll(selector).forEach(el => {
                    if (!candidates.includes(el)) candidates.push(el);
                });
            }
            return candidates.find(isUsableBiliContainer) || candidates[0] || (vid && vid.parentElement) || null;
        };

        const createOfflineBiliHost = () => {
            if (offlineBiliHost && document.contains(offlineBiliHost)) return offlineBiliHost;
            const shell = findBiliContainer() || document.querySelector('main, [role="main"]');
            if (!(shell instanceof HTMLElement) || shell === document.body) return null;

            // 离线页可能只保留一个空壳，给它一个最小可见高度，避免 iframe 被布局成 0 高度。
            if (shell.clientHeight < 120) shell.style.minHeight = '240px';
            shell.classList.add('dl-offline-host');
            offlineBiliHost = shell;
            return offlineBiliHost;
        };

        const getPlayerContainer = () => findBiliContainer() || offlineBiliHost;

        const ensureDyDisplayAttached = () => {
            if (!dyDisplayElement) return null;
            const container = getPlayerContainer();
            if (!container) return null;
            if (dyDisplayElement.parentElement !== container) {
                const oldContainer = dyDisplayElement.parentElement;
                container.appendChild(dyDisplayElement);
                if (oldContainer === offlineBiliHost && oldContainer !== container && !oldContainer.children.length) {
                    oldContainer.classList.remove('dl-offline-host');
                }
            }
            return container;
        };

        const clampVolume = (value) => {
            const number = Number(value);
            return Number.isFinite(number) ? Math.max(0, Math.min(1, number)) : 0.5;
        };

        const isDouyinVolumeControlHovered = () => !!(douyinVolumeControl &&
            (douyinVolumeControl.matches(':hover') || douyinVolumeControl.matches(':focus-within')));

        const clearVolumeControlHideTimer = () => {
            if (volumeControlHideTimer) {
                clearTimeout(volumeControlHideTimer);
                volumeControlHideTimer = 0;
            }
        };

        // B 站直播播放器在鼠标静止约 3 秒后会直接移除原生控制栏。
        // 脚本追加的音量按钮不是原生节点，必须自己计时收起，否则会一直留在画面上。
        const showDouyinVolumeControl = () => {
            if (!douyinVolumeControl || !isDyVisible || !dyDisplayElement || !document.contains(dyDisplayElement)) return;
            douyinVolumeControl.hidden = false;
        };

        const hideDouyinVolumeControl = () => {
            clearVolumeControlHideTimer();
            if (!douyinVolumeControl) return;
            douyinVolumeControl.hidden = true;
            douyinVolumeControl.classList.remove('dl-dy-volume-native-hover');
        };

        const scheduleDouyinVolumeControlHide = (delay = 3000) => {
            clearVolumeControlHideTimer();
            volumeControlHideTimer = window.setTimeout(() => {
                volumeControlHideTimer = 0;
                if (!douyinVolumeControl) return;
                if (!isDyVisible || !dyDisplayElement || !document.contains(dyDisplayElement)) {
                    hideDouyinVolumeControl();
                    return;
                }
                // 鼠标停在音量按钮/弹层上时不能消失，否则滑杆会被中途收走。
                if (isDouyinVolumeControlHovered()) {
                    scheduleDouyinVolumeControlHide(1000);
                    return;
                }
                hideDouyinVolumeControl();
            }, delay);
        };

        const revealDouyinVolumeControl = () => {
            if (!douyinVolumeControl || !isDyVisible || !dyDisplayElement || !document.contains(dyDisplayElement)) return;
            showDouyinVolumeControl();
            scheduleDouyinVolumeControlHide();
        };

        const syncDouyinVolumeControlVisibility = () => {
            if (!douyinVolumeControl) return;
            if (!isDyVisible || !dyDisplayElement || !document.contains(dyDisplayElement)) {
                hideDouyinVolumeControl();
                return;
            }
            // 心跳绝不能把已经自动消失的按钮重新显示；
            // 只在“可见但没有计时器”的异常状态下补一个计时器兜底。
            if (!douyinVolumeControl.hidden && !volumeControlHideTimer) {
                scheduleDouyinVolumeControlHide();
            }
        };

        const bindDouyinVolumeControlActivity = (container) => {
            if (!container || volumeControlActivityContainer === container) return;
            if (volumeControlActivityCleanup) volumeControlActivityCleanup();
            let lastActivityAt = 0;
            const onActivity = () => {
                const now = Date.now();
                if (now - lastActivityAt < 200 && !douyinVolumeControl?.hidden) return;
                lastActivityAt = now;
                revealDouyinVolumeControl();
            };
            const onLeave = () => {
                if (!isDouyinVolumeControlHovered()) scheduleDouyinVolumeControlHide(600);
            };
            // B 站画面隐藏后，B 站 video 被设为 pointer-events:none，真实鼠标事件到不了它，
            // B 站原生控制栏就不会再因鼠标移动而出现，看起来像播放器消失了。
            // 这里把真实 pointermove 转发成 B 站 video 上的 mousemove，只唤出原生控制栏，不改变点击行为。
            const forwardPointerToBili = (event) => {
                if (isBiliVisible || !isDyVisible) return;
                const biliVideo = getBiliVideo();
                if (!biliVideo || !biliVideo.isConnected) return;
                try {
                    biliVideo.dispatchEvent(new MouseEvent('mousemove', {
                        clientX: event.clientX,
                        clientY: event.clientY,
                        bubbles: true,
                        cancelable: true,
                        view: window
                    }));
                } catch (e) {}
            };
            container.addEventListener('pointermove', onActivity, { passive: true });
            container.addEventListener('pointermove', forwardPointerToBili, { passive: true });
            container.addEventListener('mousemove', onActivity, { passive: true });
            container.addEventListener('pointerdown', onActivity, { passive: true });
            container.addEventListener('touchstart', onActivity, { passive: true });
            container.addEventListener('pointerleave', onLeave);
            container.addEventListener('mouseleave', onLeave);
            volumeControlActivityContainer = container;
            volumeControlActivityCleanup = () => {
                container.removeEventListener('pointermove', onActivity);
                container.removeEventListener('pointermove', forwardPointerToBili);
                container.removeEventListener('mousemove', onActivity);
                container.removeEventListener('pointerdown', onActivity);
                container.removeEventListener('touchstart', onActivity);
                container.removeEventListener('pointerleave', onLeave);
                container.removeEventListener('mouseleave', onLeave);
            };
        };

        const updateDouyinVolumeControl = () => {
            const value = clampVolume(douyinVolumeValue);
            if (douyinVolumeInput && Number(douyinVolumeInput.value) !== value) {
                douyinVolumeInput.value = String(value);
            }
           const valueLabel = douyinVolumeControl?.querySelector('.dl-dy-volume-value');
            if (valueLabel) valueLabel.innerText = String(Math.round(value * 100));
            const panelInput = document.getElementById('vol-dy');
            if (panelInput && Number(panelInput.value) !== value) panelInput.value = String(value);
        };

       const setDouyinVolume = (value) => {
            const volume = clampVolume(value);
            douyinVolumeValue = volume;
            if (volume > 0) lastNonZeroDouyinVolume = volume;
            updateDouyinVolumeControl();
            if (dyVideoElement) {
                dyVideoElement.volume = volume;
                dyVideoElement.muted = (volume === 0);
            }
            if (dyDisplayElement && dyDisplayElement.id === 'douyin-overlay-player' && streamPlayer) {
                try {
                    if ('volume' in streamPlayer) streamPlayer.volume = volume;
                    if (typeof streamPlayer.setVolume === 'function') streamPlayer.setVolume(volume);
                } catch (e) {}
            }
        };

        const findNativeVolumeAnchor = (container) => {
            const containerRect = container?.getBoundingClientRect();
            const selectors = [
                '.bpx-player-ctrl-volume-icon',
                '.bpx-player-ctrl-volume',
                '[class*="player-ctrl-volume-icon"]',
                '[class*="player-ctrl-volume"]',
                '[aria-label*="音量"]',
                '[title*="音量"]',
                '[aria-label*="volume" i]',
                '[title*="volume" i]'
            ];
            for (const selector of selectors) {
                const candidate = Array.from(document.querySelectorAll(selector)).find(el => {
                    if (!(el instanceof HTMLElement) || el.closest('#dual-live-panel') || el === douyinVolumeControl) return false;
                    const rect = el.getBoundingClientRect();
                    const overlapsContainer = !containerRect || (
                        rect.right >= containerRect.left && rect.left <= containerRect.right &&
                        rect.bottom >= containerRect.top && rect.top <= containerRect.bottom
                    );
                    return rect.width > 0 && rect.height > 0 &&
                        (!container || container.contains(el) || overlapsContainer);
                });
                if (candidate) return candidate;
            }
            return null;
        };

        const positionDouyinVolumeControl = (container) => {
            if (!douyinVolumeControl || !container) return;
            const containerRect = container.getBoundingClientRect();
            const anchor = findNativeVolumeAnchor(container);
            if (nativeVolumeAnchor !== anchor) {
                if (nativeVolumeAnchorCleanup) nativeVolumeAnchorCleanup();
                nativeVolumeAnchor = anchor;
                nativeVolumeAnchorCleanup = null;
                if (anchor) {
                    const show = () => douyinVolumeControl?.classList.add('dl-dy-volume-native-hover');
                    const hide = () => setTimeout(() => {
                        if (!douyinVolumeControl?.matches(':hover')) {
                            douyinVolumeControl?.classList.remove('dl-dy-volume-native-hover');
                        }
                    }, 120);
                    anchor.addEventListener('mouseenter', show);
                    anchor.addEventListener('mouseleave', hide);
                    anchor.addEventListener('focusin', show);
                    anchor.addEventListener('focusout', hide);
                    nativeVolumeAnchorCleanup = () => {
                        anchor.removeEventListener('mouseenter', show);
                        anchor.removeEventListener('mouseleave', hide);
                        anchor.removeEventListener('focusin', show);
                        anchor.removeEventListener('focusout', hide);
                    };
                }
            }
            if (anchor && containerRect.width > 0) {
                const anchorRect = anchor.getBoundingClientRect();
                const controlWidth = 30;
                const maxLeft = Math.max(4, container.clientWidth - controlWidth - 4);
                const left = Math.max(4, Math.min(maxLeft, anchorRect.right - containerRect.left + 4));
                const bottom = Math.max(4, containerRect.bottom - anchorRect.bottom + Math.max(0, (anchorRect.height - 30) / 2));
                douyinVolumeControl.style.left = Math.round(left) + 'px';
                douyinVolumeControl.style.bottom = Math.round(bottom) + 'px';
            } else {
                // B 站未开播或播放器皮肤没有可识别的音量按钮时的稳定兜底位置。
                douyinVolumeControl.style.left = '140px';
                douyinVolumeControl.style.bottom = '8px';
            }
        };

       const ensureDouyinVolumeControl = () => {
            if (!dyDisplayElement) {
               hideDouyinVolumeControl();
                return null;
            }
            const container = ensureDyDisplayAttached();
            if (!container) return null;
            container.classList.add('dl-source-label-host');
           if (!douyinVolumeControl) {
               douyinVolumeControl = document.createElement('div');
               douyinVolumeControl.id = 'dl-dy-volume-control';
               douyinVolumeControl.className = 'dl-dy-volume-control';
               douyinVolumeControl.title = '其它平台源音量';
                douyinVolumeControl.hidden = true;
                douyinVolumeControl.innerHTML =
                    '<button type="button" class="dl-dy-volume-trigger" aria-label="其它平台源音量" title="其它平台源音量">' +
                        '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 9v6h4l5 4V5L7 9H3z"></path><path d="M16 8.5a5 5 0 0 1 0 7M18.5 6a8.5 8.5 0 0 1 0 12"></path></svg>' +
                    '</button>' +
                    '<div class="dl-dy-volume-popover" role="group" aria-label="其它平台源音量">' +
                        '<span class="dl-dy-volume-value">50</span>' +
                        '<input type="range" min="0" max="1" step="0.01" aria-label="其它平台源音量">' +
                        '<span class="dl-dy-volume-speaker" aria-hidden="true">🔊</span>' +
                    '</div>';
                douyinVolumeInput = douyinVolumeControl.querySelector('.dl-dy-volume-popover input');
                douyinVolumeInput.addEventListener('input', (event) => setDouyinVolume(event.target.value));
                douyinVolumeInput.addEventListener('mousedown', event => event.stopPropagation());
                douyinVolumeInput.addEventListener('pointerdown', event => event.stopPropagation());
                const trigger = douyinVolumeControl.querySelector('.dl-dy-volume-trigger');
                trigger.addEventListener('click', event => {
                    event.stopPropagation();
                    setDouyinVolume(douyinVolumeValue > 0 ? 0 : lastNonZeroDouyinVolume);
                });
                trigger.addEventListener('mousedown', event => event.stopPropagation());
                trigger.addEventListener('pointerdown', event => event.stopPropagation());
                douyinVolumeControl.addEventListener('focusin', () => revealDouyinVolumeControl());
                douyinVolumeControl.addEventListener('focusout', () => {
                    if (!isDouyinVolumeControlHovered()) scheduleDouyinVolumeControlHide(600);
                });
            }
            if (douyinVolumeControl.parentElement !== container) container.appendChild(douyinVolumeControl);
            const panelInput = document.getElementById('vol-dy');
            if (panelInput && Number.isFinite(Number(panelInput.value))) douyinVolumeValue = clampVolume(panelInput.value);
            updateDouyinVolumeControl();
            bindDouyinVolumeControlActivity(container);
            positionDouyinVolumeControl(container);
            syncDouyinVolumeControlVisibility();
            return douyinVolumeControl;
        };

        const stopDouyinChat = () => directDanmakuClient.stop();

        const ensureDouyinChat = () => {
            if (!syncDanmakuRoomScope()) { directDanmakuClient.stop(); return; }
            const target = extractRoomId(document.getElementById('inp-dy')?.value || GM_getValue('DY_ROOM_URL', DEFAULT_DY_URL));
            const connection = GM_getValue('DY_CHAT_CONNECTION', null);
            if (connection?.roomId === target) directDanmakuClient.start(connection);
        };

        const ensureDanmakuLayer = () => {
            const playerContainer = getPlayerContainer();
            if (!playerContainer) return null;
            playerContainer.classList.add('dl-source-label-host');
            if (!douyinDanmakuLayer) {
                douyinDanmakuLayer = document.createElement('div');
                douyinDanmakuLayer.id = 'dl-douyin-danmaku-layer';
                douyinDanmakuLayer.className = 'dl-danmaku-layer';
            }
            if (douyinDanmakuLayer.parentElement !== playerContainer) playerContainer.appendChild(douyinDanmakuLayer);
            return douyinDanmakuLayer;
        };

        const recycleDanmakuNode = (node) => {
            if (!node) return;
            activeDanmakuNodes.delete(node);
            node.remove();
            node.textContent = '';
            node.style.transform = '';
            if (danmakuNodePool.length < 30) danmakuNodePool.push(node);
        };

        const findBiliChatList = () => {
            const selectors = [
                '#chat-items',
                '#chat-history-list',
                '.chat-history-list',
                '.chat-history-panel .chat-items',
                '[class*="chat-history-list"]'
            ];
            for (const selector of selectors) {
                const list = document.querySelector(selector);
                if (list) return list;
            }
            return null;
        };

        const createSidebarDanmakuNode = (item) => {
            const row = document.createElement('div');
            row.className = 'dl-dy-sidebar-item';

            const source = document.createElement('span');
            source.className = 'dl-dy-sidebar-source';
            source.textContent = '抖音';

            const nickname = document.createElement('span');
            nickname.className = 'dl-dy-sidebar-name';
            nickname.textContent = item.nickname;

            const content = document.createElement('span');
            content.className = 'dl-dy-sidebar-content';
            content.textContent = `：${item.content}`;

            row.append(source, nickname, content);
            return row;
        };

        const ensureBiliSidebarFeed = () => {
            if (!syncDanmakuRoomScope() || douyinSidebarHistory.length === 0) return null;
            const list = findBiliChatList();
            if (!list) return null;
            if (!douyinSidebarFeed) {
                douyinSidebarFeed = document.createElement('div');
                douyinSidebarFeed.id = 'dl-douyin-sidebar-feed';
                douyinSidebarFeed._rows = [];
            }
            if (douyinSidebarFeed.parentElement !== list) {
                douyinSidebarFeed._rows.forEach(node => node.remove());
                douyinSidebarFeed._rows = [];
                list.appendChild(douyinSidebarFeed);
                // 不能把 douyinSidebarHistory 全量重放：B 站评论栏会周期性重建 DOM，
                // 每次重建都重新插入最多 50 条旧抖音弹幕，看起来就是突然弹出一大堆积压消息。
                // 历史数组只保留数据，评论栏重建后从下一条新弹幕开始显示。
            }
            return douyinSidebarFeed;
        };

        const appendBiliSidebarDanmaku = (items) => {
            if (!syncDanmakuRoomScope() || items.length === 0) return;
            douyinSidebarHistory.push(...items);
            if (douyinSidebarHistory.length > 50) {
                douyinSidebarHistory.splice(0, douyinSidebarHistory.length - 50);
            }

            const list = findBiliChatList();
            if (!list) return;
            let scrollArea = null;
            let candidate = list;
            for (let depth = 0; candidate && depth < 5 && candidate !== document.body; depth++, candidate = candidate.parentElement) {
                if (candidate.clientHeight >= 100 && (candidate.scrollHeight > candidate.clientHeight + 10 ||
                    /auto|scroll/.test(window.getComputedStyle?.(candidate)?.overflowY || ''))) {
                    scrollArea = candidate;
                    break;
                }
            }
            const keepAtBottom = !!scrollArea && scrollArea.scrollHeight - scrollArea.scrollTop - scrollArea.clientHeight < 80;
            const feed = ensureBiliSidebarFeed();
            if (!feed) return;

            // 无论评论栏刚被重建还是一直存在，本批新弹幕只追加一次。
            items.forEach(item => {
                const node = createSidebarDanmakuNode(item);
                feed._rows.push(node);
                list.appendChild(node);
            });
            while (feed._rows.length > 50) feed._rows.shift().remove();
            // 保持容器位置，避免每条新评论都将整组旧评论重新移动到列表末尾。
            if (keepAtBottom && scrollArea) scrollArea.scrollTop = scrollArea.scrollHeight;
        };

        // 仅关闭弹幕、切换房间等原有清理流程调用；切屏及尺寸变化不调用。
        const resetScrollingDanmaku = () => {
            douyinDanmakuQueue.length = 0;
            for (const node of Array.from(activeDanmakuNodes)) {
                const animation = node._dlAnimation;
                if (animation) {
                    animation.onfinish = null;
                    animation.oncancel = null;
                    animation.cancel();
                    node._dlAnimation = null;
                }
                recycleDanmakuNode(node);
            }
        };

        const clearDanmakuDisplay = () => {
            resetScrollingDanmaku();
            douyinSidebarHistory.length = 0;
            if (douyinSidebarFeed) {
                douyinSidebarFeed._rows.forEach(node => node.remove());
                douyinSidebarFeed._rows = [];
                douyinSidebarFeed.remove();
            }
        };

        const updateDanmakuLayer = () => {
            if (!syncDanmakuRoomScope()) return;
            const layer = ensureDanmakuLayer();
            if (!layer) return;
            layer.style.display = 'block';
            const hasDyVideo = !!(dyDisplayElement && document.contains(dyDisplayElement));
            // 以已应用的布局为准，避免切屏时 video 短暂未就绪造成弹幕层上下跳动。
            const split = isDyVisible && hasDyVideo && isBiliVisible &&
                dyDisplayElement.classList.contains('dl-dy-split');
            layer.style.top = split ? '50%' : '0';
            layer.style.height = split ? '50%' : '100%';
        };

        const launchNextDanmaku = () => {
            // 后台仍接收评论；只暂停发射新弹幕，不修改已在滚动的节点或动画。
            if (isPageReallyHidden()) return;
            updateDanmakuLayer();
            if (!syncDanmakuRoomScope() || activeDanmakuNodes.size >= 30 || douyinDanmakuQueue.length === 0) return;
            // 队列拥堵或页面暂停后，丢弃过期弹幕，避免恢复时补播旧消息。
            const cutoff = performance.now() - MAX_DANMAKU_AGE_MS;
            while (douyinDanmakuQueue.length && douyinDanmakuQueue[0].queuedAt < cutoff) douyinDanmakuQueue.shift();
            if (!douyinDanmakuQueue.length) return;
            const layer = ensureDanmakuLayer();
            if (!layer || layer.style.display === 'none' || layer.clientWidth <= 0 || layer.clientHeight <= 0) return;

            const rowHeight = 30;
            const trackCount = Math.max(1, Math.min(30, Math.floor((layer.clientHeight - 8) / rowHeight)));
            // 不再沿用预计释放时间：后台节流或布局改变后，时间表可能与画面不一致。
            // 只读取现有弹幕的位置，从上到下找实际可用的入口，不移动、取消或重启旧弹幕。
            const layerRect = layer.getBoundingClientRect();
            const occupiedEntrances = Array.from(activeDanmakuNodes, node => node.getBoundingClientRect())
                .filter(rect => rect.right + 80 > layerRect.right);
            let track = -1;
            for (let index = 0; index < trackCount; index++) {
                const top = layerRect.top + layer.clientTop + 4 + index * rowHeight;
                if (!occupiedEntrances.some(rect => rect.top < top + 26 && rect.bottom > top)) {
                    track = index;
                    break;
                }
            }
            if (track < 0) return;

            const item = douyinDanmakuQueue.shift();
            const node = danmakuNodePool.pop() || document.createElement('div');
            node.className = 'dl-danmaku-item';
            // 画面弹幕只显示正文；昵称仅保留在右侧评论栏中。
            node.textContent = item.content;
            node.style.top = `${4 + track * rowHeight}px`;
            layer.appendChild(node);
            activeDanmakuNodes.add(node);

            const textWidth = Math.max(20, node.getBoundingClientRect().width);
            const layerWidth = layer.clientWidth;
            const duration = Math.min(14000, Math.max(8000, 7000 + node.textContent.length * 60));

            let cleaned = false;
            const finish = () => {
                if (cleaned) return;
                cleaned = true;
                node._dlAnimation = null;
                recycleDanmakuNode(node);
            };
            node._dlAnimation = node.animate([
                { transform: `translateX(${layerWidth}px)` },
                { transform: `translateX(-${textWidth}px)` }
            ], { duration, easing: 'linear' });
            node._dlAnimation.onfinish = finish;
            node._dlAnimation.oncancel = finish;
        };

        const getDanmakuBatchKey = (batch) => {
            if (!batch || typeof batch !== 'object') return '';
            return `${batch.roomId || ''}:${batch.sessionId || 'legacy'}:${batch.sequence || ''}:${batch.time || ''}`;
        };
        const rememberBatchKey = (key) => {
            if (!key || seenDanmakuBatchKeys.has(key)) return;
            seenDanmakuBatchKeys.add(key);
            if (seenDanmakuBatchKeys.size > 500) {
                seenDanmakuBatchKeys.delete(seenDanmakuBatchKeys.values().next().value);
            }
        };

        const primeLatestDanmakuBatch = () => {
            // GM_setValue 保存的是“最后一批”；初始化/重新开启时只把它设为游标，不补播。
            rememberBatchKey(getDanmakuBatchKey(GM_getValue('DY_DANMAKU_BATCH', null)));
        };

        // 所有 B 站标签页共享油猴配置，但只有配置指定的直播间能接收和显示弹幕。
        // 房间、目标或开关改变时清空显示，并从最新批次之后接收，防止切回时补播。
        const syncDanmakuRoomScope = () => {
            const targetId = getBiliLiveRoomId(GM_getValue('BILI_ROOM_URL', DEFAULT_BILI_URL));
            const currentId = getBiliLiveRoomId(location.href);
            const scope = `${showDouyinDanmaku ? 1 : 0}:${targetId}:${currentId}`;
            if (scope !== lastDanmakuRoomScope) {
                lastDanmakuRoomScope = scope;
                clearDanmakuDisplay();
                directDanmakuClient.stop();
                if (douyinDanmakuLayer) douyinDanmakuLayer.style.display = 'none';
                danmakuAcceptAfter = Date.now();
                primeLatestDanmakuBatch();
            }
            return showDouyinDanmaku && !!targetId && targetId === currentId;
        };

        const consumeDanmakuBatch = (batch) => {
            if (!syncDanmakuRoomScope() || !batch || batch.source !== 'websocket' || !Array.isArray(batch.items)) return;
            const targetDyUrl = document.getElementById('inp-dy')?.value || GM_getValue('DY_ROOM_URL', DEFAULT_DY_URL);
            if (String(batch.roomId || '') !== extractRoomId(targetDyUrl)) return;

            // 同一批可能同时由 GM 监听与轮询读到；按采集会话和序号去重。
            const batchKey = getDanmakuBatchKey(batch);
            if (!batchKey || seenDanmakuBatchKeys.has(batchKey)) return;
            rememberBatchKey(batchKey);
            const batchTime = Number(batch.time) || 0;
            if (batchTime <= danmakuAcceptAfter) return;

            const receivedItems = [];
            for (const item of batch.items) {
                if (!item || typeof item.nickname !== 'string' || typeof item.content !== 'string') continue;
                const observedAt = Number(item.observedAt);
                const createdAt = Number(item.createdAt);
                if (!Number.isFinite(observedAt) || !Number.isFinite(createdAt) ||
                    createdAt <= danmakuAcceptAfter || observedAt < createdAt ||
                    observedAt - createdAt > MAX_DANMAKU_AGE_MS ||
                    typeof item.messageId !== 'string' || !item.messageId) continue;
                const nickname = item.nickname.slice(0, 60);
                const content = item.content.slice(0, 200);
                const messageKey = `${batch.roomId}:${item.messageId}`;
                const now = Date.now();
                if (seenDouyinMessageKeys.has(messageKey)) continue;
                seenDouyinMessageKeys.set(messageKey, now);
                if (seenDouyinMessageKeys.size > 10000) {
                    seenDouyinMessageKeys.delete(seenDouyinMessageKeys.values().next().value);
                }
                const received = { nickname, content };
                receivedItems.push(received);
                douyinDanmakuQueue.push({ ...received, queuedAt: performance.now() });
            }
            if (douyinDanmakuQueue.length > 100) {
                douyinDanmakuQueue.splice(0, douyinDanmakuQueue.length - 100);
            }
            appendBiliSidebarDanmaku(receivedItems);
        };

        let directDanmakuSequence = 0;
        const directDanmakuSession = `direct-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        const directDanmakuClient = createDouyinDirectClient((items, roomId) => {
            consumeDanmakuBatch({ roomId, source: 'websocket', time: Date.now(),
                sessionId: directDanmakuSession, sequence: ++directDanmakuSequence, items });
        }, state => {
            const control = document.getElementById('chk-show-danmaku');
            if (control) control.title = `抖音弹幕：${state}`;
            if (state.includes('失效') || state.includes('阻止')) console.warn('[DualLive] 抖音弹幕：' + state);
        });
        GM_addValueChangeListener('DY_ROOM_URL', (name, oldValue, value, remote) => {
            if (!remote || oldValue === value) return;
            const input = document.getElementById('inp-dy');
            if (input) input.value = String(value || '');
            clearDanmakuDisplay();
            directDanmakuClient.stop();
            danmakuAcceptAfter = Date.now();
            primeLatestDanmakuBatch();
            ensureDouyinChat();
        });
        GM_addValueChangeListener('DY_CHAT_CONNECTION', () => ensureDouyinChat());
        window.addEventListener('pagehide', () => directDanmakuClient.stop());

        // 页面启动时先记录当前末批，禁止把上次会话残留的评论当作新弹幕。
        syncDanmakuRoomScope();
        ensureDouyinChat();
        GM_addValueChangeListener('DY_DANMAKU_BATCH', (name, oldValue, batch) => consumeDanmakuBatch(batch));
        GM_addValueChangeListener('BILI_ROOM_URL', (name, oldValue, value) => {
            const input = document.getElementById('inp-bili');
            if (input) input.value = String(value || '');
            syncDanmakuRoomScope();
            updateDanmakuLayer();
        });

        // 轮询只补偿漏掉的变更通知；时间游标和批次签名会阻止旧批次重放。
        setInterval(() => consumeDanmakuBatch(GM_getValue('DY_DANMAKU_BATCH', null)), 800);

        setInterval(launchNextDanmaku, 100);

        const getBiliQualityFromDOM = () => {
            try {
                const resultSelectors = [
                    '.bpx-player-ctrl-quality-result',
                    '.bilibili-live-player-quality-selector-btn-text',
                    '.quality-wrap .quality-it',
                    '.quality-it'
                ];
                for (let sel of resultSelectors) {
                    const el = document.querySelector(sel);
                    if (el) {
                        let txt = (el.innerText || el.textContent || '').trim();
                        if (txt && txt.length <= 25 && !txt.includes('\n')) {
                            if (['原画', '蓝光', '超清', '高清', '流畅', '4K', '2K', '自动'].some(q => txt.includes(q))) {
                                return txt;
                            }
                        }
                    }
                }

                const activeItem = document.querySelector('.bpx-player-ctrl-quality-menu-item.bpx-state-active, .quality-it.active, .quality-it.selected');
                if (activeItem) {
                    let txt = (activeItem.innerText || activeItem.textContent || '').trim();
                    if (txt && txt.length <= 25 && !txt.includes('\n')) {
                        return txt;
                    }
                }
            } catch(e) {}
            return null;
        };

        const detectBiliActiveProtocolAndCodec = () => {
            let format = 'FLV';
            let codec = 'H264';
            try {
                const resources = performance.getEntriesByType('resource');
                for (let i = resources.length - 1; i >= 0 && i >= resources.length - 30; i--) {
                    const name = resources[i].name;
                    if (name.includes('bilivideo.com') || name.includes('/live-bvc/')) {
                        if (name.includes('.m3u8') || name.includes('.ts') || name.includes('/index.m3u8')) {
                            format = 'HLS';
                        } else if (name.includes('.flv')) {
                            format = 'FLV';
                        }

                        if (name.includes('hevc') || name.includes('hvc1') || name.includes('codec=1')) {
                            codec = 'H265';
                        } else if (name.includes('avc') || name.includes('codec=0')) {
                            codec = 'H264';
                        } else if (name.includes('av1') || name.includes('codec=2')) {
                            codec = 'AV1';
                        }
                        break;
                    }
                }
            } catch(e) {}
            return { format, codec };
        };

        // 抓取B站直播流的信息
        const getBiliStreamInfo = (bVid) => {
            try {
                const { format, codec } = detectBiliActiveProtocolAndCodec();
                let currentQualityName = getBiliQualityFromDOM();

                if (!currentQualityName && bVid && bVid.videoHeight > 0) {
                    let h = bVid.videoHeight;
                    if (h >= 1080) currentQualityName = "1080P 蓝光/原画";
                    else if (h >= 720) currentQualityName = "720P 超清";
                    else if (h >= 480) currentQualityName = "480P 高清";
                    else currentQualityName = "360P 流畅";
                }

                if (!currentQualityName) currentQualityName = "原画/蓝光";

                return `${currentQualityName} [${format} / ${codec}]`;
            } catch(e) {}

            return '原画/蓝光 [FLV / H264]';
        };

        // 浮窗UI面板构建
        GM_registerMenuCommand('⚙️ 开启浮动面板', () => {
            if (!document.getElementById('dual-live-panel')) isUIBuilt = false;

            if (!isUIBuilt) {
                if (document.body) {
                    initUI();
                } else {
                    return;
                }
            }
            const panel = document.getElementById('dual-live-panel');
            if (panel) {
                if (panel.style.display === 'none' || panel.style.display === '') {
                    // 每次打开面板时重新抓取B站音量
                    const bVid = getBiliVideo();
                    const volBili = document.getElementById('vol-bili');
                    if (bVid && volBili) {
                        volBili.value = bVid.volume;
                    }
                    panel.style.display = 'block';
                } else {
                    panel.style.display = 'none';
                    closeStreamPicker();
                }
            }
        });

        const initUI = () => {
            if (isUIBuilt || document.getElementById('dual-live-panel')) return;
            const savedBili = GM_getValue('BILI_ROOM_URL', DEFAULT_BILI_URL);
            const savedDy = GM_getValue('DY_ROOM_URL', DEFAULT_DY_URL);
            // 获取当前B站音量
            let initBiliVol = 0.5; // 默认音量50%
            const initBVid = getBiliVideo();
            if (initBVid) initBiliVol = initBVid.volume;

            // 分屏排版
            GM_addStyle(`
                #dual-live-panel { position:fixed; top:80px; right:20px; width:340px; background:rgba(30,30,30,0.95); color:#fff; z-index:999999; border:1px solid #444; border-radius:8px; box-shadow:0 0 15px rgba(0,0,0,0.5); font-size:12px; font-family:Microsoft YaHei,sans-serif; backdrop-filter:blur(5px); display:none; }
                #dual-live-panel-header { padding:10px; background:#222; border-bottom:1px solid #444; cursor:move; font-weight:bold; font-size:14px; border-radius:8px 8px 0 0; display:flex; justify-content:space-between; }
                .dl-section { padding:10px; border-bottom:1px dashed #444; }
                .dl-title { color:#00a1d6; font-weight:bold; margin-bottom:5px; display:flex; justify-content:space-between; align-items:center; }
                .dl-row { margin-bottom:5px; display:flex; align-items:center; justify-content:space-between; }
                .dl-input { width:135px; background:#111; color:#fff; border:1px solid #555; padding:3px; border-radius:3px; }
                .dl-btn { background:#00a1d6; color:#fff; border:none; padding:4px 8px; border-radius:4px; cursor:pointer; font-size:12px; }
                .dl-btn:hover { background:#00b5e5; }
                .dl-btn-reset { padding: 3px 6px; background:#e84f4f; }
                .dl-btn-reset:hover { background:#ff5c5c; }
                .dl-btn-open { padding: 3px 6px; }
                .dl-btn-danger { background:#e84f4f; }
                .dl-btn-save { background:#4caf50; }
                .dl-status-green { color:#4caf50; font-weight:bold; }
                .dl-recovery-history-host { position:relative; cursor:help; }
                #dl-auto-recover-history {
                    display:none; position:absolute; right:0; top:100%; width:310px;
                    max-width:80vw; max-height:240px; overflow-y:auto; box-sizing:border-box;
                    padding:10px; color:#ddd; background:#111; border:1px solid #555;
                    border-radius:4px; font:12px/1.6 Microsoft YaHei,sans-serif;
                    white-space:pre-wrap; overflow-wrap:anywhere; z-index:10;
                }
                .dl-recovery-history-host:hover #dl-auto-recover-history,
                .dl-recovery-history-host:focus-within #dl-auto-recover-history { display:block; }
                .dl-status-red { color:#f44336; font-weight:bold; }
                select.dl-input { width: 100%; margin-top:5px; outline:none; }
                #dy-stream-select { display:none; }
                .dl-stream-trigger { width:100%; box-sizing:border-box; margin-top:5px; padding:3px 24px 3px 5px; position:relative;
                    background:#111; color:#fff; border:1px solid #555; border-radius:3px; text-align:left;
                    white-space:nowrap; overflow:hidden; text-overflow:ellipsis; cursor:pointer; font:inherit; }
                .dl-stream-trigger::after { content:'▾'; position:absolute; right:10px; color:#aaa; }
                #dl-stream-popup { position:fixed; z-index:1000000; overflow-y:auto; overscroll-behavior:contain;
                    box-sizing:border-box; background:#111; color:#fff; border:1px solid #777;
                    border-radius:0; padding:0; scrollbar-width:auto; }
                #dl-stream-popup[hidden] { display:none; }
                .dl-stream-heading { color:#aaa; background:transparent; padding:6px 5px; margin:0;
                    font:inherit; white-space:pre-line; }
                .dl-stream-codec-group { display:grid; grid-template-columns:minmax(0,1fr) 25px; }
                .dl-stream-option { display:block; width:100%; box-sizing:border-box; border:0; border-radius:0;
                    padding:6px 5px; background:transparent; color:#fff; cursor:pointer; text-align:left;
                    font:inherit; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
                .dl-stream-option:hover,.dl-stream-option:focus-visible,
                .dl-stream-option[aria-selected="true"] { background:#9ecbff; color:#192c40; outline:none; box-shadow:none; }
                .dl-stream-codec-rail { display:flex; flex-direction:column; align-items:center; gap:10px;
                    padding:10px 0; color:#aaa; background:#111; }
                .dl-stream-codec-rail::before,.dl-stream-codec-rail::after { content:''; width:1px;
                    min-height:8px; flex:1; background:currentColor; opacity:.35; }
                .dl-stream-codec-rail span { writing-mode:vertical-rl; text-orientation:upright;
                    font:12px/1 Consolas,monospace; letter-spacing:3px; }
                input[type=range] { width: 100px; vertical-align: middle; }

                .dl-source-label-host { position: relative !important; }
                .dl-offline-host {
                    position: relative !important;
                    overflow: hidden !important;
                    background: #000 !important;
                }
                .dl-source-label {
                    position: absolute !important;
                    left: 6px !important;
                    right: auto !important;
                    padding: 2px !important;
                    color: #76b900 !important;
                    background: transparent !important;
                    border: none !important;
                    border-radius: 0 !important;
                    font: bold 12px/1 Consolas, "Courier New", monospace !important;
                    letter-spacing: 0 !important;
                    -webkit-font-smoothing: none !important;
                    text-shadow: none !important;
                    box-shadow: none !important;
                    pointer-events: none !important;
                    user-select: none !important;
                    z-index: 2147483000 !important;
                }
               .dl-dy-volume-control {
                    position: absolute !important;
                    left: 140px !important;
                    bottom: 8px !important;
                    width: 30px !important;
                    height: 30px !important;
                    box-sizing: border-box !important;
                    pointer-events: auto !important;
                    user-select: none !important;
                    z-index: 2147483001 !important;
                }
               .dl-dy-volume-control[hidden] { display: none !important; }
                .dl-dy-volume-trigger {
                    display: flex !important;
                    align-items: center !important;
                    justify-content: center !important;
                    width: 30px !important;
                    height: 30px !important;
                    padding: 4px !important;
                    border: 0 !important;
                    border-radius: 3px !important;
                    background: transparent !important;
                    color: #fff !important;
                    cursor: pointer !important;
                }
                .dl-dy-volume-trigger:hover,
                .dl-dy-volume-trigger:focus-visible {
                    background: rgba(0, 0, 0, .55) !important;
                    outline: none !important;
                }
                .dl-dy-volume-trigger svg {
                    width: 22px !important;
                    height: 22px !important;
                    fill: none !important;
                    stroke: currentColor !important;
                    stroke-width: 1.8 !important;
                    stroke-linecap: round !important;
                    stroke-linejoin: round !important;
                }
                .dl-dy-volume-trigger svg path:first-child {
                    fill: currentColor !important;
                    stroke: none !important;
                }
                .dl-dy-volume-popover {
                    position: absolute !important;
                    left: calc(100% + 4px) !important;
                    bottom: 0 !important;
                    width: 34px !important;
                    min-height: 106px !important;
                    padding: 5px 4px !important;
                    display: flex !important;
                    flex-direction: column !important;
                    align-items: center !important;
                    justify-content: center !important;
                    gap: 3px !important;
                    box-sizing: border-box !important;
                    color: #fff !important;
                    background: rgba(0, 0, 0, .78) !important;
                    border-radius: 4px !important;
                    font: 11px/1 Microsoft YaHei, sans-serif !important;
                    visibility: hidden !important;
                    opacity: 0 !important;
                    pointer-events: none !important;
                    transform: translateY(4px) !important;
                    transition: opacity .12s ease, transform .12s ease, visibility .12s ease !important;
                }
                .dl-dy-volume-control:hover .dl-dy-volume-popover,
                .dl-dy-volume-control.dl-dy-volume-native-hover .dl-dy-volume-popover,
                .dl-dy-volume-control:focus-within .dl-dy-volume-popover {
                    visibility: visible !important;
                    opacity: 1 !important;
                    pointer-events: auto !important;
                    transform: translateY(0) !important;
                }
                .dl-dy-volume-popover input[type=range] {
                    width: 8px !important;
                    height: 78px !important;
                    margin: 0 !important;
                    padding: 0 !important;
                    writing-mode: vertical-lr !important;
                    direction: rtl !important;
                    accent-color: #fff !important;
                    cursor: pointer !important;
                }
                .dl-dy-volume-value {
                    min-width: 22px !important;
                    text-align: center !important;
                    color: #fff !important;
                }

                .dl-danmaku-layer {
                    position: absolute !important;
                    left: 0 !important;
                    width: 100% !important;
                    overflow: hidden !important;
                    pointer-events: none !important;
                    user-select: none !important;
                    /* 高于两路视频，避免B站原生弹幕穿透到下方抖音画面。 */
                    z-index: 21 !important;
                }
                .dl-danmaku-item {
                    position: absolute !important;
                    left: 0 !important;
                    white-space: nowrap !important;
                    color: #fff !important;
                    font: bold 20px/26px Microsoft YaHei, sans-serif !important;
                    text-shadow: -1px -1px 1px #000, 1px -1px 1px #000, -1px 1px 1px #000, 1px 1px 1px #000 !important;
                    will-change: transform !important;
                }
                #dl-douyin-sidebar-feed {
                    display: block !important;
                    margin: 5px 6px !important;
                    font: 13px/1.45 Microsoft YaHei, sans-serif !important;
                }
                .dl-dy-sidebar-item {
                    display: block !important;
                    font: 13px/1.45 Microsoft YaHei, sans-serif !important;
                    margin: 3px 0 !important;
                    padding: 5px 7px !important;
                    color: #fff !important;
                    background: rgba(0, 0, 0, 0.72) !important;
                    border-left: 3px solid #666 !important;
                    border-radius: 3px !important;
                    overflow-wrap: anywhere !important;
                }
                .dl-dy-sidebar-source {
                    margin-right: 6px !important;
                    padding: 1px 4px !important;
                    color: #fff !important;
                    background: #444 !important;
                    border-radius: 3px !important;
                    font-size: 11px !important;
                }
                .dl-dy-sidebar-name { color: #ddd !important; font-weight: bold !important; }
                .dl-dy-sidebar-content { color: #fff !important; }

                .dl-bili-split {
                    position: absolute !important;
                    top: 0 !important;
                    left: 0 !important;
                    width: 100% !important;
                    height: 50% !important;
                    object-fit: contain !important;
                    transform: none !important;
                    margin: 0 !important;
                    opacity: 1 !important;
                    z-index: 0 !important;
                    pointer-events: auto !important;
                }

                /* 容器级兜底：B 站 React 在进出全屏/切回前台时可能重建 video，
                   新节点拿不到 dl-bili-split。只要播放器容器还带着 dl-split-host，
                   新 video 也会立即只占上半屏，避免整幅画面压到抖音分屏下面。 */
                .dl-split-host video:not(#douyin-overlay-video) {
                    position: absolute !important;
                    top: 0 !important;
                    left: 0 !important;
                    width: 100% !important;
                    height: 50% !important;
                    object-fit: contain !important;
                    transform: none !important;
                    margin: 0 !important;
                    opacity: 1 !important;
                    z-index: 0 !important;
                    pointer-events: auto !important;
                }

                .dl-dy-split {
                    position: absolute !important;
                    top: 50% !important;
                    left: 0 !important;
                    width: 100% !important;
                    height: 50% !important;
                    object-fit: contain !important;
                    /* 遮住落在下半区的B站原生弹幕；B站控制栏仍可显示在更高层。 */
                    z-index: 20 !important;
                    pointer-events: none !important;
                    display: block !important;
                }

                .dl-bili-dyonly {
                    opacity: 0 !important;
                    pointer-events: none !important;
                }

                /* 只看抖音画面时，B 站原生弹幕容器仍然存在，但默认层级低于抖音画面（20）。
                   把原生弹幕容器提到抖音画面之上，关闭B站视频后仍能看到B站弹幕；
                   分屏/纯B站模式下不设置这个属性，保持原来的上下分区关系。 */
                [data-dl-bili-picture-off="1"] .web-player-danmaku,
                [data-dl-bili-picture-off="1"] .bpx-player-danmaku,
                [data-dl-bili-picture-off="1"] .fullscreen-danmaku-container,
                [data-dl-bili-picture-off="1"] .fullscreen-danmaku {
                    z-index: 22 !important;
                    pointer-events: none !important;
                }
                [data-dl-bili-picture-off="1"] .web-player-controller-wrap,
                [data-dl-bili-picture-off="1"] .live-web-player-controller,
                [data-dl-bili-picture-off="1"] .web-player-controller-bg,
                [data-dl-bili-picture-off="1"] .web-player__bottom-bar__container {
                    z-index: 23 !important;
                }
                /* 上下分屏时抖音画面覆盖下半屏，B 站原生控制栏默认 z-index:13 会被压在下面。
                   只提升 B 站控制栏的层级，不改 B 站播放器自身的显示/隐藏逻辑。 */
                .dl-split-host .web-player-controller-wrap,
                .dl-split-host .live-web-player-controller,
                .dl-split-host .web-player-controller-bg,
                .dl-split-host .web-player__bottom-bar__container {
                    z-index: 23 !important;
                }

                .dl-dy-dyonly {
                    position: absolute !important;
                    top: 0 !important;
                    left: 0 !important;
                    width: 100% !important;
                    height: 100% !important;
                    object-fit: contain !important;
                    z-index: 20 !important;
                    pointer-events: none !important;
                    display: block !important;
                }

                .dl-dy-hidden {
                    display: none !important;
                    opacity: 0 !important;
                    pointer-events: none !important;
                }

                #douyin-overlay-player {
                    overflow: hidden !important;
                    background: #000 !important;
                }
                #douyin-overlay-player video,
                #douyin-overlay-player canvas {
                    width: 100% !important;
                    height: 100% !important;
                    object-fit: contain !important;
                }
            `);

            const panel = document.createElement('div');
            panel.id = 'dual-live-panel';
            panel.innerHTML = `
                <div id="dual-live-panel-header">
                    <span>⚙️ 联动控制面板</span>
                    <span style="cursor:pointer;" id="dl-panel-close">✖</span>
                </div>

                <div class="dl-section">
                    <div class="dl-title"><span>直播间运行检测</span></div>
                    <div class="dl-row">B站页面状态：<span id="st-bili" class="dl-status-red">❌ 未检测到</span></div>
                    <div class="dl-row">抖音页面状态：<span id="st-dy" class="dl-status-red">❌ 未检测到</span></div>
                </div>

                <div class="dl-section">
                    <div class="dl-title"><span>直播间参数入口</span></div>
                    <div class="dl-row">
                        <span>B站:</span>
                        <input class="dl-input" id="inp-bili" value="${savedBili}">
                        <button class="dl-btn dl-btn-reset" id="btn-reset-bili">重置</button>
                        <button class="dl-btn dl-btn-open" id="btn-open-bili">打开</button>
                    </div>
                    <div class="dl-row">
                        <span>抖音:</span>
                        <input class="dl-input" id="inp-dy" value="${savedDy}">
                        <button class="dl-btn dl-btn-reset" id="btn-reset-dy">重置</button>
                        <button class="dl-btn dl-btn-open" id="btn-open-dy">打开</button>
                    </div>
                </div>

                <div class="dl-section">
                    <div class="dl-title">
                        <span>抖音推流源选择</span>
                        <span style="display:flex; gap:4px; align-items:center;">
                            <button class="dl-btn" id="btn-detect-lls" style="padding: 2px 5px; font-size:10px; background:#6b7fd7;">🔍 测试可用性</button>
                            <button class="dl-btn" id="btn-refresh-streams" style="padding: 2px 5px; font-size:10px; background:#4f9be8;">🔄 手动清除缓存</button>
                        </span>
                    </div>
                    <select class="dl-input" id="dy-stream-select">
                        <option value="">等待嗅探数据...</option>
                    </select>
                    <button type="button" id="dl-stream-trigger" class="dl-stream-trigger" aria-haspopup="listbox"
                        aria-controls="dl-stream-popup" aria-expanded="false">等待嗅探数据...</button>
                    <div id="dl-stream-popup" role="listbox" aria-label="抖音播放源" hidden></div>
                    <div style="margin-top:8px;">
                        <button class="dl-btn" id="btn-play-dy" style="width:100%;">▶ 载入并在B站同屏播放</button>
                    </div>
                </div>

                <div class="dl-section">
                    <div class="dl-title"><span>音画控制</span></div>
                    <div class="dl-row">B站音量: <input type="range" id="vol-bili" min="0" max="1" step="0.01" value="${initBiliVol}"></div>
                    <div class="dl-row">抖音音量: <input type="range" id="vol-dy" min="0" max="1" step="0.01" value="0.5"></div>
                    <div class="dl-row">
                        <label for="chk-show-source" style="cursor:pointer; user-select:none;">
                            <input type="checkbox" id="chk-show-source" ${showSourceLabels ? 'checked' : ''}> 显示来源
                        </label>
                        <label for="chk-show-danmaku" style="cursor:pointer; user-select:none;">
                            <input type="checkbox" id="chk-show-danmaku" ${showDouyinDanmaku ? 'checked' : ''}> 显示抖音弹幕
                        </label>
                    </div>
                    <div class="dl-row">
                        <label for="chk-auto-recover" style="cursor:pointer; user-select:none;" title="B站画面停住时软重载播放器；抖音源失效时自动重连或刷新源页面">
                            <input type="checkbox" id="chk-auto-recover" ${isAutoRecoverEnabled() ? 'checked' : ''}> 断流自动恢复
                        </label>
                        <span class="dl-recovery-history-host" tabindex="0" aria-label="查看本页自动恢复记录">
                            <span id="st-auto-recover" style="color:${isAutoRecoverEnabled() ? '#4caf50' : '#888'};">${isAutoRecoverEnabled() ? '监测中' : '已关闭'}</span>
                            <span id="dl-auto-recover-history" role="tooltip"></span>
                        </span>
                    </div>
                    <div class="dl-row">
                        手动增加延迟:
                        <button class="dl-btn" id="btn-delay-add">+0.5s</button>
                        <button class="dl-btn" id="btn-delay-reset">重置</button>
                    </div>
                    <div class="dl-row">累计手动延后: <span id="txt-manual-delay" style="color:#fa739b;">0.0 s</span></div>
                    <!-- 将原先按钮替换为切换独立开关的按钮 -->
                    <div class="dl-row" style="margin-top:8px;">
                        <button class="dl-btn" id="btn-layout-split">上下分屏</button>
                        <button class="dl-btn dl-btn-danger" id="btn-toggle-dy">关闭抖音画面</button>
                        <button class="dl-btn dl-btn-danger" id="btn-toggle-bili">关闭B站画面</button>
                    </div>
                </div>

                <div class="dl-section">
                    <div class="dl-title"><span>B站实时状态监控</span></div>
                    <div class="dl-row">视频画质：<span id="si-bili-quality">-</span></div>
                    <div class="dl-row">分辨率/帧率：<span id="si-bili-res">-</span></div>
                    <div class="dl-row">近10s平均码率：<span id="si-bili-bitrate" style="color:#00a1d6;font-weight:bold;">0.00 Mbps</span></div>
                    <div class="dl-row"><span id="si-bili-latency-label">缓冲区积压延迟：</span><span id="si-bili-latency" style="color:#f44336;font-weight:bold;">0.00 s</span></div>
                </div>

                <div class="dl-section" style="border:none;">
                    <div class="dl-title"><span>抖音实时状态监控</span></div>
                    <div class="dl-row">视频画质：<span id="si-dy-quality">-</span></div>
                    <div class="dl-row">分辨率/帧率：<span id="si-dy-res">-</span></div>
                    <div class="dl-row">近10s平均码率：<span id="si-dy-bitrate" style="color:#00a1d6;font-weight:bold;">0.00 Mbps</span></div>
                    <div class="dl-row"><span id="si-dy-latency-label">缓冲区积压延迟：</span><span id="si-dy-latency" style="color:#f44336;font-weight:bold;">0.00 s</span></div>
                </div>
            `;
            document.body.appendChild(panel);
            attachEventListeners(panel);
            initStreamPicker();
            renderAutoRecoveryHistory();
            startHeartbeat();
            isUIBuilt = true;
            updateSourceLabels();
            updateDanmakuLayer();
        };

        const ensureSourceLabels = () => {
            const playerContainer = getPlayerContainer();
            if (!playerContainer) return false;

            playerContainer.classList.add('dl-source-label-host');

            if (!biliSourceLabel) {
                biliSourceLabel = document.createElement('div');
                biliSourceLabel.id = 'dl-source-bili';
                biliSourceLabel.className = 'dl-source-label';
                biliSourceLabel.textContent = 'BiliBili';
            }
            if (!dySourceLabel) {
                dySourceLabel = document.createElement('div');
                dySourceLabel.id = 'dl-source-dy';
                dySourceLabel.className = 'dl-source-label';
                dySourceLabel.textContent = 'Douyin';
            }

            if (biliSourceLabel.parentElement !== playerContainer) playerContainer.appendChild(biliSourceLabel);
            if (dySourceLabel.parentElement !== playerContainer) playerContainer.appendChild(dySourceLabel);
            return true;
        };

        const updateSourceLabels = () => {
            if (!ensureSourceLabels()) return;

            const hasDyVideo = !!(dyDisplayElement && document.contains(dyDisplayElement));
            const showBili = showSourceLabels && isBiliVisible && !!getActiveBiliVideo();
            const showDy = showSourceLabels && isDyVisible && hasDyVideo;

            biliSourceLabel.style.display = showBili ? 'block' : 'none';
            dySourceLabel.style.display = showDy ? 'block' : 'none';
            biliSourceLabel.style.top = '6px';
            dySourceLabel.style.top = showBili && showDy ? 'calc(50% + 6px)' : '6px';
        };

        const closeStreamPicker = (focusTrigger = false) => {
            const popup = document.getElementById('dl-stream-popup');
            const trigger = document.getElementById('dl-stream-trigger');
            if (popup) popup.hidden = true;
            trigger?.setAttribute('aria-expanded', 'false');
            if (focusTrigger) trigger?.focus();
        };

        const renderStreamPicker = () => {
            const select = document.getElementById('dy-stream-select');
            const popup = document.getElementById('dl-stream-popup');
            const trigger = document.getElementById('dl-stream-trigger');
            if (!select || !popup || !trigger) return;
            trigger.textContent = select.selectedOptions[0]?.textContent || '等待播放源...';
            trigger.title = trigger.textContent;
            const scrollTop = popup.scrollTop;
            const focusedValue = popup.contains(document.activeElement) ? document.activeElement.dataset.value : null;
            popup.replaceChildren();
            let group = null, previousKey = '';
            for (const option of select.options) {
                if (option.disabled || !option.value) {
                    const heading = document.createElement('div');
                    heading.className = 'dl-stream-heading';
                    heading.textContent = option.textContent;
                    popup.appendChild(heading);
                    group = null;
                    previousKey = '';
                    continue;
                }
                let stream;
                try { stream = JSON.parse(option.value); } catch (error) { continue; }
                const codec = normalizeCodecName(stream.codec) || 'unknown';
                const key = `${stream.format}:${codec}`;
                if (!group || key !== previousKey) {
                    const section = document.createElement('div');
                    section.className = 'dl-stream-codec-group';
                    group = document.createElement('div');
                    const rail = document.createElement('div');
                    rail.className = 'dl-stream-codec-rail';
                    rail.dataset.codec = codec;
                    rail.setAttribute('aria-hidden', 'true');
                    const label = document.createElement('span');
                    label.textContent = codec === 'unknown' ? '未知' : codec.toUpperCase();
                    rail.appendChild(label);
                    section.append(group, rail);
                    popup.appendChild(section);
                    previousKey = key;
                }
                const row = document.createElement('button');
                row.type = 'button';
                row.className = 'dl-stream-option';
                row.setAttribute('role', 'option');
                row.setAttribute('aria-selected', String(option.selected));
                row.setAttribute('aria-label', option.textContent);
                row.dataset.value = option.value;
                row.textContent = option.textContent;
                row.title = option.title || option.textContent;
                row.addEventListener('click', () => {
                    select.value = option.value;
                    closeStreamPicker(true);
                    select.dispatchEvent(new Event('change', { bubbles: true }));
                });
                group.appendChild(row);
            }
            popup.scrollTop = scrollTop;
            if (focusedValue) Array.from(popup.querySelectorAll('.dl-stream-option'))
                .find(row => row.dataset.value === focusedValue)?.focus({ preventScroll: true });
        };

        const initStreamPicker = () => {
            const trigger = document.getElementById('dl-stream-trigger');
            const popup = document.querySelector('#dual-live-panel #dl-stream-popup');
            const select = document.getElementById('dy-stream-select');
            popup.style.font = window.getComputedStyle(select).font;
            trigger.style.font = popup.style.font;
            // 面板的 backdrop-filter 会成为 fixed 定位的包含块，弹层直接挂 body 避免双重偏移。
            document.querySelectorAll('#dl-stream-popup').forEach(other => { if (other !== popup) other.remove(); });
            document.body.appendChild(popup);
            const open = (last = false) => {
                renderStreamPicker();
                const rect = trigger.getBoundingClientRect();
                let width = Math.min(rect.width, window.innerWidth - 16);
                const below = window.innerHeight - rect.bottom;
                const above = rect.top;
                const useBelow = below >= Math.min(220, above);
                const height = Math.max(80, Math.min(440, (useBelow ? below : above) - 12));
                popup.style.width = `${width}px`;
                popup.style.maxHeight = `${height}px`;
                popup.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - width - 8))}px`;
                popup.style.top = `${useBelow ? rect.bottom + 4 : Math.max(8, rect.top - height - 4)}px`;
                popup.hidden = false;
                trigger.setAttribute('aria-expanded', 'true');
                const rows = Array.from(popup.querySelectorAll('.dl-stream-option'));
                // 像原生列表一样，只为容纳完整文字补足必要宽度，不固定加宽。
                const overflow = Math.max(0, ...rows.map(row => row.scrollWidth - row.clientWidth));
                if (overflow > 0) {
                    width = Math.min(width + overflow + 2, window.innerWidth - 16);
                    popup.style.width = `${width}px`;
                    popup.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - width - 8))}px`;
                }
                const row = rows.find(row => row.getAttribute('aria-selected') === 'true') || (last ? rows.at(-1) : rows[0]);
                row?.focus({ preventScroll: true });
                row?.scrollIntoView({ block: 'nearest' });
            };
            trigger.addEventListener('click', () => popup.hidden ? open() : closeStreamPicker());
            trigger.addEventListener('keydown', event => {
                if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                    event.preventDefault();
                    open(event.key === 'ArrowUp');
                }
            });
            popup.addEventListener('keydown', event => {
                const rows = Array.from(popup.querySelectorAll('.dl-stream-option'));
                const index = rows.indexOf(document.activeElement);
                let next;
                if (event.key === 'ArrowDown') next = Math.min(rows.length - 1, index + 1);
                if (event.key === 'ArrowUp') next = Math.max(0, index - 1);
                if (event.key === 'Home') next = 0;
                if (event.key === 'End') next = rows.length - 1;
                if (next !== undefined) { event.preventDefault(); rows[next]?.focus(); }
                if ((event.key === 'Enter' || event.key === ' ') && index >= 0) {
                    event.preventDefault();
                    rows[index].click();
                }
                if (event.key === 'Escape') { event.preventDefault(); closeStreamPicker(true); }
                if (event.key === 'Tab') closeStreamPicker();
            });
            document.addEventListener('pointerdown', event => {
                if (!trigger.contains(event.target) && !popup.contains(event.target)) closeStreamPicker();
            }, true);
            document.addEventListener('keydown', event => {
                if (event.key === 'Escape' && !popup.hidden) closeStreamPicker(true);
            });
            window.addEventListener('resize', () => closeStreamPicker());
            select.addEventListener('change', renderStreamPicker);
            renderStreamPicker();
        };

        const getStreamKey = (stream) => `${String(stream?.format || '')}:${String(stream?.url || '')}`;

        const getCurrentDouyinStreams = () => {
            const targetDyUrl = document.getElementById('inp-dy')
                ? document.getElementById('inp-dy').value
                : GM_getValue('DY_ROOM_URL', DEFAULT_DY_URL);
            const targetDyId = extractRoomId(targetDyUrl);
            const streamMap = GM_getValue('DY_STREAM_MAP', {});
            const streamEntry = streamMap && streamMap[targetDyId];
            if (!streamEntry || !Array.isArray(streamEntry.streams)) return [];
            return streamEntry.streams
                .filter(stream => stream && typeof stream === 'object')
                .sort(compareStreamTypeAndCodec);
        };

        const renderDouyinStreamOptions = () => {
            const sel = document.getElementById('dy-stream-select');
            if (!sel || document.activeElement === sel) return;

            const streams = getCurrentDouyinStreams();
            // 把探测状态纳入签名；仅探测完成而源列表未变化时，也要刷新下拉框文字。
            const renderSignature = JSON.stringify(streams.map(stream => {
                const key = getStreamKey(stream);
                const probe = llsProbeResults.get(key) || null;
                return {
                    stream,
                    key,
                    status: probe?.status || '',
                    width: probe?.width || 0,
                    height: probe?.height || 0,
                    fps: probe?.fps || 0,
                    bitrateBps: probe?.bitrateBps || 0,
                    codec: probe?.codec || '',
                    qualityName: probe?.qualityName || '',
                    failed: unplayableStreams.has(key)
                };
            }));
            if (renderSignature === lastRenderedStreamsJson) return;

            lastRenderedStreamsJson = renderSignature;
            const curVal = sel.value;
            sel.innerHTML = '';

            if (streams.length === 0) {
                sel.innerHTML = '<option value="">等待目标抖音页面开启...</option>';
                renderStreamPicker();
                return;
            }

            let previousFormat = '';
            const formatDescriptions = {
                flv: '低延迟，兼容性良好',
                lls: '超低延迟，字节自研方案',
                hls: '正常延迟，兼容性最好'
            };
            streams.forEach(stream => {
                const streamFormat = String(stream.format || '未知').toLowerCase();
                if (streamFormat !== previousFormat) {
                    const divider = document.createElement('option');
                    divider.disabled = true;
                    const description = formatDescriptions[streamFormat] || '';
                    divider.textContent = `-----${streamFormat.toUpperCase()}----- ${description}`.trim();
                    sel.appendChild(divider);
                    if (streamFormat === 'lls') {
                        const note = document.createElement('option');
                        note.disabled = true;
                        note.textContent = '（移植兼容性差，音画可能存在问题）';
                        sel.appendChild(note);
                    }
                    previousFormat = streamFormat;
                }
                const key = getStreamKey(stream);
                const probe = llsProbeResults.get(key);
                const isFailed = unplayableStreams.has(key) || probe?.status === 'failed';
                const hasProbe = probe?.status === 'ok';
                const typeLabel = String(stream.format || '未知').toUpperCase();
                const failureSuffix = isFailed ? ' ❌' : '';
                const measuredBitrate = Number(probe?.bitrateBps);
                const bitrate = Number(stream.bitrate) > 0
                    ? `${(Number(stream.bitrate) / 1000000).toFixed(1)}Mbps`
                    : (Number.isFinite(measuredBitrate) && measuredBitrate > 0
                        ? `${(measuredBitrate / 1000000).toFixed(1)}Mbps`
                        : '未知');
                const width = Number(probe?.width) > 0 ? Math.round(Number(probe.width)) : 0;
                const height = Number(probe?.height) > 0 ? Math.round(Number(probe.height)) : 0;
               const resolution = formatShortResolution(width, height,
                    String(stream.resolution || '').trim() || '未知');
                const measuredFps = Number(probe?.fps);
                const fps = Number.isFinite(measuredFps) && measuredFps > 0
                    ? `${Math.round(measuredFps)}帧`
                    : (Number(stream.fps) > 0 ? `${Math.round(Number(stream.fps))}帧` : '未知');
                const codec = normalizeCodecName(probe?.codec) || normalizeCodecName(stream.codec) || '未知';
                const streamName = String(stream.name || '').trim();
                const measuredName = String(probe?.qualityName || '').trim();
                const name = streamName && streamName !== '未知'
                    ? streamName
                    : (measuredName || '未知');

                const opt = document.createElement('option');
                opt.value = JSON.stringify(stream);
                if (isFailed) opt.title = String(probe?.error || '播放失败');
                // 仅保留线路类型前缀；去掉原先的 [LLS]、[HLS]、[低延迟] 等尾部提示。
                opt.innerText = isAudioOnlyStream(stream)
                    ? `[${typeLabel}] ${name}（仅音频） - ${bitrate}${failureSuffix}`
                    : `[${typeLabel}] ${name} - ${bitrate} / ${resolution} / ${fps} / ${codec}${failureSuffix}`;
                sel.appendChild(opt);
            });

            if (curVal && Array.from(sel.options).some(option => option.value === curVal)) {
                sel.value = curVal;
            }
            renderStreamPicker();
        };

        const markStreamUnplayable = (stream, reason = '') => {
            if (!stream || !stream.url) return;
            const key = getStreamKey(stream);
            unplayableStreams.add(key);
            const previous = streamProbeResults.get(key) || {};
            streamProbeResults.set(key, { ...previous, status: 'failed', error: String(reason || previous.error || '') });
            lastRenderedStreamsJson = '';
            renderDouyinStreamOptions();
        };

        const markStreamPlayable = (stream, stats = {}) => {
            if (!stream || !stream.url) return;
            const key = getStreamKey(stream);
            const previous = streamProbeResults.get(key) || {};
            const width = Number(stats.width) > 0 ? Number(stats.width) : Number(previous.width) || 0;
            const height = Number(stats.height) > 0 ? Number(stats.height) : Number(previous.height) || 0;
            const fps = Number(stats.fps) > 0 ? Number(stats.fps) : Number(previous.fps) || 0;
            const bitrateBps = Number(stats.bitrateBps) > 0
                ? Number(stats.bitrateBps)
                : Number(previous.bitrateBps) || 0;
            const codec = normalizeCodecName(stats.codec) || normalizeCodecName(previous.codec) || '';
            const qualityName = String(stats.qualityName || previous.qualityName || '').trim();
            unplayableStreams.delete(key);
            streamProbeResults.set(key, { ...previous, ...stats, status: 'ok', width, height, fps, bitrateBps, codec, qualityName });
            lastRenderedStreamsJson = '';
            renderDouyinStreamOptions();
        };

        // 保留旧函数名供 LLS 播放流程调用；结果表已经统一覆盖 LLS/HLS/FLV。
        const markLlsStreamUnplayable = (stream, reason = '') => markStreamUnplayable(stream, reason);
        const markLlsStreamPlayable = (stream, stats = {}) => markStreamPlayable(stream, stats);

        // 用与正式播放相同的抖音 SDK 在隐藏 iframe 中逐条检测；检测页静音，
        // 因而不会抢占当前音频，也不会触发线路自动切换。
        const probeLlsStream = (stream) => new Promise(resolve => {
            const sourceUrl = normalizeStreamUrl(stream?.url || '');
            const audioOnly = isAudioOnlyStream(stream);
            if (!sourceUrl) {
                resolve({ status: 'failed', error: '空地址' });
                return;
            }

            const frame = document.createElement('iframe');
            const channel = `dual-live-lls-probe-${Date.now()}-${Math.random().toString(36).slice(2)}`;
            const safeChannel = JSON.stringify(channel);
            const safeSourceUrl = JSON.stringify(sourceUrl).replace(/</g, '\\u003c');
            let finished = false;
            let latestStats = null;
            let firstDimensionAt = 0;
            let timeoutId = null;

            frame.title = 'LLS 可用性检测';
            frame.allow = 'autoplay';
            frame.setAttribute('aria-hidden', 'true');
            frame.style.cssText = 'position:fixed;left:-10000px;top:-10000px;width:2px;height:2px;border:0;opacity:0;pointer-events:none;';

            const finish = result => {
                if (finished) return;
                finished = true;
                clearTimeout(timeoutId);
                window.removeEventListener('message', onMessage);
                try { frame.contentWindow?.__dualLiveProbePlayer?.destroy(); } catch (e) {}
                try { frame.remove(); } catch (e) {}
                resolve(result);
            };

            const onMessage = event => {
                if (event.source !== frame.contentWindow || event.data?.channel !== channel) return;
                if (event.data.type === 'error') {
                    finish({ status: 'failed', error: describePlaybackFailure('lls', event.data.message, event.data.code) });
                    return;
                }
                if (event.data.type !== 'stats') return;
                const stats = event.data.stats || {};
                const width = Number(stats.width);
                const height = Number(stats.height);
                const fps = Number(stats.fps);
                if (!audioOnly && !(width > 0 && height > 0)) return;
                if (!firstDimensionAt) firstDimensionAt = Date.now();
                latestStats = {
                    status: 'ok',
                    width: Math.round(width),
                    height: Math.round(height),
                    fps: Number.isFinite(fps) && fps > 0 ? fps : 0,
                    bitrateBps: Number(stats.bitrateBps) > 0 ? Number(stats.bitrateBps) : 0,
                    codec: normalizeCodecName(stats.codec),
                    qualityName: String(stats.qualityName || '').trim()
                };
                // 至少收集约 1.5 秒的画面帧，再把实际帧率写入选项；低帧源
                // 若没有 requestVideoFrameCallback，最终会显示“未知”而不伪造数据。
                if (Date.now() - firstDimensionAt >= 1500) finish(latestStats);
            };

            window.addEventListener('message', onMessage);
            frame.srcdoc = `<!doctype html><html><head><meta charset="utf-8">
<style>html,body,#player{width:2px;height:2px;margin:0;background:#000;overflow:hidden}video,canvas{width:2px!important;height:2px!important}</style>
<script>(function(){try{Object.defineProperty(document,'hidden',{value:false,writable:false})}catch(e){}try{Object.defineProperty(document,'visibilityState',{value:'visible',writable:false})}catch(e){}try{window.addEventListener('visibilitychange',function(e){e.stopImmediatePropagation()},true);window.addEventListener('blur',function(e){e.stopImmediatePropagation()},true)}catch(e){}})();</script>
<script>(${installLlsFetchFallback.toString()})(${safeSourceUrl});</script>
<script src="${LLS_PLAYER_SCRIPT_URL}"></script>
</head><body><div id="player"></div><script>
(function(){
  var channel=${safeChannel}, notify=function(data){parent.postMessage(Object.assign({channel:channel},data),'*');};
  var player=null, video=null, bound=false, frameCount=0, lastFrameCount=0, lastFrameTime=performance.now(), lastQualityFrames=0, lastQualityTime=performance.now(), lastByteCount=0, lastByteTime=performance.now(), bitrateSamples=[], audioOnly=${audioOnly}, lastAudioTime=0;
  function bind(){
    video=document.querySelector('video');
    if(!video||bound)return;
    bound=true;
    if(typeof video.requestVideoFrameCallback==='function'){
      var count=function(){frameCount++;try{video.requestVideoFrameCallback(count);}catch(e){}};
      try{video.requestVideoFrameCallback(count);}catch(e){}
    }
  }
  function sample(){
    bind();
    var now=performance.now(),fps=null;
    if(now-lastFrameTime>=500){fps=(frameCount-lastFrameCount)*1000/(now-lastFrameTime);lastFrameCount=frameCount;lastFrameTime=now;}
    var info=player&&typeof player.getVideoFrameInfo==='function'?(player.getVideoFrameInfo()||{}):{};
    var q=video&&video.getVideoPlaybackQuality?video.getVideoPlaybackQuality():(player&&player.playbackQuality||{})||{};
    var qualityFrames=Number(q.totalVideoFrames!=null?q.totalVideoFrames:q.decodedVideoFrames)||0;
    if(!(fps>0)&&qualityFrames>lastQualityFrames&&now-lastQualityTime>0)fps=(qualityFrames-lastQualityFrames)*1000/(now-lastQualityTime);
    lastQualityFrames=qualityFrames; lastQualityTime=now;
    if(!(fps>0)&&Number(info.fps)>0)fps=Number(info.fps);
    var width=Number(video&&video.videoWidth)||Number(info.coded_width||info.codedWidth||info.width)||0;
    var height=Number(video&&video.videoHeight)||Number(info.coded_height||info.codedHeight||info.height)||0;
    if(audioOnly){
      var audioTime=Number(video&&video.currentTime)||0;
      var advancing=video&&!video.paused&&video.readyState>=2&&audioTime>lastAudioTime;
      lastAudioTime=audioTime;
      if(!advancing)return;
    }else if(!(width>0&&height>0))return;
    var playerStats=player&&(player.statisticsInfo||player.stats)||{};
    var playerBytes=Number(playerStats.totalBytes||playerStats.totalByteSize)||0;
    var decodedBytes=Number(video&&(audioOnly?video.webkitAudioDecodedByteCount:video.webkitVideoDecodedByteCount))||0;
    var byteCount=playerBytes>0?playerBytes:decodedBytes;
    if(byteCount>0&&lastByteCount>0&&byteCount>=lastByteCount&&now-lastByteTime>0){
      var bps=(byteCount-lastByteCount)*8*1000/(now-lastByteTime);
      if(Number.isFinite(bps)&&bps>0&&bps<200000000)bitrateSamples.push({time:now,value:bps});
    }
    if(byteCount>0){lastByteCount=byteCount;lastByteTime=now;}
    bitrateSamples=bitrateSamples.filter(function(sample){return now-sample.time<=5000;});
    var bitrateBps=0;
    if(bitrateSamples.length)bitrateBps=bitrateSamples.reduce(function(sum,sample){return sum+sample.value;},0)/bitrateSamples.length;
    var codec=String(info.videoCodec||info.codec||'').toLowerCase();
    var qualityName=String(info.qualityName||info.name||'').trim();
    notify({type:'stats',stats:{width:width,height:height,fps:Number.isFinite(fps)&&fps>0?fps:null,bitrateBps:bitrateBps,codec:codec,qualityName:qualityName}});
  }
  try{
    var sdk=window.pre_build_new_newPlayer;
    if(!sdk||!sdk.Player||!sdk.Protocol)throw new Error('抖音网页播放器内核加载失败');
    player=new sdk.Player({baseConfig:{el:document.getElementById('player'),url:${safeSourceUrl},protocol:sdk.Protocol.RTM,autoplay:true,muted:true,volume:0,width:'2px',height:'2px',ab:{enable_aac_codecs:true}},pluginsConfig:{},preset:{plugins:[]},shared:{}});
    window.__dualLiveProbePlayer=player;
    if(player&&typeof player.on==='function')player.on('error',function(error){notify({type:'error',code:error&&((error.code)||(error.errorCode)||(error.error&&error.error.code))||'',message:String(error&&error.message||error||'')});});
    setInterval(sample,250);
    setTimeout(function(){notify({type:'error',message:'检测超时'});},9000);
  }catch(error){notify({type:'error',message:String(error&&error.message||error)});}
})();
</script></body></html>`;
            document.body.appendChild(frame);
            timeoutId = setTimeout(() => finish(latestStats && (audioOnly || (latestStats.width > 0 && latestStats.height > 0))
                ? latestStats
                : { status: 'failed', error: '检测超时' }), 10000);
        });

        // HLS/FLV 使用当前 B 站页的播放器库，在静音的隐藏 video 上逐条验证。
        // 这样可以把前端只给了“未知”的实际尺寸和帧率补回下拉框，同时不切换当前线路。
        const probeMediaStream = (stream) => new Promise(resolve => {
            const sourceUrl = normalizeStreamUrl(stream?.url || '');
            const format = String(stream?.format || '').toLowerCase();
            const audioOnly = isAudioOnlyStream(stream);
            if (!sourceUrl) {
                resolve({ status: 'failed', error: '空地址' });
                return;
            }

            const video = document.createElement('video');
            video.muted = true;
            video.volume = 0;
            video.autoplay = true;
            video.playsInline = true;
            video.preload = 'auto';
            video.crossOrigin = 'anonymous';
            video.style.cssText = 'position:fixed;left:-10000px;top:-10000px;width:2px;height:2px;border:0;opacity:0;pointer-events:none;';

            let player = null;
            let finished = false;
            let sampleTimer = null;
            let timeoutId = null;
            let playingAt = 0;
            let firstPlayingTime = 0;
            let lastFrames = 0;
            let lastFrameTime = performance.now();
            let latestStats = null;
            let lastDecodedBytes = 0;
            let lastDecodedBytesAt = performance.now();
            let bitrateSamples = [];
            let detectedCodec = '';

            const readMediaMetadata = () => {
                const currentLevel = Number(player?.currentLevel);
                const levels = Array.isArray(player?.levels) ? player.levels : [];
                const level = levels.length
                    ? levels[currentLevel >= 0 ? currentLevel : 0]
                    : null;
                const mediaInfo = player?.mediaInfo || {};
                const candidates = [
                    mediaInfo.videoCodec,
                    mediaInfo.video?.codec,
                    player?.videoCodec,
                    level?.videoCodec,
                    level?.codec
                ];
                return {
                    width: Number(mediaInfo.width || mediaInfo.video?.width || level?.width) || 0,
                    height: Number(mediaInfo.height || mediaInfo.video?.height || level?.height) || 0,
                    bitrateBps: Number(mediaInfo.bitrate || mediaInfo.video?.bitrate || level?.bitrate ||
                        level?.attrs?.BANDWIDTH) || 0,
                    codec: candidates.map(normalizeCodecName).find(Boolean) || '',
                    qualityName: String(level?.name || mediaInfo.qualityName || mediaInfo.name || '').trim()
                };
            };

            const finish = result => {
                if (finished) return;
                finished = true;
                clearInterval(sampleTimer);
                clearTimeout(timeoutId);
                video.removeEventListener('playing', onPlaying);
                video.removeEventListener('error', onVideoError);
                try { player?.destroy?.(); } catch (e) {}
                try { video.pause(); } catch (e) {}
                try { video.removeAttribute('src'); video.load(); } catch (e) {}
                try { video.remove(); } catch (e) {}
                resolve(result);
            };
            const onPlaying = () => {
                if (!playingAt) {
                    playingAt = performance.now();
                    firstPlayingTime = Number(video.currentTime) || 0;
                }
            };
            const onVideoError = () => {
                const mediaError = video.error;
                finish({
                    status: 'failed',
                    error: mediaError ? `媒体错误 ${mediaError.code || ''}`.trim() : '媒体错误'
                });
            };
            const sample = () => {
                if (finished) return;
                const now = performance.now();
                const mediaMetadata = readMediaMetadata();
                const width = Number(video.videoWidth) || mediaMetadata.width;
                const height = Number(video.videoHeight) || mediaMetadata.height;
                if (!audioOnly && !(width > 0 && height > 0)) return;
                const quality = typeof video.getVideoPlaybackQuality === 'function'
                    ? (video.getVideoPlaybackQuality() || {})
                    : {};
                const frames = Number(quality.totalVideoFrames != null
                    ? quality.totalVideoFrames
                    : quality.decodedVideoFrames);
                let fps = 0;
                if (Number.isFinite(frames) && frames >= 0) {
                    const elapsed = now - lastFrameTime;
                    if (lastFrames > 0 && frames >= lastFrames && elapsed > 0) {
                        fps = (frames - lastFrames) * 1000 / elapsed;
                    }
                    lastFrames = frames;
                    lastFrameTime = now;
                }
                const decodedBytes = Number(audioOnly ? video.webkitAudioDecodedByteCount : video.webkitVideoDecodedByteCount);
                const statisticsInfo = player?.statisticsInfo || player?.stats || {};
                const playerBytes = Number(statisticsInfo.totalBytes || statisticsInfo.totalByteSize);
                const byteCount = Number.isFinite(playerBytes) && playerBytes > 0 ? playerBytes : decodedBytes;
                if (Number.isFinite(byteCount) && byteCount > 0 &&
                    lastDecodedBytes > 0 && byteCount >= lastDecodedBytes &&
                    now - lastDecodedBytesAt > 0) {
                    const bps = (byteCount - lastDecodedBytes) * 8 * 1000 / (now - lastDecodedBytesAt);
                    if (Number.isFinite(bps) && bps > 0 && bps < 200000000) {
                        bitrateSamples.push({ time: now, value: bps });
                    }
                }
                if (Number.isFinite(byteCount) && byteCount > 0) {
                    lastDecodedBytes = byteCount;
                    lastDecodedBytesAt = now;
                }
                bitrateSamples = bitrateSamples.filter(sample => now - sample.time <= 5000);
                detectedCodec = detectedCodec || mediaMetadata.codec;
                const measuredBitrateBps = bitrateSamples.length
                    ? bitrateSamples.reduce((sum, sample) => sum + sample.value, 0) / bitrateSamples.length
                    : 0;
                latestStats = {
                    status: 'ok',
                    width: Math.round(width),
                    height: Math.round(height),
                    fps: Number.isFinite(fps) && fps > 0 ? fps : 0,
                    bitrateBps: measuredBitrateBps || mediaMetadata.bitrateBps || 0,
                    codec: detectedCodec,
                    qualityName: mediaMetadata.qualityName
                };
                if (!playingAt && !video.paused && video.readyState >= 2) onPlaying();
                if (playingAt && now - playingAt >= 1200 &&
                    Number(video.currentTime) > firstPlayingTime + 0.1) finish(latestStats);
            };

            video.addEventListener('playing', onPlaying);
            video.addEventListener('error', onVideoError);
            document.body.appendChild(video);

            try {
                if (format === 'flv') {
                    if (typeof mpegts === 'undefined' || !mpegts.isSupported()) {
                        finish({ status: 'failed', error: '浏览器不支持 FLV' });
                        return;
                    }
                    player = mpegts.createPlayer({
                        type: 'flv',
                        url: sourceUrl,
                        isLive: true,
                        hasAudio: true,
                        hasVideo: !audioOnly
                    }, { enableWorker: true, enableStashBuffer: false });
                    if (mpegts.Events.MEDIA_INFO) {
                        player.on(mpegts.Events.MEDIA_INFO, info => {
                            detectedCodec = detectedCodec || normalizeCodecName(info?.videoCodec || info?.codec);
                        });
                    }
                    player.on(mpegts.Events.ERROR, (type, detail, info) => {
                        const status = Number(info?.code);
                        finish({ status: 'failed', error: describePlaybackFailure('flv',
                            status >= 400 && status <= 599 ? `HTTP ${status}` : detail || type) });
                    });
                    player.attachMediaElement(video);
                    player.load();
                    try { Promise.resolve(player.play?.()).catch(() => {}); } catch (e) {}
                    Promise.resolve(video.play()).catch(() => {});
                } else if (format === 'hls') {
                    if (typeof Hls !== 'undefined' && Hls.isSupported()) {
                        player = new Hls({ enableWorker: true, lowLatencyMode: true, backBufferLength: 30 });
                        player.on(Hls.Events.ERROR, (event, data) => {
                            if (data?.fatal) {
                                const status = Number(data.response?.code);
                                finish({ status: 'failed', error: describePlaybackFailure('hls',
                                    status >= 400 && status <= 599 ? `HTTP ${status}` : data.details || data.type) });
                            }
                        });
                        player.on(Hls.Events.MANIFEST_PARSED, () => {
                            detectedCodec = detectedCodec || readMediaMetadata().codec;
                            video.play().catch(() => {});
                        });
                        player.loadSource(sourceUrl);
                        player.attachMedia(video);
                    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
                        video.src = sourceUrl;
                        video.load();
                        Promise.resolve(video.play()).catch(() => {});
                    } else {
                        finish({ status: 'failed', error: '浏览器不支持 HLS' });
                        return;
                    }
                } else {
                    finish({ status: 'failed', error: '未知流格式' });
                    return;
                }
            } catch (error) {
                finish({ status: 'failed', error: String(error?.message || error || '检测异常') });
                return;
            }

            sampleTimer = setInterval(sample, 250);
            timeoutId = setTimeout(() => finish(latestStats && playingAt &&
                !video.paused && video.readyState >= 2 && Number(video.currentTime) > firstPlayingTime + 0.1
                ? latestStats
                : { status: 'failed', error: '检测超时' }), 12000);
        });

        const probeStream = (stream) => String(stream?.format || '').toLowerCase() === 'lls'
            ? probeLlsStream(stream)
            : probeMediaStream(stream);

        const shouldProbeStream = (stream) => {
            const format = String(stream?.format || '').toLowerCase();
            if (format === 'lls') return true;
            if (format !== 'hls' && format !== 'flv') return false;
            const isUnknown = value => {
                const text = String(value ?? '').trim();
                return !text || text === '未知' || text.toLowerCase() === 'unknown';
            };
           const hasResolution = formatShortResolution(0, 0, stream?.resolution || '') !== '未知';
            const hasFps = Number(stream?.fps) > 0;
            // 有些源虽然被错误映射成 360p/16帧，但名称、码率或 sdk_key 仍是未知；
            // 这些也必须进入测试，不能因为一个猜测值而被跳过。
            return isUnknown(stream?.name) || isUnknown(stream?.sdk_key) ||
                !(Number(stream?.bitrate) > 0) || !hasResolution || !hasFps;
        };

        const runStreamAvailabilityCheck = async (button) => {
            if (streamProbeRunning) return;
            streamProbeRunning = true;
            button.disabled = true;

            try {
                ensureDouyinChat();
                let streams = getCurrentDouyinStreams()
                    .filter(stream => stream.url && shouldProbeStream(stream))
                    .filter((stream, index, list) => list.findIndex(item => getStreamKey(item) === getStreamKey(stream)) === index);
                // 采集页刚打开时，源表可能还没写入；给它一次短暂的同步机会。
                if (streams.length === 0) {
                    GM_setValue('DY_FORCE_EXTRACT', Date.now());
                    button.innerText = '等待抖音源…';
                    for (let attempt = 0; attempt < 10 && streams.length === 0; attempt++) {
                        await new Promise(resolve => setTimeout(resolve, 300));
                        streams = getCurrentDouyinStreams()
                            .filter(stream => stream.url && shouldProbeStream(stream))
                            .filter((stream, index, list) => list.findIndex(item => getStreamKey(item) === getStreamKey(stream)) === index);
                    }
                }
                if (streams.length === 0) {
                    button.innerText = '暂无待测试源';
                    return;
                }

                streams.forEach(stream => {
                    const key = getStreamKey(stream);
                    streamProbeResults.delete(key);
                    unplayableStreams.delete(key);
                });
                lastRenderedStreamsJson = '';
                renderDouyinStreamOptions();

                for (let index = 0; index < streams.length; index++) {
                    const stream = streams[index];
                    button.innerText = `检测中 ${index + 1}/${streams.length}`;
                    let result;
                    try {
                        result = await probeStream(stream);
                    } catch (error) {
                        result = { status: 'failed', error: String(error?.message || error || '检测异常') };
                    }
                    if (result.status === 'ok') markStreamPlayable(stream, result);
                    else markStreamUnplayable(stream, result.error);
                    lastRenderedStreamsJson = '';
                    renderDouyinStreamOptions();
                }
                button.innerText = '检测完成';
            } finally {
                streamProbeRunning = false;
                button.disabled = false;
                setTimeout(() => { button.innerText = '🔍 测试可用性'; }, 1800);
            }
        };

        const attachEventListeners = (panel) => {
            let isDragging = false, offset = { x: 0, y: 0 };
            const header = document.getElementById('dual-live-panel-header');
            header.addEventListener('mousedown', e => {
                isDragging = true;
                offset.x = e.clientX - panel.getBoundingClientRect().left;
                offset.y = e.clientY - panel.getBoundingClientRect().top;
            });
            document.addEventListener('mousemove', e => {
                if (isDragging) {
                    panel.style.left = (e.clientX - offset.x) + 'px';
                    panel.style.top = (e.clientY - offset.y) + 'px';
                    panel.style.right = 'auto';
                }
            });
            document.addEventListener('mouseup', () => { isDragging = false; });

            document.getElementById('dl-panel-close').addEventListener('click', () => { panel.style.display = 'none'; });

            const inpBili = document.getElementById('inp-bili');
            inpBili.addEventListener('input', (e) => {
                GM_setValue('BILI_ROOM_URL', e.target.value);
                syncDanmakuRoomScope();
                updateDanmakuLayer();
            });

            const inpDy = document.getElementById('inp-dy');
            inpDy.addEventListener('input', (e) => {
                clearDanmakuDisplay();
                stopDouyinChat();
                danmakuAcceptAfter = Date.now();
                primeLatestDanmakuBatch();
                GM_setValue('DY_ROOM_URL', e.target.value);
                GM_setValue('DY_FORCE_EXTRACT', Date.now());
            });

            document.getElementById('btn-reset-bili').addEventListener('click', (e) => {
                inpBili.value = DEFAULT_BILI_URL;
                GM_setValue('BILI_ROOM_URL', DEFAULT_BILI_URL);
                syncDanmakuRoomScope();
                updateDanmakuLayer();
                e.target.innerText = '已重置'; setTimeout(() => { e.target.innerText = '重置'; }, 1200);
            });

            document.getElementById('btn-reset-dy').addEventListener('click', (e) => {
                clearDanmakuDisplay();
                stopDouyinChat();
                danmakuAcceptAfter = Date.now();
                primeLatestDanmakuBatch();
                inpDy.value = DEFAULT_DY_URL;
                GM_setValue('DY_ROOM_URL', DEFAULT_DY_URL);
                GM_setValue('DY_FORCE_EXTRACT', Date.now());
                e.target.innerText = '已重置'; setTimeout(() => { e.target.innerText = '重置'; }, 1200);
            });

            document.getElementById('btn-open-bili').addEventListener('click', () => {
                window.open(document.getElementById('inp-bili').value, '_blank');
            });
            document.getElementById('btn-open-dy').addEventListener('click', () => {
                window.open(document.getElementById('inp-dy').value, '_blank');
            });

            document.getElementById('btn-refresh-streams').addEventListener('click', (e) => {
                ensureDouyinChat();
                const sel = document.getElementById('dy-stream-select');
                if (sel) sel.innerHTML = '<option value="">🔄 正在重新嗅探源...</option>';
                renderStreamPicker();
                lastRenderedStreamsJson = '';
                GM_setValue('DY_FORCE_EXTRACT', Date.now());

                e.target.innerText = '已请求';
                setTimeout(() => { e.target.innerText = '🔄 手动清除缓存'; }, 1500);
            });

            document.getElementById('btn-detect-lls').addEventListener('click', (e) => {
                runStreamAvailabilityCheck(e.currentTarget);
            });

            document.getElementById('btn-play-dy').addEventListener('click', () => {
                ensureDouyinChat();
                const selVal = document.getElementById('dy-stream-select').value;
                if (!selVal) return;
                const stream = JSON.parse(selVal);

                document.getElementById('si-dy-quality').innerText = `${stream.name} [${stream.format.toUpperCase()} / ${stream.codec.toUpperCase()}]`;
                initPlayer(stream);
            });

            // 切换按钮更新方法
            const updateToggleButtons = () => {
                const btnBili = document.getElementById('btn-toggle-bili');
                const btnDy = document.getElementById('btn-toggle-dy');
                if(btnBili) {
                    btnBili.innerText = isBiliVisible ? '关闭B站画面' : '开启B站画面';
                    btnBili.className = isBiliVisible ? 'dl-btn dl-btn-danger' : 'dl-btn dl-btn-save';
                }
                if(btnDy) {
                    btnDy.innerText = isDyVisible ? '关闭抖音画面' : '开启抖音画面';
                    btnDy.className = isDyVisible ? 'dl-btn dl-btn-danger' : 'dl-btn dl-btn-save';
                }
            };

            // 全局布局恢复
            document.getElementById('btn-layout-split').addEventListener('click', () => {
                isBiliVisible = true;
                isDyVisible = true;
                updateToggleButtons();
                applyLayout();
            });
            document.getElementById('btn-toggle-dy').addEventListener('click', () => {
                isDyVisible = !isDyVisible;
                updateToggleButtons();
                applyLayout();
            });
            document.getElementById('btn-toggle-bili').addEventListener('click', () => {
                isBiliVisible = !isBiliVisible;
                updateToggleButtons();
                applyLayout();
            });

            document.getElementById('btn-delay-add').addEventListener('click', () => {
                if (dyVideoElement) {
                    manualDelayAdded += 0.5;
                    document.getElementById('txt-manual-delay').innerText = `${manualDelayAdded.toFixed(1)} s`;
                    dyVideoElement.pause();
                    setTimeout(() => { if(dyVideoElement) dyVideoElement.play(); }, 500);
                }
            });
            document.getElementById('btn-delay-reset').addEventListener('click', () => {
                if (dyVideoElement) {
                    manualDelayAdded = 0;
                    document.getElementById('txt-manual-delay').innerText = `0.0 s`;
                    if(dyVideoElement.buffered.length > 0) dyVideoElement.currentTime = dyVideoElement.buffered.end(dyVideoElement.buffered.length - 1);
                }
            });

            document.getElementById('vol-bili').addEventListener('input', (e) => {
                const bVid = getBiliVideo();
                if(bVid) {
                    const v = parseFloat(e.target.value);
                    bVid.volume = v;
                    bVid.muted = (v === 0);
                }
            });
            document.getElementById('vol-dy').addEventListener('input', (e) => {
                setDouyinVolume(e.target.value);
            });

            document.getElementById('chk-show-source').addEventListener('change', (e) => {
                showSourceLabels = e.target.checked;
                GM_setValue('SHOW_SOURCE_LABELS', showSourceLabels);
                updateSourceLabels();

                // LLS 播放器可能在异步完成后才创建内部 video，发现后接入现有监控与音量控制。
                if (!dyVideoElement && dyDisplayElement && dyDisplayElement.id === 'douyin-overlay-player') {
                    try {
                        dyVideoElement = dyDisplayElement.tagName === 'IFRAME'
                            ? dyDisplayElement.contentDocument?.querySelector('video')
                            : dyDisplayElement.querySelector('video');
                    } catch (e) {}
                }
            });

            document.getElementById('chk-show-danmaku').addEventListener('change', (e) => {
                showDouyinDanmaku = e.target.checked;
                GM_setValue('SHOW_DOUYIN_DANMAKU', showDouyinDanmaku);
                danmakuAcceptAfter = Date.now();
                if (showDouyinDanmaku && syncDanmakuRoomScope()) {
                    // 启用时从最新批次之后开始，只显示接下来新到的评论。
                    primeLatestDanmakuBatch();
                    ensureDouyinChat();
                }
                if (!showDouyinDanmaku) {
                    clearDanmakuDisplay();
                    stopDouyinChat();
                }
                updateDanmakuLayer();
            });

            document.getElementById('chk-auto-recover').addEventListener('change', (e) => {
                GM_setValue(AUTO_RECOVER_ENABLED_KEY, e.target.checked);
                if (e.target.checked) {
                    biliAutoLastProgressAt = Date.now();
                    biliAutoLastVideo = null;
                    biliAutoNextReloadAt = 0;
                    biliAutoErrorSince = 0;
                    overlayRecoveryAttempts = 0;
                    overlayRecoveryNextAt = 0;
                    setAutoRecoverStatus('监测中', '#4caf50');
                } else {
                    if (overlayRecoveryTimer) {
                        clearTimeout(overlayRecoveryTimer);
                        overlayRecoveryTimer = 0;
                    }
                    setAutoRecoverStatus('已关闭', '#888');
                }
            });
        };

        const resetOverlayRecovery = () => {
            overlayRecoveryAttempts = 0;
            overlayRecoveryNextAt = 0;
            overlayRecoveryCycleStartedAt = 0;
            if (overlayRecoveryTimer) {
                clearTimeout(overlayRecoveryTimer);
                overlayRecoveryTimer = 0;
            }
            setAutoRecoverStatus(isAutoRecoverEnabled() ? '监测中' : '已关闭',
                isAutoRecoverEnabled() ? '#4caf50' : '#888');
        };

        const requestDouyinSourceRefresh = (reason = '') => {
            const targetDyUrl = document.getElementById('inp-dy')
                ? document.getElementById('inp-dy').value
                : GM_getValue('DY_ROOM_URL', DEFAULT_DY_URL);
            const roomId = extractRoomId(targetDyUrl);
            if (!roomId) return false;
            const previous = GM_getValue('DY_REFRESH_REQUEST', null);
            if (previous && String(previous.roomId) === String(roomId) &&
                Date.now() - (Number(previous.at) || 0) < 60000) return false;
            GM_setValue('DY_REFRESH_REQUEST', { roomId, at: Date.now(), reason: String(reason || '') });
            // 即使抖音页暂时不能刷新，也先强制它重新抓一次源。
            GM_setValue('DY_FORCE_EXTRACT', Date.now());
            setAutoRecoverStatus('请求抖音页面刷新源…', '#ffb74d');
            recordAutoRecovery('抖音源页面', reason, '已发送刷新请求，尚未确认页面执行');
            console.warn('[DualLive] 抖音源持续失败，已请求抖音页面刷新:', reason);
            return true;
        };

        const scheduleOverlayRecoverySoon = (reason = '播放失败') => {
            if (!isAutoRecoverEnabled() || overlayRecoveryTimer) return;
            overlayRecoveryTimer = window.setTimeout(() => {
                overlayRecoveryTimer = 0;
                recoverCurrentPlayback(reason, true);
            }, 2500);
        };

        const recoverCurrentPlayback = (reason = '页面恢复', force = false) => {
            if (!isAutoRecoverEnabled() || !isDyVisible || !currentStream || !dyDisplayElement ||
                !document.contains(dyDisplayElement)) return;
            const now = Date.now();
            if (!force && lastDyMediaProgressAt && now - lastDyMediaProgressAt < 7000) return;
            if (now < overlayRecoveryNextAt) return;

            if (!overlayRecoveryCycleStartedAt) overlayRecoveryCycleStartedAt = now;
            // 长时间断流时定期重置退避计数，继续尝试用户选择的线路。
            if (overlayRecoveryAttempts >= 3 && now - overlayRecoveryCycleStartedAt >= 60000) {
                overlayRecoveryAttempts = 0;
                overlayRecoveryCycleStartedAt = now;
                console.warn('[DualLive] 断流超过1分钟，重新尝试当前抖音线路');
            }

            overlayRecoveryAttempts++;
            const delay = Math.min(30000, 2500 * Math.pow(2, Math.min(5, overlayRecoveryAttempts - 1)));
            overlayRecoveryNextAt = now + delay;
            console.warn(`[DualLive] 抖音画面恢复（第${overlayRecoveryAttempts}次）:`, reason);
            setAutoRecoverStatus(`重连抖音画面（第${overlayRecoveryAttempts}次）…`, '#ffb74d');

            if (overlayRecoveryAttempts >= 3) requestDouyinSourceRefresh(reason);
            recordAutoRecovery('抖音画面', reason, '已发起当前线路重连');
            initPlayer(currentStream, true);
        };

        const handlePlaybackResume = () => {
            if (document.visibilityState !== 'visible') return;
            try {
                let video = dyVideoElement;
                if (!video && dyDisplayElement?.tagName === 'IFRAME') {
                    video = dyDisplayElement.contentDocument?.querySelector('video');
                    if (video) dyVideoElement = video;
                }
                if (video?.paused) video.play().catch(() => {});
            } catch (e) {}
            // 切回前台时给浏览器一次恢复媒体管线的机会，再检查是否仍停滞。
            setTimeout(() => recoverCurrentPlayback('切回前台'), 300);
        };

        document.addEventListener('visibilitychange', handlePlaybackResume);
        window.addEventListener('pageshow', handlePlaybackResume);
        window.addEventListener('focus', handlePlaybackResume);

        const startHeartbeat = () => {
            setInterval(() => {
                // 如果用户没有打开面板，且没有载入双播画面，停止相关功能
                const panel = document.getElementById('dual-live-panel');
                const isPanelVisible = panel && panel.style.display === 'block';
                if (!isPanelVisible && !dyDisplayElement && !showSourceLabels && !showDouyinDanmaku) {
                    return; 
                }

                // 只维持独立弹幕连接，不创建任何抖音网页或播放器。
                if (syncDanmakuRoomScope()) ensureDouyinChat();

                updateSourceLabels();
                updateDanmakuLayer();
                ensureBiliSidebarFeed();
                if (dyDisplayElement) ensureDouyinVolumeControl();

                const now = Date.now();

                const targetBiliUrl = document.getElementById('inp-bili') ? document.getElementById('inp-bili').value : GM_getValue('BILI_ROOM_URL', DEFAULT_BILI_URL);
                const targetDyUrl = document.getElementById('inp-dy') ? document.getElementById('inp-dy').value : GM_getValue('DY_ROOM_URL', DEFAULT_DY_URL);

                const targetBiliId = extractRoomId(targetBiliUrl);
                const targetDyId = extractRoomId(targetDyUrl);
                const currentBiliId = extractRoomId(location.href);

                const biliEl = document.getElementById('st-bili');
                if(biliEl) {
                    if (currentBiliId === targetBiliId) {
                        biliEl.className = 'dl-status-green';
                        biliEl.innerText = '✅ 页面已开启';
                    } else {
                        biliEl.className = 'dl-status-red';
                        biliEl.innerText = '❌ 房间号与当前页不符';
                    }
                }

                const dyEl = document.getElementById('st-dy');
                const dyHbMap = GM_getValue('DY_HEARTBEATS_MAP', {});
                const dyTargetLastTime = dyHbMap[targetDyId] || 0;

                if(dyEl) {
                    if (sourceFailed) {
                        dyEl.className = 'dl-status-red';
                        dyEl.innerText = sourceErrorMessage || '❌ 源失效，请在抖音按F5刷新';
                    } else if (now - dyTargetLastTime < 3000) {
                        dyEl.className = 'dl-status-green';
                        dyEl.innerText = '✅ 页面已开启';
                    } else {
                        dyEl.className = 'dl-status-red';
                        dyEl.innerText = '❌ 未检测到对应页面';
                    }
                }

                renderDouyinStreamOptions();

                const activeQualityEl = document.getElementById('si-dy-quality');
                if (currentStream && !sourceFailed && activeQualityEl) {
                    const activeProbe = streamProbeResults.get(getStreamKey(currentStream)) || {};
                    const sourceName = String(currentStream.name || '').trim();
                    const measuredName = String(activeProbe.qualityName || '').trim();
                    const qualityName = sourceName && sourceName !== '未知'
                        ? sourceName
                        : (measuredName || '未知');
                    const qualityFormat = String(currentStream.format || '未知').toUpperCase();
                    const qualityCodec = normalizeCodecName(activeProbe.codec) ||
                        normalizeCodecName(currentStream.codec) || '未知';
                    activeQualityEl.innerText = isAudioOnlyStream(currentStream)
                        ? qualityName + '（仅音频） [' + qualityFormat + ']'
                        : qualityName + ' [' + qualityFormat + ' / ' + qualityCodec + ']';
                }

                // B 站实时状态监控计算
                const bVid = getActiveBiliVideo();
                const hasActiveBiliVideo = !!bVid;
                const layoutContainer = getPlayerContainer();
                const expectedDyClass = !isDyVisible
                    ? 'dl-dy-hidden'
                    : (bVid && isBiliVisible ? 'dl-dy-split' : 'dl-dy-dyonly');
                const expectedBiliHidden = !isBiliVisible && isDyVisible && !!dyDisplayElement;
                // 全屏/切出游戏后可能只替换了 video 节点或播放器容器，画面仍停在异常排版；
                // 心跳里比较节点身份和实际类名，发现被换掉就重新套用，避免一直错到下次 resize。
                const layoutStale = !!dyDisplayElement && (
                    bVid !== lastLaidOutBiliVideo ||
                    layoutContainer !== lastLaidOutContainer ||
                    !document.contains(dyDisplayElement) ||
                    !dyDisplayElement.classList.contains(expectedDyClass) ||
                    expectedBiliHidden !== !!(layoutContainer &&
                        layoutContainer.hasAttribute('data-dl-bili-picture-off')) ||
                    (bVid && isBiliVisible && isDyVisible && layoutContainer &&
                        !layoutContainer.classList.contains('dl-split-host'))
                );
                if (layoutStale) applyLayout();
                hadActiveBiliVideo = hasActiveBiliVideo;
                if (bVid && bVid.readyState >= 2) {
                    document.getElementById('si-bili-quality').innerText = getBiliStreamInfo(bVid);

                    if (bVid.webkitVideoDecodedByteCount !== undefined) {
                        let currentBytes = bVid.webkitVideoDecodedByteCount; // 获取当前的解码总字节数
                        let bytesDiff = currentBytes - biliLastDecodedBytes; // 用现在的减去1秒前的，算出这1秒内新下载了多少字节
                        let timeDiff = (now - biliLastDecodedTime) / 1000; //   算出两次侦测之间的时间差
                        if (timeDiff > 0 && biliLastDecodedBytes > 0 && bytesDiff >= 0) {
                            let currentMbps = (bytesDiff * 8) / (timeDiff * 1000000);
                            biliBpsHistory.push({ t: now, val: currentMbps }); // 把当前瞬时码率塞进数组
                        }
                        biliLastDecodedBytes = currentBytes;
                        biliLastDecodedTime = now;
                    }
                    biliBpsHistory = biliBpsHistory.filter(x => now - x.t <= 10000); // 过滤超过10秒的历史数据
                    if (biliBpsHistory.length > 0) {
                        let avgMbps = biliBpsHistory.reduce((sum, item) => sum + item.val, 0) / biliBpsHistory.length; // 得到平均码率
                        document.getElementById('si-bili-bitrate').innerText = `${avgMbps.toFixed(2)} Mbps`; // 保留两位小数显示在面板
                    }

                    if (bVid.buffered.length > 0) {
                        let bufferEnd = bVid.buffered.end(bVid.buffered.length - 1);
                        let lat = (bufferEnd - bVid.currentTime).toFixed(2);
                        document.getElementById('si-bili-latency').innerText = `${lat} s`;
                    }

                    let resStr = formatFullResolution(bVid.videoWidth, bVid.videoHeight);
                    if (bVid.getVideoPlaybackQuality) {
                        let quality = bVid.getVideoPlaybackQuality();
                        let frames = quality.totalVideoFrames;
                        if (biliLastFrames > 0 && biliLastFrameTime > 0) {
                            let fDiff = frames - biliLastFrames;
                            let tDiff = (now - biliLastFrameTime) / 1000;
                            if (tDiff > 0) {
                                let fps = Math.round(fDiff / tDiff);
                                resStr += ` @ ${fps}FPS`;
                            }
                        }
                        biliLastFrames = frames;
                        biliLastFrameTime = now;
                    }
                    document.getElementById('si-bili-res').innerText = resStr;
                }

                // FLV/HLS 沿用 video 元素统计；LLS 由 iframe 通过 postMessage 上报。
                if (currentDyFormat !== 'lls' && dyVideoElement && dyVideoElement.readyState >= 2) {
                    const audioOnly = isAudioOnlyStream(currentStream);
                    const byteProperty = audioOnly ? 'webkitAudioDecodedByteCount' : 'webkitVideoDecodedByteCount';
                    if (dyVideoElement[byteProperty] !== undefined) {
                        let currentBytes = dyVideoElement[byteProperty];
                        let bytesDiff = currentBytes - dyLastDecodedBytes;
                        let timeDiff = (now - dyLastDecodedTime) / 1000;
                        if (timeDiff > 0 && dyLastDecodedBytes > 0 && bytesDiff >= 0) {
                            let currentMbps = (bytesDiff * 8) / (timeDiff * 1000000);
                            dyBpsHistory.push({ t: now, val: currentMbps });
                        }
                        dyLastDecodedBytes = currentBytes;
                        dyLastDecodedTime = now;
                    }

                    dyBpsHistory = dyBpsHistory.filter(x => now - x.t <= 10000);
                    if (dyBpsHistory.length > 0) {
                        let avgMbps = dyBpsHistory.reduce((sum, item) => sum + item.val, 0) / dyBpsHistory.length;
                        document.getElementById('si-dy-bitrate').innerText = `${avgMbps.toFixed(2)} Mbps`;
                    }

                    if (dyVideoElement.buffered.length > 0) {
                        let bufferEnd = dyVideoElement.buffered.end(dyVideoElement.buffered.length - 1);
                        let lat = (bufferEnd - dyVideoElement.currentTime).toFixed(2);
                        document.getElementById('si-dy-latency').innerText = `${lat} s`;
                    }

                    const observedTime = Number(dyVideoElement.currentTime);
                    if (Number.isFinite(observedTime)) {
                        if (!Number.isFinite(lastDyObservedTime) || observedTime > lastDyObservedTime + 0.01) {
                            lastDyMediaProgressAt = now;
                        }
                        lastDyObservedTime = observedTime;
                    }

                    let resStr = audioOnly ? '仅音频' : formatFullResolution(
                        dyVideoElement.videoWidth,
                        dyVideoElement.videoHeight,
                        currentStream?.resolution || ''
                    );
                    if (!audioOnly && dyVideoElement.getVideoPlaybackQuality) {
                        let quality = dyVideoElement.getVideoPlaybackQuality();
                        let frames = quality.totalVideoFrames;
                        if (dyLastFrames > 0 && dyLastFrameTime > 0) {
                            let fDiff = frames - dyLastFrames;
                            let tDiff = (now - dyLastFrameTime) / 1000;
                            if (tDiff > 0) {
                                let fps = Math.round(fDiff / tDiff);
                                resStr += ` @ ${fps}FPS`;
                            }
                        }
                        dyLastFrames = frames;
                        dyLastFrameTime = now;
                    }
                    document.getElementById('si-dy-res').innerText = resStr;
                }

                // 页面重新获得前台后，若当前线路长时间没有媒体进展，只重连同一 URL。
                if (document.visibilityState === 'visible' && currentStream && dyDisplayElement &&
                    lastDyMediaProgressAt && now - lastDyMediaProgressAt >= 7000) {
                    recoverCurrentPlayback('媒体进度停止');
                }
            }, 1000);
        };

        const initPlayer = (stream, autoRecovery = false) => {
            if (!autoRecovery) resetOverlayRecovery();
            let playerContainer = getPlayerContainer();
            if (!getActiveBiliVideo()) {
                if (!playerContainer) playerContainer = createOfflineBiliHost();
                if (playerContainer) {
                    if (playerContainer.clientHeight < 120) playerContainer.style.minHeight = '240px';
                    playerContainer.classList.add('dl-offline-host');
                    offlineBiliHost = playerContainer;
                }
            }
            if (!playerContainer) {
                sourceFailed = true;
                sourceErrorMessage = '❌ 未找到 B 站播放器区域，请等待页面完成加载';
                const qualityEl = document.getElementById('si-dy-quality');
                if (qualityEl) qualityEl.innerText = '未找到 B 站播放器区域';
                return;
            }

            const initToken = ++playerInitToken;
            currentDyFormat = stream.format;
            if (streamPlayer) {
                try { streamPlayer.destroy(); } catch(e) {}
                streamPlayer = null;
            }
            if (dyDisplayElement) {
                try { dyDisplayElement.remove(); } catch(e) {}
            } else if (dyVideoElement) {
                try { dyVideoElement.remove(); } catch(e) {}
            }
            dyDisplayElement = null;
            dyVideoElement = null;

            dyBpsHistory = [];
            dyLastDecodedBytes = 0;
            dyLastDecodedTime = Date.now();
            dyLastFrames = 0;
            dyLastFrameTime = Date.now();
            dyLastRenderedFrames = 0;
            sourceFailed = false;
            sourceErrorMessage = '';
            currentStream = stream;
            lastDyMediaProgressAt = Date.now();
            lastDyObservedTime = NaN;

            const sourceUrl = normalizeStreamUrl(stream.url);
            const audioOnly = isAudioOnlyStream(stream);
            const desiredVolume = parseFloat(document.getElementById('vol-dy').value);
            douyinVolumeValue = clampVolume(desiredVolume);
            const latencyLabel = document.getElementById('si-dy-latency-label');
            if (latencyLabel) latencyLabel.innerText = stream.format === 'lls' ? '线路响应 / 近5秒网络波动等待：' : '缓冲区积压延迟：';

            if (stream.format === 'lls') {
                document.getElementById('si-dy-bitrate').innerText = '等待统计…';
                document.getElementById('si-dy-latency').innerText = '等待统计…';
                document.getElementById('si-dy-res').innerText = '等待统计…';
                // 在 srcdoc 中运行抖音网页播放器，隔离全局变量并保留现有布局控制。
                const mount = document.createElement('iframe');
                mount.id = 'douyin-overlay-player';
                mount.title = '抖音 LLS 播放器';
                mount.allow = 'autoplay';
                mount.style.border = '0';
                mount.style.width = '100%';
                mount.style.height = '100%';
                dyDisplayElement = mount;
                const messageChannel = `dual-live-lls-${initToken}`;
                const safeChannel = JSON.stringify(messageChannel);
                const safeSourceUrl = JSON.stringify(sourceUrl).replace(/</g, '\\u003c');
                let llsTimeout = null;
                const clearLlsStatistics = () => {
                    for (const id of ['si-dy-res', 'si-dy-bitrate', 'si-dy-latency']) {
                        const element = document.getElementById(id);
                        if (element) element.innerText = '不可用';
                    }
                };

                const setIframeVolume = (volume) => {
                    try {
                        const video = mount.contentDocument && mount.contentDocument.querySelector('video');
                        if (!video) return;
                        dyVideoElement = video;
                        video.volume = volume;
                        video.muted = volume === 0;
                    } catch (e) {}
                };

                const onLlsMessage = (event) => {
                    if (event.source !== mount.contentWindow || event.data?.channel !== messageChannel) return;
                    if (initToken !== playerInitToken || dyDisplayElement !== mount) return;
                    if (event.data.type === 'ready') {
                        clearTimeout(llsTimeout);
                        sourceFailed = false;
                        sourceErrorMessage = '';
                        lastDyMediaProgressAt = Date.now();
                        markLlsStreamPlayable(stream, event.data.stats || {});
                        resetOverlayRecovery();
                    } else if (event.data.type === 'stats') {
                        if (sourceFailed) return;
                        const stats = event.data.stats || {};
                        const statTime = Date.now();
                        const totalBytes = Number(stats.totalByteSize);
                        let bytesAdvanced = false;
                        const renderedFrames = Number(stats.renderedFrames);
                        const framesAdvanced = Number.isFinite(renderedFrames) && renderedFrames > dyLastRenderedFrames;
                        if (Number.isFinite(renderedFrames) && renderedFrames >= 0) dyLastRenderedFrames = renderedFrames;
                        let addedBitrateSample = false;
                        if (Number.isFinite(totalBytes) && totalBytes > 0) {
                            const bytesDiff = totalBytes - dyLastDecodedBytes;
                            bytesAdvanced = bytesDiff > 0;
                            const timeDiff = (statTime - dyLastDecodedTime) / 1000;
                            if (timeDiff > 0 && dyLastDecodedBytes > 0 && bytesDiff >= 0) {
                                dyBpsHistory.push({ t: statTime, val: (bytesDiff * 8) / (timeDiff * 1000000) });
                                addedBitrateSample = true;
                            }
                            dyLastDecodedBytes = totalBytes;
                            dyLastDecodedTime = statTime;
                        }
                        if (!addedBitrateSample && Number.isFinite(Number(stats.bitrateBps)) && Number(stats.bitrateBps) > 0) {
                            dyBpsHistory.push({ t: statTime, val: Number(stats.bitrateBps) / 1000000 });
                        }
                        dyBpsHistory = dyBpsHistory.filter(item => statTime - item.t <= 10000);

                        const bitrateEl = document.getElementById('si-dy-bitrate');
                        if (bitrateEl) {
                            bitrateEl.innerText = dyBpsHistory.length
                                ? `${(dyBpsHistory.reduce((sum, item) => sum + item.val, 0) / dyBpsHistory.length).toFixed(2)} Mbps`
                                : '统计中…';
                        }

                        const bufferEl = document.getElementById('si-dy-latency');
                        const rttMs = stats.rttMs == null ? NaN : Number(stats.rttMs);
                        const jitterBufferMs = stats.jitterBufferMs == null ? NaN : Number(stats.jitterBufferMs);
                        if (bufferEl) {
                            const responseText = Number.isFinite(rttMs) && rttMs >= 0 ? `${Math.round(rttMs)} ms` : '暂不可测';
                            const waitText = Number.isFinite(jitterBufferMs) && jitterBufferMs >= 0 ? `${Math.round(jitterBufferMs)} ms` : '暂不可测';
                            bufferEl.innerText = `${responseText} / ${waitText}`;
                        }

                        const resEl = document.getElementById('si-dy-res');
                        const width = Number(stats.width);
                        const height = Number(stats.height);
                        const fps = stats.fps == null ? null : Number(stats.fps);
                        if (bytesAdvanced || framesAdvanced || (Number.isFinite(fps) && fps > 0)) {
                            lastDyMediaProgressAt = statTime;
                        }
                        if (resEl) {
                            let text = audioOnly ? '仅音频' : formatFullResolution(width, height, stream.resolution || '');
                            if (!audioOnly && Number.isFinite(fps) && fps >= 0) text += ` @ ${Math.round(fps)}FPS`;
                            resEl.innerText = text;
                        }
                        if (width > 0 && height > 0 && (framesAdvanced || (Number.isFinite(fps) && fps > 0))) {
                            const key = getStreamKey(stream);
                            const previous = llsProbeResults.get(key) || {};
                            const nextFps = Number.isFinite(fps) && fps > 0 ? fps : Number(previous.fps) || 0;
                            if (previous.status !== 'ok' || previous.width !== width || previous.height !== height || previous.fps !== nextFps) {
                                markLlsStreamPlayable(stream, { width, height, fps: nextFps });
                            }
                        }
                    } else if (event.data.type === 'error') {
                        clearTimeout(llsTimeout);
                        const code = event.data.code || '';
                        const reason = describePlaybackFailure('lls', event.data.message, code);
                        sourceFailed = true;
                        sourceErrorMessage = `❌ ${reason}`;
                        const qualityEl = document.getElementById('si-dy-quality');
                        if (qualityEl) qualityEl.innerText = reason;
                        clearLlsStatistics();
                        console.error('[DualLive LLS] iframe 播放错误:', event.data.message || code);
                        markLlsStreamUnplayable(stream, reason);
                        scheduleOverlayRecoverySoon(reason);
                    }
                };
                window.addEventListener('message', onLlsMessage);

                streamPlayer = {
                    destroy() {
                        clearTimeout(llsTimeout);
                        window.removeEventListener('message', onLlsMessage);
                        try { mount.contentWindow?.__dualLivePlayer?.destroy(); } catch (e) {}
                        try { mount.remove(); } catch (e) {}
                    },
                    setVolume: setIframeVolume
                };

                mount.addEventListener('load', () => {
                    if (initToken !== playerInitToken || dyDisplayElement !== mount) return;
                    applyLayout();
                }, { once: true });

                mount.srcdoc = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>html,body,#player{width:100%;height:100%;margin:0;background:#000;overflow:hidden}video,canvas{width:100%!important;height:100%!important;object-fit:contain}</style>
<script>(function(){try{Object.defineProperty(document,'hidden',{value:false,writable:false})}catch(e){}try{Object.defineProperty(document,'visibilityState',{value:'visible',writable:false})}catch(e){}try{window.addEventListener('visibilitychange',function(e){e.stopImmediatePropagation()},true);window.addEventListener('blur',function(e){e.stopImmediatePropagation()},true)}catch(e){}})();</script>
<script>
(${installLlsFetchFallback.toString()})(${safeSourceUrl});
(function(){
  var NativeRTCPeerConnection=window.RTCPeerConnection;
  window.__dualLivePeerConnections=[];
  if(!NativeRTCPeerConnection)return;
  window.RTCPeerConnection=new Proxy(NativeRTCPeerConnection,{
    construct:function(target,args){
      var pc=Reflect.construct(target,args);
      window.__dualLivePeerConnections.push(pc);
      return pc;
    }
  });
})();
</script>
<script src="${LLS_PLAYER_SCRIPT_URL}"></script>
</head><body><div id="player"></div><script>
(function(){
  var channel=${safeChannel};
  var notify=function(data){ parent.postMessage(Object.assign({channel:channel},data),'*'); };
  try {
    var sdk=window.pre_build_new_newPlayer;
    if(!sdk||!sdk.Player||!sdk.Protocol) throw new Error('抖音网页播放器内核加载失败');
    var player=new sdk.Player({
      baseConfig:{
        el:document.getElementById('player'),
        url:${safeSourceUrl},
        protocol:sdk.Protocol.RTM,
        autoplay:true,
        muted:${desiredVolume === 0 ? 'true' : 'false'},
        volume:${Number.isFinite(desiredVolume) ? desiredVolume : 0.5},
        width:'100%',height:'100%',
        ab:{enable_aac_codecs:true}
      },
      pluginsConfig:{},
      preset:{plugins:[]},
      shared:{}
    });
    window.__dualLivePlayer=player;
    player.frequentStatistics=true;
    if(player&&typeof player.on==='function') player.on('error',function(error){
      clearInterval(timer);
      notify({type:'error',code:error&&((error.code)||(error.errorCode)||(error.error&&error.error.code))||'',message:String(error&&error.message||error||'')});
    });
    var presentedFrames=0,frameCallbackStarted=false,statsFrameSamples=[],statsBusy=false;
    // 用相邻累计值的增量计算最近 5 秒，避免长时间累计平均掩盖短时卡顿。
    var lastJitterDelay=null,lastJitterSamples=null,jitterWaitWindow=[];
    setInterval(async function(){
      if(statsBusy)return;
      statsBusy=true;
      try{
        var speed=player.speedInfo||{};
        var video=document.querySelector('video');
        var frameInfo=typeof player.getVideoFrameInfo==='function'?(player.getVideoFrameInfo()||{}):{};
        var quality=player.playbackQuality||(video&&video.getVideoPlaybackQuality?video.getVideoPlaybackQuality():{})||{};
        var inboundBytes=0,inboundWidth=0,inboundHeight=0,jitterDelay=0,jitterSamples=0,rttSeconds=null;
        var pcs=window.__dualLivePeerConnections||[];
        for(var i=0;i<pcs.length;i++){
          var pc=pcs[i];
          if(!pc||pc.connectionState==='closed')continue;
          var report=await pc.getStats();
          report.forEach(function(stat){
            if(stat.type==='candidate-pair'&&stat.state==='succeeded'){
              var pairRtt=Number(stat.currentRoundTripTime);
              if(Number.isFinite(pairRtt)&&pairRtt>=0&&(stat.nominated||rttSeconds===null))rttSeconds=pairRtt;
              return;
            }
            if(stat.type!=='inbound-rtp'||stat.isRemote)return;
            var kind=stat.kind||stat.mediaType;
            var bytes=Number(stat.bytesReceived);
            if(Number.isFinite(bytes)&&bytes>=0)inboundBytes+=bytes;
            if(kind==='video'){
              inboundWidth=Math.max(inboundWidth,Number(stat.frameWidth)||0);
              inboundHeight=Math.max(inboundHeight,Number(stat.frameHeight)||0);
            }
            var delay=Number(stat.jitterBufferTargetDelay!=null?stat.jitterBufferTargetDelay:stat.jitterBufferDelay);
            var samples=Number(stat.jitterBufferEmittedCount);
            if(Number.isFinite(delay)&&delay>=0&&Number.isFinite(samples)&&samples>0){
              jitterDelay+=delay;
              jitterSamples+=samples;
            }
          });
        }
        var totalFrames=presentedFrames>0?presentedFrames:Number(quality.decodedVideoFrames!=null?quality.decodedVideoFrames:quality.totalVideoFrames);
        var now=performance.now(),fps=null;
        if(Number.isFinite(totalFrames)){
          statsFrameSamples.push({time:now,frames:totalFrames});
          statsFrameSamples=statsFrameSamples.filter(function(sample){return now-sample.time<=3500;});
          if(statsFrameSamples.length>=2){
            var firstSample=statsFrameSamples[0],elapsed=now-firstSample.time;
            if(elapsed>0)fps=(totalFrames-firstSample.frames)*1000/elapsed;
          }
        }
        var jitterBufferMs=null;
        if(jitterSamples>0){
          if(lastJitterDelay!==null&&lastJitterSamples!==null){
            var delayDelta=jitterDelay-lastJitterDelay,sampleDelta=jitterSamples-lastJitterSamples;
            if(delayDelta>=0&&sampleDelta>0)jitterWaitWindow.push({time:now,delay:delayDelta,samples:sampleDelta});
            else if(delayDelta<0||sampleDelta<0)jitterWaitWindow=[];
          }
          lastJitterDelay=jitterDelay;
          lastJitterSamples=jitterSamples;
        }
        jitterWaitWindow=jitterWaitWindow.filter(function(sample){return now-sample.time<=5000;});
        if(jitterWaitWindow.length){
          var recentDelay=0,recentSamples=0;
          jitterWaitWindow.forEach(function(sample){recentDelay+=sample.delay;recentSamples+=sample.samples;});
          if(recentSamples>0)jitterBufferMs=recentDelay/recentSamples*1000;
        }
        var recentSpeed=Number(speed.recentSpeed),avgSpeed=Number(speed.avgSpeed),rawSpeed=Number(speed.speed),currentSpeed=Number(speed.currentSpeed);
        var bitrateBps=Number.isFinite(recentSpeed)&&recentSpeed>0?recentSpeed:
          (Number.isFinite(avgSpeed)&&avgSpeed>0?avgSpeed:
          (Number.isFinite(rawSpeed)&&rawSpeed>0?rawSpeed:
          (Number.isFinite(currentSpeed)&&currentSpeed>0?currentSpeed*8000:null)));
        notify({type:'stats',stats:{
          totalByteSize:inboundBytes>0?inboundBytes:(Number.isFinite(Number(speed.totalByteSize))?Number(speed.totalByteSize):null),
          bitrateBps:bitrateBps,
          rttMs:rttSeconds===null?null:rttSeconds*1000,
          jitterBufferMs:Number.isFinite(jitterBufferMs)?jitterBufferMs:null,
          width:Number(inboundWidth||frameInfo.coded_width||frameInfo.codedWidth||(video&&video.videoWidth)||0),
          height:Number(inboundHeight||frameInfo.coded_height||frameInfo.codedHeight||(video&&video.videoHeight)||0),
          fps:Number.isFinite(fps)&&fps>=0?fps:null,
          droppedFrames:Number(quality.droppedVideoFrames||0),
          renderedFrames:Number.isFinite(totalFrames)&&totalFrames>=0?totalFrames:null,
          audioCtxState:player.audioCtxState||''
        }});
      }catch(error){}finally{statsBusy=false;}
    },1000);
    var tries=0,videoBound=false,timer=setInterval(function(){
      var video=document.querySelector('video');
      if(video&&!videoBound){
        videoBound=true;
        if(typeof video.requestVideoFrameCallback==='function'&&!frameCallbackStarted){
          frameCallbackStarted=true;
          statsFrameSamples=[];
          var countPresentedFrame=function(){
            presentedFrames++;
            video.requestVideoFrameCallback(countPresentedFrame);
          };
          video.requestVideoFrameCallback(countPresentedFrame);
        }
        var ready=function(){clearInterval(timer);notify({type:'ready'});};
        video.addEventListener('playing',ready,{once:true});
        if(video.readyState>=2) ready();
      }
      if(++tries>=120){clearInterval(timer);notify({type:'error',message:'连接超时'});}
    },100);
  } catch(error){notify({type:'error',message:String(error&&error.message||error)});}
})();
</script></body></html>`;

                llsTimeout = setTimeout(() => {
                    if (initToken !== playerInitToken || dyDisplayElement !== mount) return;
                    sourceFailed = true;
                    sourceErrorMessage = '❌ LLS 连接超时，可切回 FLV/HLS';
                    document.getElementById('si-dy-quality').innerText = 'LLS 连接超时（可切回 FLV/HLS）';
                    clearLlsStatistics();
                    markLlsStreamUnplayable(stream, sourceErrorMessage);
                    scheduleOverlayRecoverySoon('LLS 连接超时');
                }, 15000);

                playerContainer.appendChild(mount);
                applyLayout();
            } else {
                dyVideoElement = document.createElement('video');
                dyVideoElement.id = 'douyin-overlay-video';
                dyVideoElement.autoplay = true;
                dyVideoElement.crossOrigin = 'anonymous';
                dyVideoElement.volume = desiredVolume;
                dyDisplayElement = dyVideoElement;
                const reportMediaFailure = (reason = '媒体播放失败') => {
                    if (initToken !== playerInitToken) return;
                    sourceFailed = true;
                    sourceErrorMessage = `❌ ${reason}`;
                    markStreamUnplayable(stream, reason);
                    scheduleOverlayRecoverySoon(reason);
                };
                dyVideoElement.addEventListener('error', () => reportMediaFailure());
                dyVideoElement.addEventListener('playing', () => {
                    if (initToken !== playerInitToken) return;
                    sourceFailed = false;
                    sourceErrorMessage = '';
                    lastDyMediaProgressAt = Date.now();
                    markStreamPlayable(stream);
                    resetOverlayRecovery();
                });
                playerContainer.appendChild(dyVideoElement);

                try {
                    if (stream.format === 'flv' && typeof mpegts !== 'undefined' && mpegts.isSupported()) {
                        streamPlayer = mpegts.createPlayer({
                            type: 'flv',
                            url: sourceUrl,
                            isLive: true,
                            hasAudio: true,
                            hasVideo: !audioOnly
                        }, {
                            enableWorker: true,
                            enableStashBuffer: false
                        });

                        streamPlayer.on(mpegts.Events.ERROR, (type, detail, info) => {
                        const status = Number(info?.code);
                        reportMediaFailure(describePlaybackFailure('flv',
                            status >= 400 && status <= 599 ? `HTTP ${status}` : detail || type));
                        });
                        streamPlayer.attachMediaElement(dyVideoElement);
                        streamPlayer.load();
                        Promise.resolve(streamPlayer.play()).catch(e => {
                            if (e?.name !== 'NotAllowedError' && e?.name !== 'AbortError') {
                                reportMediaFailure('FLV 启动播放失败');
                            }
                        });
                    } else if (stream.format === 'hls' && typeof Hls !== 'undefined' && Hls.isSupported()) {
                        const hls = new Hls({
                            enableWorker: true,
                            lowLatencyMode: true,
                            backBufferLength: 30
                        });
                        let networkRetryCount = 0;
                        let mediaRetryCount = 0;
                        streamPlayer = hls;

                        hls.on(Hls.Events.MANIFEST_PARSED, () => {
                            dyVideoElement.play().catch(e => console.warn('[DualLive HLS] 自动播放失败:', e));
                        });
                        hls.on(Hls.Events.ERROR, (event, data) => {
                            if (!data.fatal) return;
                            if (data.type === Hls.ErrorTypes.NETWORK_ERROR && networkRetryCount < 2) {
                                networkRetryCount++;
                                hls.startLoad();
                                return;
                            }
                            if (data.type === Hls.ErrorTypes.MEDIA_ERROR && mediaRetryCount < 2) {
                                mediaRetryCount++;
                                hls.recoverMediaError();
                                return;
                            }
                        const status = Number(data.response?.code);
                        reportMediaFailure(describePlaybackFailure('hls',
                            status >= 400 && status <= 599 ? `HTTP ${status}` : data.details || data.type));
                            console.error('[DualLive HLS] 致命错误:', data);
                            hls.destroy();
                        });
                        hls.loadSource(sourceUrl);
                        hls.attachMedia(dyVideoElement);
                    } else if (stream.format === 'hls' && dyVideoElement.canPlayType('application/vnd.apple.mpegurl')) {
                        const video = dyVideoElement;
                        video.src = sourceUrl;
                        video.play().catch(e => console.warn('[DualLive HLS] 原生播放失败:', e));
                        streamPlayer = {
                            destroy() {
                                video.pause();
                                video.removeAttribute('src');
                                video.load();
                            }
                        };
                    } else {
                        reportMediaFailure('当前浏览器不支持所选播放源');
                        console.error('[DualLive] 当前浏览器不支持所选播放源:', stream);
                    }
                } catch (error) {
                    reportMediaFailure(`${stream.format.toUpperCase()} 初始化失败`);
                    console.error('[DualLive] 播放器初始化失败:', error);
                }
            }

            // 手动载入新源时显示双画面；自动恢复必须保留用户当前选择。
            if (!autoRecovery) {
                isBiliVisible = true;
                isDyVisible = true;
                const btnBili = document.getElementById('btn-toggle-bili');
                const btnDy = document.getElementById('btn-toggle-dy');
                if(btnBili) { btnBili.innerText = '关闭B站画面'; btnBili.className = 'dl-btn dl-btn-danger'; }
                if(btnDy) { btnDy.innerText = '关闭抖音画面'; btnDy.className = 'dl-btn dl-btn-danger'; }
            }
            applyLayout();
        };

        const biliLayoutClasses = ['dl-bili-split', 'dl-bili-dyonly'];
        const dyLayoutClasses = ['dl-dy-split', 'dl-dy-dyonly', 'dl-dy-hidden'];

        // 进出全屏、切换游戏窗口、切回前台时，B 站播放器会在事件之后继续异步改 DOM。
        // 单次 applyLayout 很容易跑在它前面，所以在一小段时间内重复校正几次。
        const scheduleApplyLayout = (delays = [0, 120, 400, 1200]) => {
            for (const timer of layoutTimers) clearTimeout(timer);
            layoutTimers = [];
            if (!dyDisplayElement) {
                updateSourceLabels();
                updateDanmakuLayer();
                return;
            }
            for (const delay of delays) {
                const timer = window.setTimeout(() => { applyLayout(); }, delay);
                layoutTimers.push(timer);
            }
        };

        const ensureLayoutObserver = (container) => {
            if (!container || typeof MutationObserver === 'undefined') return;
            if (layoutObserver && layoutObserverTarget === container) return;
            if (!layoutObserver) {
                layoutObserver = new MutationObserver(mutations => {
                    const videoChanged = mutations.some(mutation => {
                        if (mutation.type !== 'childList') return false;
                        return Array.from(mutation.addedNodes).concat(Array.from(mutation.removedNodes))
                            .some(node => node.nodeType === 1 &&
                                (node.tagName === 'VIDEO' || node.querySelector?.('video')));
                    });
                    if (videoChanged) scheduleApplyLayout();
                });
            }
            layoutObserver.disconnect();
            layoutObserverTarget = container;
            layoutObserver.observe(container, { childList: true, subtree: true });
        };

        const applyLayout = () => {
            // B 站 React 播放器会在开播/切换清晰度时替换 DOM；每次布局前把抖音画面移到当前容器。
            ensureDyDisplayAttached();
            if (dyDisplayElement) ensureDouyinVolumeControl();
           else if (douyinVolumeControl) hideDouyinVolumeControl();
            const bVid = getActiveBiliVideo();
            const container = getPlayerContainer();
            const biliVideos = getBiliVideoCandidates();
            const hasDy = !!(dyDisplayElement && document.contains(dyDisplayElement));

            // 每次应用前清掉所有旧容器/旧 video 上的布局类。
            // 全屏退出后 B 站可能同时短暂保留新旧两个 video；只清理当前节点会让旧节点继续半屏显示。
            document.querySelectorAll('.dl-split-host').forEach(el => el.classList.remove('dl-split-host'));
            document.querySelectorAll('[data-dl-bili-picture-off]').forEach(el => el.removeAttribute('data-dl-bili-picture-off'));
            biliVideos.forEach(video => video.classList.remove(...biliLayoutClasses));
            if (dyDisplayElement) dyDisplayElement.classList.remove(...dyLayoutClasses);
            if (container && !isBiliVisible && isDyVisible && hasDy) {
                container.setAttribute('data-dl-bili-picture-off', '1');
            }

            if (!bVid) {
                if (dyDisplayElement) {
                    dyDisplayElement.classList.add(isDyVisible ? 'dl-dy-dyonly' : 'dl-dy-hidden');
                }
                lastLaidOutBiliVideo = null;
                lastLaidOutContainer = container;
                updateSourceLabels();
                updateDanmakuLayer();
                return;
            }

            // 未载入抖音画面时，阻止触发分屏逻辑，防止浏览器窗口缩放导致B站画面被误挤压
            if (!hasDy) {
                lastLaidOutBiliVideo = bVid;
                lastLaidOutContainer = container;
                updateSourceLabels();
                updateDanmakuLayer();
                return;
            }

            if (isBiliVisible && isDyVisible) {
                // 上下分屏。容器类让 B 站后续替换出来的新 video 也自动只占上半屏。
                if (container) container.classList.add('dl-split-host');
                const visibleBiliVideos = biliVideos.filter(video =>
                    video.videoWidth > 0 && video.readyState >= 2 && isBiliVideoVisible(video));
                for (const video of (visibleBiliVideos.length ? visibleBiliVideos : [bVid])) {
                    video.classList.add('dl-bili-split');
                }
                dyDisplayElement.classList.add('dl-dy-split');
            } else if (!isBiliVisible && isDyVisible) {
                // 纯抖音
                biliVideos.forEach(video => video.classList.add('dl-bili-dyonly'));
                dyDisplayElement.classList.add('dl-dy-dyonly');
            } else if (isBiliVisible && !isDyVisible) {
                // 纯B站 (原生状态)
                dyDisplayElement.classList.add('dl-dy-hidden');
            } else {
                // 全关
                biliVideos.forEach(video => video.classList.add('dl-bili-dyonly'));
                dyDisplayElement.classList.add('dl-dy-hidden');
            }
            lastLaidOutBiliVideo = bVid;
            lastLaidOutContainer = container;
            ensureLayoutObserver(container);
            updateSourceLabels();
            updateDanmakuLayer();
        };

        const relayoutAfterViewportChange = () => scheduleApplyLayout();
        window.addEventListener('resize', relayoutAfterViewportChange);
        window.addEventListener('orientationchange', relayoutAfterViewportChange);
        document.addEventListener('fullscreenchange', relayoutAfterViewportChange);
        document.addEventListener('webkitfullscreenchange', relayoutAfterViewportChange);
        document.addEventListener('visibilitychange', () => {
            // 切回浏览器前台时 B 站通常会重新接管播放器；等它完成后再校正分屏。
            if (document.visibilityState === 'visible') scheduleApplyLayout([0, 150, 600, 1500]);
        });
        window.addEventListener('focus', () => scheduleApplyLayout([0, 200, 800]));
        window.addEventListener('pageshow', () => scheduleApplyLayout([0, 200, 800]));

        // 不依赖控制面板是否打开：切到后台看游戏时也要持续检查 B 站原生画面。
        window.setInterval(checkBiliAutoRecovery, 2000);

        whenDocumentReady(() => { if (document.body) initUI(); });
    }
})();
