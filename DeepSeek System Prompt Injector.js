// ==UserScript==
// @name         DeepSeek System Prompt Injector
// @name:zh-CN   ds系统提示词
// @version      3.8.0
// @description:zh-CN 为DeepSeek AI设置自定义系统提示词，支持多账号切换（Nova风格UI，预设管理、导入导出、动态变量、编辑首条消息修复、剪贴板清理）
// @author       Shiki & 灰魂
// @match        https://chat.deepseek.com
// @match        https://chat.deepseek.com/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_addStyle
// @grant        unsafeWindow
// @grant        GM_xmlhttpRequest
// @run-at       document-start
// @license      MIT
// ==/UserScript==

(function () {
    "use strict";

    // ═══════════════════════════════════════
    // 配置
    // ═══════════════════════════════════════
    const DEBUG = true;
    const STORAGE_KEY = "deepseek_system_prompt";
    const ENABLED_KEY = "deepseek_system_prompt_enabled";
    const FORMAT_KEY = "deepseek_system_prompt_format";
    const TEMPLATE_KEY = "deepseek_custom_template";
    const PRESETS_KEY = "deepseek_presets";
    const CURRENT_PRESET_KEY = "deepseek_current_preset";
    const PREFIX_KEY = "deepseek_message_prefix";
    const PREFIX_ENABLED_KEY = "deepseek_message_prefix_enabled";
    const DEBUG_MODE_KEY = "deepseek_debug_mode_enabled";
    const ACCOUNTS_KEY = "deepseek_accounts";
    const CURRENT_ACCOUNT_KEY = "deepseek_current_account";
    // DeepSeek 网页端不同动作（发送/重试/编辑）可能命中不同接口；
    // 这里用“较宽”的匹配，再依赖 modifyRequestBody 内部的 JSON 结构判断兜底。
    const API_PATTERNS = [
        '/api/v0/chat/completion',
        '/api/v0/chat',          // 覆盖 edit / regenerate 等变体
        '/api/v0/chat_session',  // 部分动作可能走 session 接口
        '/chat/completions',
        '/v1/chat/completions'
    ];

    // DeepSeek 特殊 token（全角字符）
    const DS_TOKENS = {
        BOS: '<｜begin▁of▁sentence｜>',
        SYSTEM: '<｜System｜>',
        USER: '<｜User｜>',
        ASSISTANT: '<｜Assistant｜>',
        END_THINK: '</think>'
    };

    const DEFAULT_TEMPLATE = `{system}

---

{user}`;

    // 默认预设
    const DEFAULT_PRESETS = [
        { id: 'default', name: '默认', prompt: '', template: DEFAULT_TEMPLATE, useNative: true }
    ];

    let systemPrompt = GM_getValue(STORAGE_KEY, "");
    let isEnabled = GM_getValue(ENABLED_KEY, true);
    let useNativeFormat = GM_getValue(FORMAT_KEY, true);
    let customTemplate = GM_getValue(TEMPLATE_KEY, DEFAULT_TEMPLATE);
    let presets = GM_getValue(PRESETS_KEY, DEFAULT_PRESETS);
    let currentPresetId = GM_getValue(CURRENT_PRESET_KEY, 'default');
    let messagePrefix = GM_getValue(PREFIX_KEY, "当前日期是 {date}，时间是 {time}。\n\n");
    let prefixEnabled = GM_getValue(PREFIX_ENABLED_KEY, false);
    let debugModeEnabled = GM_getValue(DEBUG_MODE_KEY, false);
    let accounts = GM_getValue(ACCOUNTS_KEY, []);
    let currentAccountId = GM_getValue(CURRENT_ACCOUNT_KEY, null);
    const interceptedInstances = new WeakSet();

    function log(...args) {
        if (DEBUG) console.log("[DeepSeek SP]", ...args);
    }

    // ═══════════════════════════════════════
    // 调试模式控制
    // ═══════════════════════════════════════
    function enableDebugMode() {
        localStorage.setItem('__appKit_@deepseek/chat_debug', '{"value":true,"__version":"0"}');
        debugModeEnabled = true;
        GM_setValue(DEBUG_MODE_KEY, true);
        log("Debug mode enabled");
        location.reload();
    }

    function disableDebugMode() {
        localStorage.setItem('__appKit_@deepseek/chat_debug', '{"value":false,"__version":"0"}');
        localStorage.setItem('__appKit_@deepseek/chat_debugPanelEnabled', '{"value":false,"__version":"0"}');
        localStorage.setItem('__debugVersionUpdateDisabled', '{"value":false,"__version":"20241018.1"}');
        localStorage.removeItem('debugModelChannel');
        localStorage.removeItem('debugLiteModelChannel');
        debugModeEnabled = false;
        GM_setValue(DEBUG_MODE_KEY, false);
        log("Debug mode disabled");
        location.reload();
    }

    // ═══════════════════════════════════════
    // 变量系统
    // ═══════════════════════════════════════
    function replaceVariables(text) {
        if (!text) return text;

        const now = new Date();
        const pad = (n) => n.toString().padStart(2, '0');

        const variables = {
            '{date}': `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`,
            '{time}': `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`,
            '{datetime}': `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`,
            '{year}': now.getFullYear().toString(),
            '{month}': pad(now.getMonth() + 1),
            '{day}': pad(now.getDate()),
            '{hour}': pad(now.getHours()),
            '{minute}': pad(now.getMinutes()),
            '{weekday}': ['日', '一', '二', '三', '四', '五', '六'][now.getDay()],
            '{weekday_en}': ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][now.getDay()],
            '{timestamp}': Math.floor(now.getTime() / 1000).toString(),
            '{random}': Math.random().toString(36).substring(2, 8),
        };

        let result = text;
        for (const [key, value] of Object.entries(variables)) {
            result = result.replace(new RegExp(key.replace(/[{}]/g, '\\$&'), 'g'), value);
        }
        return result;
    }

    // ═══════════════════════════════════════
    // 注入提示气泡
    // ═══════════════════════════════════════
    function showInjectionToast() {
        // 移除旧的 toast
        const oldToast = document.querySelector('.dsp-toast');
        if (oldToast) oldToast.remove();

        const toast = document.createElement('div');
        toast.className = 'dsp-toast';
        toast.innerHTML = `
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <polyline points="20 6 9 17 4 12"/>
            </svg>
            <span>系统提示词已注入</span>
        `;
        document.body.appendChild(toast);

        // 触发动画
        requestAnimationFrame(() => {
            toast.classList.add('show');
        });

        // 3秒后消失
        setTimeout(() => {
            toast.classList.remove('show');
            setTimeout(() => toast.remove(), 300);
        }, 3000);
    }

    // ═══════════════════════════════════════
    // 消息前缀处理
    // ═══════════════════════════════════════
    function applyMessagePrefix(userMessage) {
        if (!prefixEnabled || !messagePrefix) return userMessage;
        const processedPrefix = replaceVariables(messagePrefix);
        return processedPrefix + userMessage;
    }

    // ═══════════════════════════════════════
    // 系统提示词格式化
    // ═══════════════════════════════════════
    function formatPrompt(userMessage) {
        // 用户消息添加前缀
        const prefixedMessage = applyMessagePrefix(userMessage);

        if (!systemPrompt || !isEnabled) return prefixedMessage;

        // 系统提示词替换变量
        const processedPrompt = replaceVariables(systemPrompt);

        if (useNativeFormat) {
            return `${DS_TOKENS.SYSTEM}${processedPrompt}${DS_TOKENS.USER}${prefixedMessage}`;
        } else {
            return replaceVariables(customTemplate)
                .replace(/\{system\}/g, processedPrompt)
                .replace(/\{user\}/g, prefixedMessage);
        }
    }

    // 获取当前格式的系统提示词前缀（用于清理显示）
    function getSystemPromptPrefix() {
        if (!systemPrompt) return null;

        if (useNativeFormat) {
            return `${DS_TOKENS.SYSTEM}${systemPrompt}${DS_TOKENS.USER}`;
        } else {
            const parts = customTemplate.split('{user}');
            if (parts.length > 0) {
                return parts[0].replace(/\{system\}/g, systemPrompt);
            }
            return systemPrompt;
        }
    }

    // ═══════════════════════════════════════
    // 预设管理
    // ═══════════════════════════════════════
    function savePresets() {
        GM_setValue(PRESETS_KEY, presets);
        GM_setValue(CURRENT_PRESET_KEY, currentPresetId);
    }

    function loadPreset(presetId) {
        const preset = presets.find(p => p.id === presetId);
        if (preset) {
            currentPresetId = presetId;
            systemPrompt = preset.prompt;
            customTemplate = preset.template || DEFAULT_TEMPLATE;
            useNativeFormat = preset.useNative !== false;
            messagePrefix = preset.prefix || "当前日期是 {date}，时间是 {time}。\n\n";
            prefixEnabled = preset.prefixEnabled || false;

            GM_setValue(STORAGE_KEY, systemPrompt);
            GM_setValue(TEMPLATE_KEY, customTemplate);
            GM_setValue(FORMAT_KEY, useNativeFormat);
            GM_setValue(CURRENT_PRESET_KEY, currentPresetId);
            GM_setValue(PREFIX_KEY, messagePrefix);
            GM_setValue(PREFIX_ENABLED_KEY, prefixEnabled);

            log("Loaded preset:", preset.name);
            return true;
        }
        return false;
    }

    function createPreset(name) {
        const id = 'preset_' + Date.now();
        const newPreset = {
            id,
            name,
            prompt: '',
            template: DEFAULT_TEMPLATE,
            useNative: true,
            prefix: "当前日期是 {date}，时间是 {time}。\n\n",
            prefixEnabled: false
        };
        presets.push(newPreset);
        currentPresetId = id;
        savePresets();
        return newPreset;
    }

    function updateCurrentPreset() {
        const preset = presets.find(p => p.id === currentPresetId);
        if (preset) {
            preset.prompt = systemPrompt;
            preset.template = customTemplate;
            preset.useNative = useNativeFormat;
            preset.prefix = messagePrefix;
            preset.prefixEnabled = prefixEnabled;
            savePresets();
        }
    }

    function deletePreset(presetId) {
        if (presetId === 'default') return false;
        const index = presets.findIndex(p => p.id === presetId);
        if (index > -1) {
            presets.splice(index, 1);
            if (currentPresetId === presetId) {
                loadPreset('default');
            }
            savePresets();
            return true;
        }
        return false;
    }

    function renamePreset(presetId, newName) {
        const preset = presets.find(p => p.id === presetId);
        if (preset && presetId !== 'default') {
            preset.name = newName;
            savePresets();
            return true;
        }
        return false;
    }

    // ═══════════════════════════════════════
    // 导入/导出
    // ═══════════════════════════════════════
    function exportConfig() {
        const config = {
            version: '3.6.1',
            exportTime: new Date().toISOString(),
            enabled: isEnabled,
            currentPresetId,
            presets,
            currentSettings: {
                prompt: systemPrompt,
                template: customTemplate,
                useNative: useNativeFormat,
                prefix: messagePrefix,
                prefixEnabled: prefixEnabled
            }
        };

        const blob = new Blob([JSON.stringify(config, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `deepseek-prompts-${new Date().toISOString().slice(0,10)}.json`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);

        log("Config exported");
    }

    function importConfig(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = (e) => {
                try {
                    const config = JSON.parse(e.target.result);

                    // 验证配置格式
                    if (!config.presets || !Array.isArray(config.presets)) {
                        throw new Error('无效的配置文件格式');
                    }

                    // 合并预设（避免覆盖同名预设）
                    const existingIds = new Set(presets.map(p => p.id));
                    const newPresets = config.presets.filter(p => {
                        if (p.id === 'default') {
                            // 更新默认预设
                            const def = presets.find(pp => pp.id === 'default');
                            if (def) {
                                def.prompt = p.prompt;
                                def.template = p.template;
                                def.useNative = p.useNative;
                            }
                            return false;
                        }
                        if (existingIds.has(p.id)) {
                            // 生成新 ID
                            p.id = 'preset_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
                        }
                        return true;
                    });

                    presets.push(...newPresets);
                    savePresets();

                    // 如果有当前设置，应用它
                    if (config.currentSettings) {
                        systemPrompt = config.currentSettings.prompt || '';
                        customTemplate = config.currentSettings.template || DEFAULT_TEMPLATE;
                        useNativeFormat = config.currentSettings.useNative !== false;
                        messagePrefix = config.currentSettings.prefix || "当前日期是 {date}，时间是 {time}。\n\n";
                        prefixEnabled = config.currentSettings.prefixEnabled || false;
                        GM_setValue(STORAGE_KEY, systemPrompt);
                        GM_setValue(TEMPLATE_KEY, customTemplate);
                        GM_setValue(FORMAT_KEY, useNativeFormat);
                        GM_setValue(PREFIX_KEY, messagePrefix);
                        GM_setValue(PREFIX_ENABLED_KEY, prefixEnabled);
                    }

                    if (config.enabled !== undefined) {
                        isEnabled = config.enabled;
                        GM_setValue(ENABLED_KEY, isEnabled);
                    }

                    log("Config imported:", config);
                    resolve({ imported: newPresets.length, total: config.presets.length });
                } catch (err) {
                    reject(err);
                }
            };
            reader.onerror = () => reject(new Error('文件读取失败'));
            reader.readAsText(file);
        });
    }

    // ═══════════════════════════════════════
    // 请求修改逻辑
    // ═══════════════════════════════════════

    // 检查消息是否已经包含前缀（防止重复添加）
    function hasPrefix(text) {
        if (!messagePrefix || !text) return false;
        // 使用前缀的固定部分来检测（去除变量部分）
        const fixedParts = messagePrefix.split(/\{[^}]+\}/);
        // 如果前缀全是变量，就检查常见的日期时间格式
        if (fixedParts.every(p => !p.trim())) {
            // 检查是否以日期时间格式开头
            return /^(当前日期是\s*\d{4}-\d{2}-\d{2}|Current date is)/.test(text);
        }
        // 检查固定部分是否存在
        return fixedParts.filter(p => p.trim()).some(part => text.includes(part.trim()));
    }

    // 检查消息是否已经包含系统提示词（防止重复添加）
    function hasSystemPromptInjected(text) {
        if (!systemPrompt || !text) return false;
        // 检查原生 token
        if (text.includes(DS_TOKENS.SYSTEM) || text.includes(DS_TOKENS.USER)) {
            return true;
        }
        // 检查系统提示词的开头部分（至少20个字符）
        const promptStart = systemPrompt.substring(0, Math.min(30, systemPrompt.length));
        if (promptStart.length >= 10 && text.includes(promptStart)) {
            return true;
        }
        return false;
    }

    function modifyRequestBody(body, url = '') {
        if (!body) return body;

        // 检查是否需要做任何修改
        const needSystemPrompt = systemPrompt && isEnabled;
        const needPrefix = prefixEnabled && messagePrefix;

        if (!needSystemPrompt && !needPrefix) return body;

        try {
            let data = typeof body === 'string' ? JSON.parse(body) : body;
            let modified = false;

            log("Original request:", JSON.stringify(data, null, 2));

            const urlString = (url || '').toString();

            // root/首条：parent_message_id 为空值（DeepSeek 新对话通常为 null）
            const parentId = data?.parent_message_id;
            const isParentEmpty = parentId === null ||
                                  parentId === undefined ||
                                  parentId === '' ||
                                  parentId === '0' ||
                                  parentId === 0;

            // 编辑：不同版本可能用不同字段名；也可能直接体现在 URL 上
            const editMessageId =
                data?.message_id ??
                data?.edit_message_id ??
                data?.edited_message_id ??
                data?.target_message_id ??
                data?.targetMessageId ??
                data?.messageId ??
                null;

            const isEditMessage =
                !!editMessageId ||
                /(?:^|\/)(?:edit|message_edit|edit_message)(?:\/|$)/i.test(urlString);

            // 系统提示词注入：root 首条 + 编辑场景都需要尝试（由 hasSystemPromptInjected 防重复）
            const shouldInjectSystemPrompt = isParentEmpty || isEditMessage;

            log("Message context:", {
                url: urlString,
                parentId,
                isParentEmpty,
                editMessageId,
                isEditMessage,
                shouldInjectSystemPrompt,
                needSystemPrompt,
                systemPromptLen: (systemPrompt || '').length,
                isEnabled
            });

            if (data?.prompt && typeof data.prompt === 'string') {
                // DeepSeek 的 prompt 格式
                let newPrompt = data.prompt;

                // 应用消息前缀（每次都应用，但检查是否已存在）
                if (needPrefix && !hasPrefix(newPrompt)) {
                    newPrompt = applyMessagePrefix(newPrompt);
                    modified = true;
                    log("Applied message prefix");
                }

                // 系统提示词：首条 + 编辑时都尝试注入（检查是否已存在，防止重复注入）
                if (needSystemPrompt && shouldInjectSystemPrompt && !hasSystemPromptInjected(newPrompt)) {
                    const processedPrompt = replaceVariables(systemPrompt);
                    if (useNativeFormat) {
                        newPrompt = `${DS_TOKENS.SYSTEM}${processedPrompt}${DS_TOKENS.USER}${newPrompt}`;
                    } else {
                        newPrompt = replaceVariables(customTemplate)
                            .replace(/\{system\}/g, processedPrompt)
                            .replace(/\{user\}/g, newPrompt);
                    }
                    modified = true;
                    log("Applied system prompt");
                }

                data.prompt = newPrompt;
            }
            else if (Array.isArray(data?.messages)) {
                // OpenAI 兼容的 messages 格式

                // 注入系统提示词（首条 + 编辑）
                if (needSystemPrompt && shouldInjectSystemPrompt) {
                    const systemMsgIndex = data.messages.findIndex(m => m.role === 'system');
                    const firstUserMsg = data.messages.find(m => m.role === 'user');

                    // 检查是否已经注入过
                    const alreadyInjected = systemMsgIndex >= 0 &&
                        hasSystemPromptInjected(data.messages[systemMsgIndex].content);

                    if (!alreadyInjected) {
                        const processedPrompt = replaceVariables(systemPrompt);

                        if (systemMsgIndex >= 0) {
                            data.messages[systemMsgIndex].content = `${processedPrompt}\n\n${data.messages[systemMsgIndex].content}`;
                        } else {
                            data.messages.unshift({ role: 'system', content: processedPrompt });
                        }
                        modified = true;
                        log("Applied system prompt to messages");
                    }
                }

                // 对所有用户消息应用前缀（检查是否已存在）
                if (needPrefix) {
                    let prefixApplied = false;
                    data.messages = data.messages.map(msg => {
                        if (msg.role === 'user' && typeof msg.content === 'string') {
                            if (!hasPrefix(msg.content)) {
                                prefixApplied = true;
                                return { ...msg, content: applyMessagePrefix(msg.content) };
                            }
                        }
                        return msg;
                    });
                    if (prefixApplied) {
                        modified = true;
                        log("Applied prefix to user messages");
                    }
                }
            }

            if (modified) {
                log("Modified request:", JSON.stringify(data, null, 2));
                // 显示注入提示
                showInjectionToast();
                return typeof body === 'string' ? JSON.stringify(data) : data;
            }
        } catch (e) {
            log("Error:", e);
        }
        return body;
    }

    // ═══════════════════════════════════════
    // XHR 拦截
    // ═══════════════════════════════════════
    function interceptXHR() {
        const XHR = unsafeWindow.XMLHttpRequest;
        if (interceptedInstances.has(XHR.prototype)) return;

        const originalOpen = XHR.prototype.open;
        const originalSend = XHR.prototype.send;

        XHR.prototype.open = function(method, url, ...args) {
            this._url = url;
            return originalOpen.call(this, method, url, ...args);
        };

        XHR.prototype.send = function(body) {
            if (this._url && API_PATTERNS.some(p => this._url.includes(p))) {
                if (DEBUG && body) log("Intercept XHR:", this._url, typeof body);
                arguments[0] = modifyRequestBody(body, this._url);
            }
            return originalSend.apply(this, arguments);
        };

        interceptedInstances.add(XHR.prototype);
    }

    // ═══════════════════════════════════════
    // Fetch 拦截
    // ═══════════════════════════════════════
    function interceptFetch() {
        const originalFetch = unsafeWindow.fetch;
        if (interceptedInstances.has(originalFetch)) return;

        function isRequestLike(v) {
            return v && typeof v === 'object' && typeof v.clone === 'function' && typeof v.url === 'string';
        }

        function isBlobLike(v) {
            return v && typeof v === 'object' && typeof v.text === 'function' && typeof v.arrayBuffer === 'function';
        }

        unsafeWindow.fetch = async function(input, init) {
            const requestLike = isRequestLike(input);
            const urlString = requestLike ? input.url : input.toString();
            const shouldHandle = API_PATTERNS.some(p => urlString.includes(p));

            if (!shouldHandle) {
                return originalFetch.call(this, input, init);
            }

            const initObj = init || {};
            const hasInitBody = Object.prototype.hasOwnProperty.call(initObj, 'body') && initObj.body != null;

            // Case 1: fetch(url, { body })
            if (hasInitBody) {
                const modifiedInit = { ...initObj };
                const bodyVal = modifiedInit.body;

                if (isBlobLike(bodyVal)) {
                    const text = await bodyVal.text();
                    const modifiedText = modifyRequestBody(text, urlString);
                    if (modifiedText !== text) {
                        const BlobCtor = unsafeWindow.Blob || Blob;
                        modifiedInit.body = new BlobCtor([modifiedText], { type: bodyVal.type || 'application/json' });
                    }
                } else if (typeof bodyVal === 'string') {
                    modifiedInit.body = modifyRequestBody(bodyVal, urlString);
                } else {
                    // 其他类型（FormData/URLSearchParams/ReadableStream...）不安全，直接放行
                    if (DEBUG) log("Fetch body type not supported:", Object.prototype.toString.call(bodyVal));
                }

                return originalFetch.call(this, input, modifiedInit);
            }

            // Case 2: fetch(Request)（DeepSeek 某些动作会用这种方式，init.body 为空导致旧逻辑完全不触发）
            if (requestLike) {
                try {
                    const cloned = input.clone();
                    const text = await cloned.text();
                    const modifiedText = modifyRequestBody(text, urlString);

                    if (modifiedText !== text) {
                        const RequestCtor = unsafeWindow.Request || Request;
                        const newReq = new RequestCtor(input, { ...initObj, body: modifiedText });
                        return originalFetch.call(this, newReq);
                    }
                } catch (e) {
                    log("Fetch request body read failed:", e);
                }
            } else {
                if (DEBUG) log("Fetch matched URL but no body in init:", urlString);
            }

            return originalFetch.call(this, input, init);
        };

        interceptedInstances.add(originalFetch);
    }

    // ═══════════════════════════════════════
    // Nova Silent Sky 样式
    // ═══════════════════════════════════════
    GM_addStyle(`
        :root {
            --dsp-bg-deep: linear-gradient(180deg, #090e16 0%, #0a1220 100%);
            --dsp-bg-elev: linear-gradient(180deg, rgba(16,28,48,0.28), rgba(9,16,30,0.35));
            --dsp-line-weak: #162339;
            --dsp-line-strong: #223650;
            --dsp-text-main: #d9e5ff;
            --dsp-text-dim: #8fa0bf;
            --dsp-btn-bg: #0e1a2d;
            --dsp-btn-hover: #15263f;
            --dsp-btn-active: #132745;
            --dsp-btn-active-glow: rgba(42,168,255,0.14);
            --dsp-btn-border-active: #254569;
            --dsp-btn-border: #223650;
            --dsp-accent: #2aa8ff;
            --dsp-accent-soft: rgba(42,168,255,0.35);
            --dsp-accent-faint: rgba(42,168,255,0.12);
            --dsp-success: #22c55e;
            --dsp-danger: #ef4444;
            --dsp-notch: 10px;
        }

        @keyframes dsp-sheen {
            0% { background-position: 0% 0; }
            100% { background-position: 200% 0; }
        }
        @keyframes dsp-card-glow {
            0%, 100% { opacity: .25; }
            50% { opacity: .38; }
        }
        @keyframes dsp-aurora-run {
            0% { background-position: 0% 0; }
            100% { background-position: 200% 0; }
        }
        @keyframes dsp-fade-in {
            from { opacity: 0; transform: translateY(12px) scale(0.97); }
            to { opacity: 1; transform: translateY(0) scale(1); }
        }
        @keyframes dsp-fade-out {
            from { opacity: 1; transform: scale(1); }
            to { opacity: 0; transform: scale(0.96); }
        }
        @keyframes dsp-toast-in {
            from { opacity: 0; transform: translateX(100%) scale(0.9); }
            to { opacity: 1; transform: translateX(0) scale(1); }
        }
        @keyframes dsp-toast-out {
            from { opacity: 1; transform: translateX(0) scale(1); }
            to { opacity: 0; transform: translateX(100%) scale(0.9); }
        }

        /* Toast 通知 */
        .dsp-toast {
            position: fixed;
            bottom: 100px;
            right: 24px;
            background: linear-gradient(135deg, #0d2818 0%, #0a1f14 100%);
            border: 1px solid rgba(34, 197, 94, 0.4);
            color: var(--dsp-success);
            padding: 10px 16px;
            font-size: 13px;
            font-weight: 500;
            display: flex;
            align-items: center;
            gap: 8px;
            z-index: 999999;
            clip-path: polygon(
                0 6px, 6px 0,
                calc(100% - 6px) 0, 100% 6px,
                100% calc(100% - 6px), calc(100% - 6px) 100%,
                6px 100%, 0 calc(100% - 6px)
            );
            box-shadow: 0 4px 20px rgba(34, 197, 94, 0.2), inset 0 0 0 1px rgba(34, 197, 94, 0.1);
            opacity: 0;
            transform: translateX(100%) scale(0.9);
            transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
            font-family: 'SF Pro Display', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        }
        .dsp-toast.show {
            opacity: 1;
            transform: translateX(0) scale(1);
        }
        .dsp-toast svg {
            width: 16px;
            height: 16px;
            stroke: var(--dsp-success);
        }

        /* FAB 容器 */
        .dsp-fab-container {
            position: fixed;
            bottom: 24px;
            right: 24px;
            z-index: 99999;
            display: flex;
            align-items: center;
            gap: 8px;
        }

        /* 快捷开关按钮 */
        .dsp-quick-toggle {
            width: 36px;
            height: 36px;
            background: var(--dsp-bg-deep);
            border: 1px solid var(--dsp-line-weak);
            cursor: pointer;
            display: flex;
            align-items: center;
            justify-content: center;
            transition: all 0.2s ease;
            clip-path: polygon(
                0 6px, 6px 0,
                calc(100% - 6px) 0, 100% 6px,
                100% calc(100% - 6px), calc(100% - 6px) 100%,
                6px 100%, 0 calc(100% - 6px)
            );
            box-shadow: 0 4px 14px rgba(0,0,0,0.4), inset 0 0 0 1px rgba(255,255,255,0.03);
            opacity: 0;
            transform: translateX(10px);
            pointer-events: none;
        }
        .dsp-fab-container:hover .dsp-quick-toggle {
            opacity: 1;
            transform: translateX(0);
            pointer-events: auto;
        }
        .dsp-quick-toggle:hover {
            border-color: var(--dsp-line-strong);
            transform: translateY(-1px) !important;
        }
        .dsp-quick-toggle.on {
            border-color: var(--dsp-accent-soft);
            background: linear-gradient(180deg, #162d4a 0%, #132745 100%);
        }
        .dsp-quick-toggle svg {
            width: 18px;
            height: 18px;
        }
        .dsp-quick-toggle .icon-on { display: none; }
        .dsp-quick-toggle .icon-off { display: block; color: var(--dsp-text-dim); }
        .dsp-quick-toggle.on .icon-on { display: block; color: var(--dsp-accent); }
        .dsp-quick-toggle.on .icon-off { display: none; }

        /* FAB 主按钮 */
        .dsp-fab {
            width: 52px;
            height: 52px;
            background: var(--dsp-bg-deep);
            border: 1px solid var(--dsp-line-weak);
            cursor: pointer;
            display: flex;
            align-items: center;
            justify-content: center;
            transition: all 0.2s ease;
            clip-path: polygon(
                0 var(--dsp-notch), var(--dsp-notch) 0,
                calc(100% - var(--dsp-notch)) 0, 100% var(--dsp-notch),
                100% calc(100% - var(--dsp-notch)), calc(100% - var(--dsp-notch)) 100%,
                var(--dsp-notch) 100%, 0 calc(100% - var(--dsp-notch))
            );
            box-shadow: 0 6px 20px rgba(0,0,0,0.45), inset 0 0 0 1px rgba(255,255,255,0.03);
            position: relative;
        }
        .dsp-fab svg {
            width: 28px;
            height: 28px;
            transition: all 0.2s ease;
        }
        .dsp-fab svg path {
            fill: var(--dsp-text-dim);
            transition: fill 0.2s ease;
        }
        .dsp-fab::before {
            content: "";
            position: absolute;
            inset: 0;
            background: linear-gradient(120deg, rgba(255,255,255,0), rgba(255,255,255,0.05), rgba(255,255,255,0));
            background-size: 200% 100%;
            opacity: .08;
            pointer-events: none;
            animation: dsp-sheen 8s linear infinite;
        }
        .dsp-fab:hover {
            border-color: var(--dsp-line-strong);
            transform: translateY(-2px);
            box-shadow: 0 8px 28px rgba(0,0,0,0.5), 0 0 0 1px var(--dsp-accent-faint);
        }
        .dsp-fab:hover svg path {
            fill: var(--dsp-text-main);
        }
        .dsp-fab.active {
            border-color: var(--dsp-accent-soft);
            box-shadow: 0 0 20px var(--dsp-accent-faint), 0 8px 28px rgba(0,0,0,0.5);
        }
        .dsp-fab.active svg path {
            fill: var(--dsp-accent);
        }
        .dsp-fab.inactive {
            opacity: 0.6;
        }

        /* 面板 */
        .dsp-panel {
            position: fixed;
            bottom: 88px;
            right: 24px;
            width: 420px;
            max-width: calc(100vw - 48px);
            background: var(--dsp-bg-deep);
            color: var(--dsp-text-main);
            border: 1px solid var(--dsp-line-weak);
            z-index: 99998;
            overflow: hidden;
            opacity: 0;
            visibility: hidden;
            transform: translateY(12px) scale(0.97);
            transition: all 0.25s cubic-bezier(0.4, 0, 0.2, 1);
            clip-path: polygon(
                0 var(--dsp-notch), var(--dsp-notch) 0,
                calc(100% - var(--dsp-notch)) 0, 100% var(--dsp-notch),
                100% calc(100% - var(--dsp-notch)), calc(100% - var(--dsp-notch)) 100%,
                var(--dsp-notch) 100%, 0 calc(100% - var(--dsp-notch))
            );
            box-shadow: 0 14px 38px rgba(0,0,0,0.55), inset 0 0 0 1px rgba(255,255,255,0.03);
            font-family: 'SF Pro Display', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
        }
        .dsp-panel::before {
            content: "";
            position: absolute;
            inset: 0;
            pointer-events: none;
            box-shadow: inset 0 0 0 1px rgba(42,168,255,0.06);
        }
        .dsp-panel::after {
            content: "";
            position: absolute;
            inset: -1px -1px 60% -1px;
            background: radial-gradient(80% 50% at 25% 0%, rgba(255,255,255,0.04), rgba(255,255,255,0));
            pointer-events: none;
            animation: dsp-card-glow 12s ease-in-out infinite;
        }
        .dsp-panel.open {
            opacity: 1;
            visibility: visible;
            transform: translateY(0) scale(1);
        }

        /* 头部 */
        .dsp-header {
            padding: 14px 16px;
            display: flex;
            align-items: center;
            justify-content: space-between;
            background: linear-gradient(180deg, rgba(255,255,255,0.02), rgba(255,255,255,0));
            border-bottom: 1px solid rgba(255,255,255,0.04);
            position: relative;
        }
        .dsp-header::after {
            content: "";
            position: absolute;
            left: 10px;
            right: 10px;
            bottom: -1px;
            height: 1px;
            background: linear-gradient(90deg, transparent, rgba(42,168,255,0.4), transparent);
            background-size: 200% 100%;
            animation: dsp-aurora-run 7s linear infinite;
            opacity: 0.6;
        }
        .dsp-header-main {
            display: flex;
            flex-direction: column;
        }
        .dsp-title {
            font-size: 13px;
            font-weight: 600;
            letter-spacing: 0.3px;
            display: flex;
            align-items: center;
            gap: 8px;
        }
        .dsp-subtitle {
            font-size: 11px;
            color: var(--dsp-text-dim);
            opacity: 0.85;
            margin-top: 2px;
        }

        /* 开关 */
        .dsp-toggle {
            position: relative;
            width: 44px;
            height: 24px;
            background: var(--dsp-btn-bg);
            border: 1px solid var(--dsp-btn-border);
            border-radius: 12px;
            cursor: pointer;
            transition: all 0.2s;
        }
        .dsp-toggle::after {
            content: '';
            position: absolute;
            top: 3px;
            left: 3px;
            width: 16px;
            height: 16px;
            background: var(--dsp-text-dim);
            border-radius: 50%;
            transition: all 0.2s;
        }
        .dsp-toggle.on {
            background: var(--dsp-btn-active);
            border-color: var(--dsp-accent-soft);
        }
        .dsp-toggle.on::after {
            transform: translateX(20px);
            background: var(--dsp-accent);
            box-shadow: 0 0 8px var(--dsp-accent-soft);
        }
        .dsp-toggle-small {
            width: 36px;
            height: 20px;
        }
        .dsp-toggle-small::after {
            width: 14px;
            height: 14px;
            top: 2px;
            left: 2px;
        }
        .dsp-toggle-small.on::after {
            transform: translateX(16px);
        }

        /* 内容区 */
        .dsp-body {
            padding: 14px 16px;
            max-height: 55vh;
            overflow-y: auto;
        }
        .dsp-section {
            margin-bottom: 14px;
        }
        .dsp-section:last-child {
            margin-bottom: 0;
        }
        .dsp-label {
            font-size: 10.5px;
            color: rgba(42,168,255,0.8);
            letter-spacing: 0.45px;
            margin-bottom: 8px;
            text-transform: uppercase;
            display: flex;
            justify-content: space-between;
            align-items: center;
        }
        .dsp-label .count {
            color: var(--dsp-text-dim);
            text-transform: none;
            letter-spacing: 0;
        }

        /* 预设选择器 */
        .dsp-preset-bar {
            display: flex;
            gap: 8px;
            align-items: center;
        }
        .dsp-preset-select {
            flex: 1;
            background: var(--dsp-btn-bg);
            border: 1px solid var(--dsp-btn-border);
            color: var(--dsp-text-main);
            padding: 8px 12px;
            font-size: 12px;
            cursor: pointer;
            outline: none;
            clip-path: polygon(
                0 6px, 6px 0,
                calc(100% - 6px) 0, 100% 6px,
                100% calc(100% - 6px), calc(100% - 6px) 100%,
                6px 100%, 0 calc(100% - 6px)
            );
            transition: border-color 0.2s;
        }
        .dsp-preset-select:hover, .dsp-preset-select:focus {
            border-color: var(--dsp-line-strong);
        }
        .dsp-preset-select option {
            background: #0e1a2d;
            color: var(--dsp-text-main);
        }
        .dsp-preset-btn {
            width: 32px;
            height: 32px;
            background: var(--dsp-btn-bg);
            border: 1px solid var(--dsp-btn-border);
            color: var(--dsp-text-dim);
            cursor: pointer;
            display: flex;
            align-items: center;
            justify-content: center;
            transition: all 0.15s;
            clip-path: polygon(
                0 4px, 4px 0,
                calc(100% - 4px) 0, 100% 4px,
                100% calc(100% - 4px), calc(100% - 4px) 100%,
                4px 100%, 0 calc(100% - 4px)
            );
        }
        .dsp-preset-btn:hover {
            background: var(--dsp-btn-hover);
            color: var(--dsp-text-main);
            border-color: var(--dsp-line-strong);
        }
        .dsp-preset-btn.danger:hover {
            background: rgba(239, 68, 68, 0.15);
            border-color: rgba(239, 68, 68, 0.5);
            color: var(--dsp-danger);
        }
        .dsp-preset-btn svg {
            width: 14px;
            height: 14px;
        }

        /* 文本框 */
        .dsp-textarea {
            width: 100%;
            background: var(--dsp-btn-bg);
            border: 1px solid var(--dsp-btn-border);
            padding: 12px;
            color: var(--dsp-text-main);
            font-size: 13px;
            font-family: 'Monaco', 'Consolas', 'SF Mono', monospace;
            resize: vertical;
            outline: none;
            transition: border-color 0.2s, box-shadow 0.2s;
            box-sizing: border-box;
            clip-path: polygon(
                0 var(--dsp-notch), var(--dsp-notch) 0,
                calc(100% - var(--dsp-notch)) 0, 100% var(--dsp-notch),
                100% calc(100% - var(--dsp-notch)), calc(100% - var(--dsp-notch)) 100%,
                var(--dsp-notch) 100%, 0 calc(100% - var(--dsp-notch))
            );
            box-shadow: 0 4px 12px rgba(0,0,0,0.2), inset 0 0 0 1px rgba(255,255,255,0.02);
        }
        .dsp-textarea:focus {
            border-color: var(--dsp-accent-soft);
            box-shadow: 0 0 0 1px var(--dsp-accent-faint), 0 4px 12px rgba(0,0,0,0.2);
        }
        .dsp-textarea::placeholder {
            color: var(--dsp-text-dim);
            opacity: 0.6;
        }
        .dsp-textarea.prompt {
            min-height: 60px;
            height: 100px;
        }
        .dsp-textarea.template {
            min-height: 50px;
            height: 70px;
            font-size: 12px;
        }

        /* 格式切换按钮组 */
        .dsp-format-group {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 8px;
        }
        .dsp-format-btn {
            position: relative;
            padding: 10px 12px;
            font-size: 12px;
            font-weight: 500;
            cursor: pointer;
            background: var(--dsp-btn-bg);
            color: var(--dsp-text-main);
            border: 1px solid var(--dsp-btn-border);
            transition: all 0.15s ease;
            text-align: center;
            clip-path: polygon(
                0 var(--dsp-notch), var(--dsp-notch) 0,
                calc(100% - var(--dsp-notch)) 0, 100% var(--dsp-notch),
                100% calc(100% - var(--dsp-notch)), calc(100% - var(--dsp-notch)) 100%,
                var(--dsp-notch) 100%, 0 calc(100% - var(--dsp-notch))
            );
            box-shadow: 0 4px 12px rgba(0,0,0,0.2), inset 0 0 0 1px rgba(255,255,255,0.02);
        }
        .dsp-format-btn::before {
            content: "";
            position: absolute;
            inset: 0;
            background: linear-gradient(120deg, rgba(255,255,255,0), rgba(255,255,255,0.05), rgba(255,255,255,0));
            background-size: 200% 100%;
            opacity: .06;
            pointer-events: none;
            animation: dsp-sheen 9s linear infinite;
        }
        .dsp-format-btn:hover {
            background: var(--dsp-btn-hover);
            border-color: var(--dsp-line-strong);
            transform: translateY(-1px);
        }
        .dsp-format-btn.active {
            background: linear-gradient(180deg, #162d4a 0%, #132745 100%);
            border-color: var(--dsp-btn-border-active);
        }
        .dsp-format-btn.active::after {
            content: "";
            position: absolute;
            right: 10px;
            top: 50%;
            width: 8px;
            height: 8px;
            transform: translateY(-50%);
            border-radius: 2px;
            background: var(--dsp-accent);
            box-shadow: 0 0 0 2px rgba(42,168,255,0.16), 0 0 8px rgba(42,168,255,0.22);
        }

        /* 变量提示 */
        .dsp-variables-hint {
            background: rgba(9, 14, 22, 0.6);
            border: 1px solid var(--dsp-line-weak);
            padding: 10px 12px;
            font-size: 11px;
            color: var(--dsp-text-dim);
            margin-top: 8px;
            clip-path: polygon(
                0 4px, 4px 0,
                calc(100% - 4px) 0, 100% 4px,
                100% calc(100% - 4px), calc(100% - 4px) 100%,
                4px 100%, 0 calc(100% - 4px)
            );
        }
        .dsp-variables-hint code {
            background: var(--dsp-btn-bg);
            padding: 2px 5px;
            border-radius: 3px;
            color: var(--dsp-accent);
            font-family: 'Monaco', 'Consolas', monospace;
            margin-right: 4px;
        }
        .dsp-variables-toggle {
            cursor: pointer;
            color: var(--dsp-accent);
            font-size: 10px;
            text-transform: uppercase;
            letter-spacing: 0.3px;
        }
        .dsp-variables-toggle:hover {
            text-decoration: underline;
        }
        .dsp-variables-list {
            display: none;
            margin-top: 8px;
            line-height: 1.8;
        }
        .dsp-variables-list.show {
            display: block;
        }

        /* 预览区 */
        .dsp-preview {
            background: rgba(9,14,22,0.8);
            border: 1px solid var(--dsp-line-weak);
            padding: 10px 12px;
            font-size: 11px;
            color: var(--dsp-text-dim);
            font-family: 'Monaco', 'Consolas', 'SF Mono', monospace;
            line-height: 1.5;
            max-height: 80px;
            overflow-y: auto;
            word-break: break-all;
            clip-path: polygon(
                0 6px, 6px 0,
                calc(100% - 6px) 0, 100% 6px,
                100% calc(100% - 6px), calc(100% - 6px) 100%,
                6px 100%, 0 calc(100% - 6px)
            );
        }
        .dsp-preview .token {
            color: #f472b6;
            font-weight: 500;
        }
        .dsp-preview-title {
            font-size: 10px;
            color: rgba(42,168,255,0.7);
            letter-spacing: 0.4px;
            text-transform: uppercase;
            margin-bottom: 6px;
        }

        /* 提示文字 */
        .dsp-hint {
            font-size: 10px;
            color: var(--dsp-text-dim);
            margin-top: 6px;
            opacity: 0.7;
        }
        .dsp-hint code {
            background: var(--dsp-btn-bg);
            padding: 2px 5px;
            border-radius: 3px;
            color: var(--dsp-accent);
            font-family: 'Monaco', 'Consolas', monospace;
        }

        /* 底部按钮区 */
        .dsp-footer {
            padding: 12px 16px;
            display: flex;
            flex-direction: column;
            gap: 10px;
            background: linear-gradient(180deg, rgba(12,22,40,0.72), rgba(9,16,30,0.86));
            border-top: 1px solid var(--dsp-line-weak);
            position: relative;
        }
        .dsp-footer::before {
            content: "";
            position: absolute;
            left: 10px;
            right: 10px;
            top: -1px;
            height: 1px;
            background: linear-gradient(90deg, transparent, rgba(42,168,255,0.45), transparent);
            background-size: 200% 100%;
            animation: dsp-aurora-run 7.8s linear infinite;
            opacity: .5;
        }
        .dsp-footer-row {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 10px;
        }
        .dsp-footer-row.three {
            grid-template-columns: 1fr 1fr 1fr;
        }

        .dsp-btn {
            position: relative;
            padding: 10px 16px;
            font-size: 12.5px;
            font-weight: 600;
            letter-spacing: 0.2px;
            cursor: pointer;
            border: 1px solid var(--dsp-btn-border);
            transition: all 0.15s ease;
            clip-path: polygon(
                0 var(--dsp-notch), var(--dsp-notch) 0,
                calc(100% - var(--dsp-notch)) 0, 100% var(--dsp-notch),
                100% calc(100% - var(--dsp-notch)), calc(100% - var(--dsp-notch)) 100%,
                var(--dsp-notch) 100%, 0 calc(100% - var(--dsp-notch))
            );
            box-shadow: 0 6px 16px rgba(0,0,0,0.28), inset 0 0 0 1px rgba(255,255,255,0.03);
        }
        .dsp-btn-secondary {
            background: var(--dsp-btn-bg);
            color: var(--dsp-text-dim);
        }
        .dsp-btn-secondary:hover {
            background: var(--dsp-btn-hover);
            color: var(--dsp-text-main);
            transform: translateY(-1px);
        }
        .dsp-btn-primary {
            background: linear-gradient(180deg, #10233c, #0d1e34);
            color: var(--dsp-text-main);
            border-color: var(--dsp-accent-soft);
        }
        .dsp-btn-primary:hover {
            background: linear-gradient(180deg, #132a44, #10233c);
            transform: translateY(-1px);
            box-shadow: 0 8px 22px rgba(0,0,0,0.35), 0 0 0 1px rgba(42,168,255,0.08) inset;
        }
        .dsp-btn-primary:active {
            transform: translateY(0);
            background: linear-gradient(180deg, #0f2036, #0c1b2f);
        }
        .dsp-btn-small {
            padding: 8px 12px;
            font-size: 11px;
        }

        /* 隐藏的文件输入 */
        .dsp-file-input {
            display: none;
        }

        /* 减少动效（无障碍） */
        @media (prefers-reduced-motion: reduce) {
            *, *::before, *::after {
                animation-duration: 0.01ms !important;
                animation-iteration-count: 1 !important;
                transition-duration: 0.01ms !important;
            }
        }


        /* 移动端竖屏适配：上移FAB避免遮挡发送按钮 */
        @media (max-width: 768px) {
            .dsp-fab-container {
                bottom: 90px !important;
                right: 16px !important;
                gap: 6px !important;
            }
            .dsp-fab-container .dsp-fab {
                width: 44px !important;
                height: 44px !important;
                --dsp-notch: 8px;
            }
            .dsp-fab-container .dsp-fab svg {
                width: 24px !important;
                height: 24px !important;
            }
            .dsp-fab-container .dsp-quick-toggle {
                width: 30px !important;
                height: 30px !important;
            }
            .dsp-fab-container .dsp-quick-toggle svg {
                width: 15px !important;
                height: 15px !important;
            }
            .dsp-panel {
                bottom: 150px !important;
                right: 12px !important;
                width: calc(100vw - 24px) !important;
                max-width: 400px !important;
            }
            .dsp-toast {
                bottom: 160px !important;
                right: 12px !important;
            }
        }

        /* 账号切换面板 */
        .dsp-account-panel {
            /* 与主面板样式相同，额外微调 */
        }
        .dsp-account-item {
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 10px 12px;
            background: var(--dsp-btn-bg);
            border: 1px solid var(--dsp-btn-border);
            clip-path: polygon(
                0 4px, 4px 0,
                calc(100% - 4px) 0, 100% 4px,
                100% calc(100% - 4px), calc(100% - 4px) 100%,
                4px 100%, 0 calc(100% - 4px)
            );
            transition: all 0.15s ease;
        }
        .dsp-account-item.current {
            border-color: var(--dsp-accent-soft);
            background: linear-gradient(180deg, #162d4a 0%, #132745 100%);
            box-shadow: 0 0 12px rgba(42,168,255,0.08);
        }
        .dsp-account-item:hover {
            border-color: var(--dsp-line-strong);
        }
        .dsp-account-info {
            flex: 1;
            min-width: 0;
        }
        .dsp-account-name {
            font-size: 13px;
            font-weight: 500;
            color: var(--dsp-text-main);
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
        }
        .dsp-account-token {
            font-size: 10px;
            color: var(--dsp-text-dim);
            margin-top: 2px;
            font-family: 'Monaco', 'Consolas', monospace;
        }
        .dsp-account-actions {
            display: flex;
            gap: 4px;
            flex-shrink: 0;
            margin-left: 8px;
        }
        .dsp-account-actions .dsp-preset-btn {
            width: 28px;
            height: 28px;
        }
        .dsp-account-actions .dsp-preset-btn svg {
            width: 12px;
            height: 12px;
        }

    `);

    // ═══════════════════════════════════════
    // UI 组件
    // ═══════════════════════════════════════
    const DEEPSEEK_ICON = `<svg viewBox="0 0 34 26" xmlns="http://www.w3.org/2000/svg"><path d="M33.615 2.598c-.36-.176-.515.16-.726.33-.072.055-.132.127-.193.193-.526.562-1.14.93-1.943.887-1.174-.067-2.176.302-3.062 1.2-.188-1.107-.814-1.767-1.766-2.191-.498-.22-1.002-.441-1.35-.92-.244-.341-.31-.721-.433-1.096-.077-.226-.154-.457-.415-.496-.282-.044-.393.193-.504.391-.443.81-.614 1.702-.598 2.605.04 2.033.898 3.652 2.603 4.803.193.132.243.264.182.457-.116.397-.254.782-.376 1.179-.078.253-.194.308-.465.198-.936-.391-1.744-.97-2.458-1.669-1.213-1.173-2.31-2.467-3.676-3.48a16.254 16.254 0 0 0-.975-.668c-1.395-1.354.183-2.467.548-2.599.382-.138.133-.612-1.102-.606-1.234.005-2.364.42-3.803.97a4.34 4.34 0 0 1-.66.193 13.577 13.577 0 0 0-4.08-.143c-2.667.297-4.799 1.558-6.365 3.712C.116 8.436-.327 11.378.215 14.444c.57 3.233 2.22 5.91 4.755 8.002 2.63 2.17 5.658 3.233 9.113 3.03 2.098-.122 4.434-.403 7.07-2.633.664.33 1.362.463 2.518.562.892.083 1.75-.044 2.414-.182 1.04-.22.97-1.184.593-1.36-3.05-1.421-2.38-.843-2.99-1.311 1.55-1.834 3.918-5.093 4.648-9.531.072-.49.164-1.18.153-1.577-.006-.242.05-.336.326-.364a5.903 5.903 0 0 0 2.187-.672c1.977-1.08 2.774-2.853 2.962-4.978.028-.325-.006-.661-.35-.832ZM16.39 21.73c-2.956-2.324-4.39-3.089-4.982-3.056-.554.033-.454.667-.332 1.08.127.407.293.688.526 1.046.16.237.271.59-.161.854-.952.589-2.607-.198-2.685-.237-1.927-1.134-3.537-2.632-4.673-4.68-1.096-1.972-1.733-4.087-1.838-6.345-.028-.545.133-.738.676-.837A6.643 6.643 0 0 1 5.086 9.5c3.017.441 5.586 1.79 7.74 3.927 1.229 1.217 2.159 2.671 3.116 4.092 1.02 1.509 2.115 2.946 3.51 4.125.494.413.887.727 1.263.958-1.135.127-3.028.154-4.324-.87v-.002Zm1.417-9.114a.434.434 0 0 1 .587-.408c.06.022.117.055.16.105a.426.426 0 0 1 .122.303.434.434 0 0 1-.437.435.43.43 0 0 1-.432-.435Zm4.402 2.257c-.283.116-.565.215-.836.226-.421.022-.88-.149-1.13-.358-.387-.325-.664-.506-.78-1.073-.05-.242-.022-.617.022-.832.1-.463-.011-.76-.338-1.03-.265-.22-.603-.28-.974-.28a.8.8 0 0 1-.36-.11c-.155-.078-.283-.27-.161-.508.039-.077.227-.264.271-.297.504-.286 1.085-.193 1.623.022.498.204.875.578 1.417 1.107.553.639.653.815.968 1.295.25.374.476.76.632 1.2.094.275-.028.5-.354.638Z"></path></svg>`;

    const ICON_ADD = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>`;
    const ICON_DELETE = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="m19 6-.867 12.142A2 2 0 0 1 16.138 20H7.862a2 2 0 0 1-1.995-1.858L5 6m5 0V4a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v2"/></svg>`;
    const ICON_RENAME = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>`;

    // ═══════════════════════════════════════
    // 多账号切换 - 图标
    // ═══════════════════════════════════════
    const ICON_ACCOUNT = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>`;
    const ICON_SWITCH = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="16 3 21 3 21 8"/><line x1="4" y1="11" x2="21" y2="11"/><polyline points="8 21 3 21 3 16"/><line x1="20" y1="13" x2="3" y2="13"/></svg>`;

    // ═══════════════════════════════════════
    // 多账号切换 - 核心逻辑
    // ═══════════════════════════════════════
    function saveAccounts() {
        GM_setValue(ACCOUNTS_KEY, accounts);
        GM_setValue(CURRENT_ACCOUNT_KEY, currentAccountId);
    }

    function getCurrentToken() {
        try {
            const raw = localStorage.getItem('userToken');
            if (!raw) return null;
            try { return JSON.parse(raw).value || raw; } catch(e) { return raw; }
        } catch(e) {
            return null;
        }
    }

    function getCurrentAccountName() {
        const token = getCurrentToken();
        if (!token) return '未登录';
        const account = accounts.find(a => a.token === token);
        if (account) return account.name;
        if (currentAccountId) {
            const acc = accounts.find(a => a.id === currentAccountId);
            if (acc) return acc.name + ' (已变化)';
        }
        return '未命名账号';
    }

    function addAccount(name, email, password) {
        // 检查邮箱是否已存在
        const existing = email ? accounts.find(a => a.email === email) : null;
        if (existing) {
            alert('该邮箱已存在：' + existing.name);
            return existing;
        }
        const id = 'acc_' + Date.now();
        const token = getCurrentToken() || '';
        const newAccount = { id, name: name.trim(), email: email || '', password: password || '', token, addedAt: Date.now() };
        accounts.push(newAccount);
        currentAccountId = id;
        saveAccounts();
        log("Added account:", name);
        return newAccount;
    }

    function loginWithEmail(email, password) {
        // 获取或生成 device_id
        let deviceId = '';
        try { deviceId = localStorage.getItem('device_id') || ''; } catch(e) {}
        if (!deviceId) {
            const arr = new Uint8Array(48);
            crypto.getRandomValues(arr);
            deviceId = btoa(String.fromCharCode(...arr));
        }

        return new Promise((resolve, reject) => {
            log("Login request:", { email, deviceId: deviceId.substring(0, 20) + '...' });
            GM_xmlhttpRequest({
                method: 'POST',
                url: 'https://chat.deepseek.com/api/v0/users/login',
                anonymous: false,
                headers: {
                    'Content-Type': 'application/json',
                    'x-client-platform': 'web',
                    'x-client-version': '2.0.0',
                    'x-client-locale': 'zh_CN',
                    'x-app-version': '2.0.0',
                    'Origin': 'https://chat.deepseek.com',
                    'Referer': 'https://chat.deepseek.com/sign_in'
                },
                data: JSON.stringify({
                    email: email,
                    mobile: '',
                    password: password,
                    area_code: '',
                    device_id: deviceId,
                    os: 'web'
                }),
                onload: function(resp) {
                    log("Login response:", resp.status, resp.responseText.substring(0, 300));
                    try {
                        const data = JSON.parse(resp.responseText);
                        const token = data?.data?.biz_data?.user?.token || data?.data?.user?.token || data?.data?.token || data?.token;
                        if (token) {
                            log("Login success, token:", token.substring(0, 20) + '...');
                            resolve(token);
                        } else {
                            reject(new Error(data?.message || data?.msg || data?.error || '未获取到token'));
                        }
                    } catch(e) {
                        reject(new Error('解析登录响应失败：' + resp.responseText.substring(0, 200)));
                    }
                },
                onerror: function(e) {
                    log("Login error:", e);
                    reject(new Error('登录请求失败，状态码：' + (e?.status || '未知')));
                },
                ontimeout: function() {
                    reject(new Error('登录请求超时'));
                },
                timeout: 15000
            });
        });
    }

    function switchAccount(accountId) {
        const account = accounts.find(a => a.id === accountId);
        if (!account) return false;
        try {
            // 如果有邮箱密码，走登录API获取新token（永不过期）
            if (account.email && account.password) {
                loginWithEmail(account.email, account.password).then(newToken => {
                    localStorage.setItem('userToken', JSON.stringify({value: newToken, __version: "0"}));
                    account.token = newToken;
                    currentAccountId = accountId;
                    saveAccounts();
                    log("Switched to account (via login):", account.name);
                    location.reload();
                }).catch(err => {
                    alert('登录失败：' + err.message + '\n\n请检查邮箱密码是否正确，或该账号可能尚未注册邮箱登录方式。');
                });
                return true;
            }
            // 旧方式：直接用保存的token
            const wrapped = account.token.startsWith('{') ? account.token : JSON.stringify({value: account.token, __version: "0"});
            localStorage.setItem('userToken', wrapped);
            currentAccountId = accountId;
            saveAccounts();
            log("Switched to account (via token):", account.name);
            return true;
        } catch(e) {
            log("Switch account error:", e);
            return false;
        }
    }

    function deleteAccount(accountId) {
        const index = accounts.findIndex(a => a.id === accountId);
        if (index > -1) {
            accounts.splice(index, 1);
            if (currentAccountId === accountId) {
                currentAccountId = accounts.length > 0 ? accounts[0].id : null;
            }
            saveAccounts();
            return true;
        }
        return false;
    }

    function renameAccount(accountId, newName) {
        const account = accounts.find(a => a.id === accountId);
        if (account) {
            account.name = newName.trim();
            saveAccounts();
            return true;
        }
        return false;
    }

    function renderAccountListHTML() {
        const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        if (accounts.length === 0) {
            return '<div class="dsp-hint" style="text-align:center;padding:12px;">暂无保存的账号<br>点击下方按钮保存当前账号</div>';
        }
        return accounts.map(a => {
            const isCurrent = a.id === currentAccountId;
            const infoText = a.email ? a.email : (a.token ? a.token.substring(0, 12) + '...' : '(空)');
            const timeStr = a.addedAt ? new Date(a.addedAt).toLocaleDateString() : '';
            return `
                <div class="dsp-account-item ${isCurrent ? 'current' : ''}" data-account-id="${a.id}">
                    <div class="dsp-account-info">
                        <div class="dsp-account-name">${esc(a.name)}</div>
                        <div class="dsp-account-token">${esc(infoText)} · ${timeStr}</div>
                    </div>
                    <div class="dsp-account-actions">
                        <button class="dsp-preset-btn dsp-account-switch" data-id="${a.id}" title="切换到此账号">${ICON_SWITCH}</button>
                        <button class="dsp-preset-btn dsp-account-rename-btn" data-id="${a.id}" title="重命名">${ICON_RENAME}</button>
                        <button class="dsp-preset-btn danger dsp-account-delete-btn" data-id="${a.id}" title="删除">${ICON_DELETE}</button>
                    </div>
                </div>
            `;
        }).join('');
    }


    function createUI() {
        if (document.querySelector('.dsp-fab-container')) return;

        const fabContainer = document.createElement('div');
        fabContainer.className = 'dsp-fab-container';

        const quickToggle = document.createElement('button');
        // 快捷开关状态：只要有任一功能启用就显示为开
        const anyEnabled = isEnabled || prefixEnabled;
        quickToggle.className = `dsp-quick-toggle ${anyEnabled ? 'on' : ''}`;
        quickToggle.title = anyEnabled ? '点击关闭所有注入' : '点击开启所有注入';
        quickToggle.innerHTML = `
            <span class="icon-on"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg></span>
            <span class="icon-off"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></span>
        `;

        const fab = document.createElement('button');
        // FAB 状态：有内容且启用任一功能时激活
        const hasContent = systemPrompt || (messagePrefix && prefixEnabled);
        fab.className = `dsp-fab ${(isEnabled || prefixEnabled) && hasContent ? 'active' : 'inactive'}`;
        fab.innerHTML = DEEPSEEK_ICON;
        fab.title = 'System Prompt Injector';

        fabContainer.appendChild(quickToggle);
        fabContainer.appendChild(fab);

        // 账号切换 FAB
        const accountFab = document.createElement('button');
        accountFab.className = 'dsp-fab dsp-account-fab';
        accountFab.innerHTML = ICON_ACCOUNT;
        accountFab.title = '多账号切换';
        fabContainer.appendChild(accountFab);


        const panel = document.createElement('div');
        panel.className = 'dsp-panel';
        panel.innerHTML = `
            <div class="dsp-header">
                <div class="dsp-header-main">
                    <div class="dsp-title">🎭 System Prompt</div>
                    <div class="dsp-subtitle">DeepSeek · Injector v3.8.0</div>
                </div>
                <div class="dsp-toggle ${isEnabled ? 'on' : ''}" id="dsp-toggle"></div>
            </div>
            <div class="dsp-body">
                <div class="dsp-section">
                    <div class="dsp-label">📚 预设</div>
                    <div class="dsp-preset-bar">
                        <select class="dsp-preset-select" id="dsp-preset-select">
                            ${presets.map(p => `<option value="${p.id}" ${p.id === currentPresetId ? 'selected' : ''}>${p.name}</option>`).join('')}
                        </select>
                        <button class="dsp-preset-btn" id="dsp-preset-add" title="新建空预设">${ICON_ADD}</button>
                        <button class="dsp-preset-btn" id="dsp-preset-rename" title="重命名">${ICON_RENAME}</button>
                        <button class="dsp-preset-btn danger" id="dsp-preset-delete" title="删除预设">${ICON_DELETE}</button>
                    </div>
                    <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-top:6px;">
                        <button class="dsp-btn dsp-btn-secondary dsp-btn-small" id="dsp-export">📤 导出</button>
                        <button class="dsp-btn dsp-btn-secondary dsp-btn-small" id="dsp-import">📥 导入</button>
                    </div>
                </div>

                <div class="dsp-section">
                    <div class="dsp-label">
                        <span>系统提示词</span>
                        <span class="count" id="dsp-count">${systemPrompt.length} 字符</span>
                    </div>
                    <textarea class="dsp-textarea prompt" id="dsp-input" placeholder="输入你的系统提示词...">${systemPrompt}</textarea>
                    <div class="dsp-variables-hint">
                        <span class="dsp-variables-toggle" id="dsp-vars-toggle">🧩 可用变量 ▼</span>
                        <div class="dsp-variables-list" id="dsp-vars-list">
                            <code>{date}</code> 日期 ·
                            <code>{time}</code> 时间 ·
                            <code>{datetime}</code> 日期时间<br>
                            <code>{year}</code> 年 ·
                            <code>{month}</code> 月 ·
                            <code>{day}</code> 日<br>
                            <code>{hour}</code> 时 ·
                            <code>{minute}</code> 分 ·
                            <code>{weekday}</code> 星期<br>
                            <code>{timestamp}</code> 时间戳 ·
                            <code>{random}</code> 随机字符串
                        </div>
                    </div>
                </div>

                <div class="dsp-section">
                    <div class="dsp-label">注入格式</div>
                    <div class="dsp-format-group">
                        <button class="dsp-format-btn ${useNativeFormat ? 'active' : ''}" id="dsp-fmt-native">
                            🔮 原生 Token
                        </button>
                        <button class="dsp-format-btn ${!useNativeFormat ? 'active' : ''}" id="dsp-fmt-custom">
                            ✏️ 自定义模板
                        </button>
                    </div>
                </div>

                <div class="dsp-section" id="dsp-template-section" style="display: ${useNativeFormat ? 'none' : 'block'}">
                    <div class="dsp-label">自定义模板</div>
                    <textarea class="dsp-textarea template" id="dsp-template" placeholder="{system}&#10;---&#10;{user}">${customTemplate}</textarea>
                    <div class="dsp-hint">
                        占位符: <code>{system}</code> 系统提示词 · <code>{user}</code> 用户消息
                    </div>
                </div>

                <div class="dsp-section">
                    <div class="dsp-label">
                        <span>📝 消息前缀</span>
                        <div class="dsp-toggle dsp-toggle-small ${prefixEnabled ? 'on' : ''}" id="dsp-prefix-toggle"></div>
                    </div>
                    <textarea class="dsp-textarea template" id="dsp-prefix-input" placeholder="当前日期是 {date}，时间是 {time}。">${messagePrefix}</textarea>
                    <div class="dsp-hint">
                        每条用户消息前自动添加此内容，支持变量替换
                    </div>
                </div>

                <div class="dsp-section">
                    <div class="dsp-preview">
                        <div class="dsp-preview-title">预览</div>
                        <div id="dsp-preview-content"></div>
                    </div>
                </div>

                <div class="dsp-section">
                    <div class="dsp-label">
                        <span>🐛 调试模式</span>
                        <div class="dsp-toggle dsp-toggle-small ${debugModeEnabled ? 'on' : ''}" id="dsp-debug-toggle"></div>
                    </div>
                    <div class="dsp-hint">
                        开启后显示消息 ID 和 token 数（需刷新页面）
                    </div>
                </div>
            </div>
            <div class="dsp-footer">
                <div class="dsp-footer-row">
                    <button class="dsp-btn dsp-btn-secondary" id="dsp-cancel">取消</button>
                    <button class="dsp-btn dsp-btn-primary" id="dsp-save">保存设置</button>
                </div>
            </div>
            <input type="file" class="dsp-file-input" id="dsp-file-input" accept=".json">
        `;

        document.body.appendChild(fabContainer);
        document.body.appendChild(panel);

        // ═══════════════════════════════════════
        // 账号面板
        // ═══════════════════════════════════════
        const accountPanel = document.createElement('div');
        accountPanel.className = 'dsp-panel dsp-account-panel';
        function refreshAccountPanel() {
            const listEl = accountPanel.querySelector('#dsp-account-list');
            const nameEl = accountPanel.querySelector('#dsp-current-account-name');
            if (listEl) listEl.innerHTML = renderAccountListHTML();
            if (nameEl) nameEl.textContent = '当前：' + getCurrentAccountName();
            // 重新绑定事件
            bindAccountPanelEvents();
        }
        function bindAccountPanelEvents() {
            accountPanel.querySelectorAll('.dsp-account-switch').forEach(btn => {
                btn.onclick = () => {
                    const id = btn.dataset.id;
                    if (switchAccount(id)) {
                        // 邮箱登录方式内部已刷新；旧token方式需手动刷新
                        const acc = accounts.find(a => a.id === id);
                        if (!acc?.email) {
                            location.reload();
                        }
                    }
                };
            });
            accountPanel.querySelectorAll('.dsp-account-rename-btn').forEach(btn => {
                btn.onclick = () => {
                    const id = btn.dataset.id;
                    const item = btn.closest('.dsp-account-item');
                    const nameEl = item.querySelector('.dsp-account-name');
                    const oldName = nameEl.textContent;
                    const input = document.createElement('input');
                    input.value = oldName;
                    input.className = 'dsp-textarea template';
                    input.style.cssText = 'height:28px;font-size:13px;padding:4px 8px;width:100%;';
                    nameEl.replaceWith(input);
                    input.focus();
                    input.select();
                    const done = () => {
                        const v = input.value.trim();
                        if (v && v !== oldName) { renameAccount(id, v); refreshAccountPanel(); }
                        else { input.replaceWith(nameEl); }
                    };
                    input.addEventListener('blur', done);
                    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { input.blur(); } if (e.key === 'Escape') { input.value = oldName; input.blur(); } });
                };
            });
            accountPanel.querySelectorAll('.dsp-account-delete-btn').forEach(btn => {
                btn.onclick = () => {
                    const id = btn.dataset.id;
                    const account = accounts.find(a => a.id === id);
                    if (confirm('确定删除账号 "' + (account?.name || '') + '"？')) {
                        deleteAccount(id);
                        refreshAccountPanel();
                    }
                };
            });
        }
        accountPanel.innerHTML = `
            <div class="dsp-header">
                <div class="dsp-header-main">
                    <div class="dsp-title">👤 账号切换</div>
                    <div class="dsp-subtitle" id="dsp-current-account-name">当前：${getCurrentAccountName()}</div>
                </div>
            </div>
            <div class="dsp-body">
                <div class="dsp-section">
                    <div class="dsp-label">
                        <span>已保存的账号</span>
                        <span class="count">${accounts.length} 个</span>
                    </div>
                    <div id="dsp-account-list" style="display:flex;flex-direction:column;gap:8px;">
                        ${renderAccountListHTML()}
                    </div>
                    <div style="margin-top:10px;">
                        <div class="dsp-account-form" id="dsp-account-form" style="display:none;">
                            <input class="dsp-textarea template" id="dsp-acc-name" placeholder="账号名称" style="height:32px;margin-bottom:6px;" value="${getCurrentAccountName()}">
                            <input class="dsp-textarea template" id="dsp-acc-email" placeholder="邮箱地址" style="height:32px;margin-bottom:6px;">
                            <input class="dsp-textarea template" id="dsp-acc-password" type="password" placeholder="密码" style="height:32px;margin-bottom:6px;">
                            <div style="display:flex;gap:6px;">
                                <button class="dsp-btn dsp-btn-primary dsp-btn-small" id="dsp-acc-save">💾 保存</button>
                                <button class="dsp-btn dsp-btn-secondary dsp-btn-small" id="dsp-acc-cancel">取消</button>
                            </div>
                        </div>

                        <button class="dsp-btn dsp-btn-secondary dsp-btn-small" id="dsp-account-add">➕ 添加账号</button>
                    </div>
                </div>
            </div>
            <div class="dsp-footer">
                <button class="dsp-btn dsp-btn-secondary" id="dsp-account-close">关闭</button>
            </div>
        `;
        document.body.appendChild(accountPanel);

        // 账号面板事件
        accountFab.addEventListener('click', (e) => {
            e.stopPropagation();
            if (panel.classList.contains('open')) {
                panel.classList.remove('open');
            }
            accountPanel.classList.toggle('open');
            if (accountPanel.classList.contains('open')) {
                refreshAccountPanel();
            }
        });

        accountPanel.querySelector('#dsp-account-close').addEventListener('click', () => {
            accountPanel.classList.remove('open');
        });

        accountPanel.querySelector('#dsp-account-add').addEventListener('click', () => {
            const form = accountPanel.querySelector('#dsp-account-form');
            const btn = accountPanel.querySelector('#dsp-account-add');
            if (form.style.display === 'none') {
                form.style.display = 'block';
                btn.textContent = '✖ 取消添加';
                accountPanel.querySelector('#dsp-acc-name').value = getCurrentAccountName();
                accountPanel.querySelector('#dsp-acc-email').value = '';
                accountPanel.querySelector('#dsp-acc-password').value = '';
            } else {
                form.style.display = 'none';
                btn.textContent = '➕ 添加账号';
            }
        });

        accountPanel.querySelector('#dsp-acc-save').addEventListener('click', () => {
            const name = accountPanel.querySelector('#dsp-acc-name').value.trim();
            const email = accountPanel.querySelector('#dsp-acc-email').value.trim();
            const password = accountPanel.querySelector('#dsp-acc-password').value;
            if (!name || !email || !password) { alert('请填写完整信息'); return; }
            addAccount(name, email, password);
            accountPanel.querySelector('#dsp-account-form').style.display = 'none';
            accountPanel.querySelector('#dsp-account-add').textContent = '➕ 添加账号';
            refreshAccountPanel();
        });

        accountPanel.querySelector('#dsp-acc-cancel').addEventListener('click', () => {
            accountPanel.querySelector('#dsp-account-form').style.display = 'none';
            accountPanel.querySelector('#dsp-account-add').textContent = '➕ 添加账号';
        });

        bindAccountPanelEvents();


        // 元素引用
        const toggle = panel.querySelector('#dsp-toggle');
        const input = panel.querySelector('#dsp-input');
        const count = panel.querySelector('#dsp-count');
        const templateInput = panel.querySelector('#dsp-template');
        const templateSection = panel.querySelector('#dsp-template-section');
        const fmtNative = panel.querySelector('#dsp-fmt-native');
        const fmtCustom = panel.querySelector('#dsp-fmt-custom');
        const previewContent = panel.querySelector('#dsp-preview-content');
        const saveBtn = panel.querySelector('#dsp-save');
        const cancelBtn = panel.querySelector('#dsp-cancel');
        const exportBtn = panel.querySelector('#dsp-export');
        const importBtn = panel.querySelector('#dsp-import');
        const fileInput = panel.querySelector('#dsp-file-input');
        const presetSelect = panel.querySelector('#dsp-preset-select');
        const presetAdd = panel.querySelector('#dsp-preset-add');
        const presetRename = panel.querySelector('#dsp-preset-rename');
        const presetDelete = panel.querySelector('#dsp-preset-delete');
        const varsToggle = panel.querySelector('#dsp-vars-toggle');
        const varsList = panel.querySelector('#dsp-vars-list');
        const prefixInput = panel.querySelector('#dsp-prefix-input');
        const prefixToggle = panel.querySelector('#dsp-prefix-toggle');
        const debugToggle = panel.querySelector('#dsp-debug-toggle');

        function updatePreview() {
            const sysPrompt = input.value.trim() || '(系统提示词)';
            const userMsg = '(用户消息)';
            let preview;

            // 预览时替换变量
            const processedPrompt = replaceVariables(truncate(sysPrompt, 40));

            if (useNativeFormat) {
                preview = `<span class="token">${escapeHtml(DS_TOKENS.SYSTEM)}</span>${escapeHtml(processedPrompt)}<span class="token">${escapeHtml(DS_TOKENS.USER)}</span>${userMsg}`;
            } else {
                const tpl = templateInput.value || DEFAULT_TEMPLATE;
                const processedTpl = replaceVariables(tpl);
                preview = escapeHtml(processedTpl.replace(/\{system\}/g, processedPrompt).replace(/\{user\}/g, userMsg));
            }
            previewContent.innerHTML = preview.replace(/\n/g, '<br>');
        }

        function escapeHtml(text) {
            return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        }

        function truncate(str, len) {
            return str.length > len ? str.substring(0, len) + '...' : str;
        }

        function updateFab() {
            const hasContent = systemPrompt || (messagePrefix && prefixEnabled);
            const anyEnabled = isEnabled || prefixEnabled;
            fab.classList.toggle('active', anyEnabled && hasContent);
            fab.classList.toggle('inactive', !(anyEnabled && hasContent));
            quickToggle.classList.toggle('on', anyEnabled);
            quickToggle.title = anyEnabled ? '点击关闭所有注入' : '点击开启所有注入';
        }

        function refreshPresetSelect() {
            presetSelect.innerHTML = presets.map(p =>
                `<option value="${p.id}" ${p.id === currentPresetId ? 'selected' : ''}>${p.name}</option>`
            ).join('');
        }

        function syncUIFromState() {
            input.value = systemPrompt;
            templateInput.value = customTemplate;
            prefixInput.value = messagePrefix;
            count.textContent = `${systemPrompt.length} 字符`;
            fmtNative.classList.toggle('active', useNativeFormat);
            fmtCustom.classList.toggle('active', !useNativeFormat);
            templateSection.style.display = useNativeFormat ? 'none' : 'block';
            toggle.classList.toggle('on', isEnabled);
            prefixToggle.classList.toggle('on', prefixEnabled);
            refreshPresetSelect();
            updatePreview();
            updateFab();
        }

        // 事件绑定
        fab.addEventListener('click', () => {
            if (accountPanel.classList.contains('open')) {
                accountPanel.classList.remove('open');
            }
            panel.classList.toggle('open');
        });

        quickToggle.addEventListener('click', (e) => {
            e.stopPropagation();
            // 快捷开关同时控制系统提示词和消息前缀
            const anyEnabled = isEnabled || prefixEnabled;
            const newState = !anyEnabled;

            isEnabled = newState;
            prefixEnabled = newState;

            GM_setValue(ENABLED_KEY, isEnabled);
            GM_setValue(PREFIX_ENABLED_KEY, prefixEnabled);

            toggle.classList.toggle('on', isEnabled);
            prefixToggle.classList.toggle('on', prefixEnabled);
            updateFab();
            log("Quick toggled all:", newState);
        });

        document.addEventListener('click', (e) => {
            const hitMain = panel.contains(e.target) || fabContainer.contains(e.target);

            if (!hitMain) {
                panel.classList.remove('open');
            }

            // 账号面板不自动关闭（避免 prompt/confirm 弹窗误触），只能通过关闭按钮或 FAB 切换
        });

        toggle.addEventListener('click', () => {
            isEnabled = !isEnabled;
            GM_setValue(ENABLED_KEY, isEnabled);
            toggle.classList.toggle('on', isEnabled);
            updateFab();
        });

        input.addEventListener('input', () => {
            count.textContent = `${input.value.length} 字符`;
            updatePreview();
        });

        templateInput.addEventListener('input', updatePreview);

        fmtNative.addEventListener('click', () => {
            useNativeFormat = true;
            fmtNative.classList.add('active');
            fmtCustom.classList.remove('active');
            templateSection.style.display = 'none';
            updatePreview();
        });

        fmtCustom.addEventListener('click', () => {
            useNativeFormat = false;
            fmtCustom.classList.add('active');
            fmtNative.classList.remove('active');
            templateSection.style.display = 'block';
            updatePreview();
        });

        // 变量提示展开/收起
        varsToggle.addEventListener('click', () => {
            const isShow = varsList.classList.toggle('show');
            varsToggle.textContent = isShow ? '🧩 可用变量 ▲' : '🧩 可用变量 ▼';
        });

        // 消息前缀开关
        prefixToggle.addEventListener('click', () => {
            prefixEnabled = !prefixEnabled;
            prefixToggle.classList.toggle('on', prefixEnabled);
            GM_setValue(PREFIX_ENABLED_KEY, prefixEnabled);
            updateFab();
        });

        // 调试模式开关
        debugToggle.addEventListener('click', () => {
            if (debugModeEnabled) {
                if (confirm('确定关闭调试模式？页面将刷新。')) {
                    disableDebugMode();
                }
            } else {
                if (confirm('确定开启调试模式？页面将刷新。')) {
                    enableDebugMode();
                }
            }
        });

        // 预设管理
        presetSelect.addEventListener('change', () => {
            // 先保存当前预设
            updateCurrentPreset();
            // 切换到新预设
            loadPreset(presetSelect.value);
            syncUIFromState();
        });

        presetAdd.addEventListener('click', () => {
            const name = prompt('请输入新预设名称：');
            if (name && name.trim()) {
                createPreset(name.trim());
                loadPreset(presets[presets.length - 1].id);
                syncUIFromState();
                log("Created empty preset:", name);
            }
        });

        presetRename.addEventListener('click', () => {
            if (currentPresetId === 'default') {
                alert('默认预设不能重命名');
                return;
            }
            const preset = presets.find(p => p.id === currentPresetId);
            const newName = prompt('请输入新名称：', preset?.name || '');
            if (newName && newName.trim()) {
                renamePreset(currentPresetId, newName.trim());
                refreshPresetSelect();
            }
        });

        presetDelete.addEventListener('click', () => {
            if (currentPresetId === 'default') {
                alert('默认预设不能删除');
                return;
            }
            if (confirm('确定删除当前预设？')) {
                deletePreset(currentPresetId);
                syncUIFromState();
            }
        });

        // 导入导出
        exportBtn.addEventListener('click', () => {
            // 先保存当前状态
            systemPrompt = input.value.trim();
            customTemplate = templateInput.value || DEFAULT_TEMPLATE;
            updateCurrentPreset();
            exportConfig();
        });

        importBtn.addEventListener('click', () => {
            fileInput.click();
        });

        fileInput.addEventListener('change', async (e) => {
            const file = e.target.files?.[0];
            if (!file) return;

            try {
                const result = await importConfig(file);
                alert(`导入成功！新增 ${result.imported} 个预设`);
                syncUIFromState();
            } catch (err) {
                alert('导入失败：' + err.message);
            }
            fileInput.value = '';
        });

        saveBtn.addEventListener('click', () => {
            systemPrompt = input.value.trim();
            customTemplate = templateInput.value || DEFAULT_TEMPLATE;
            messagePrefix = prefixInput.value;
            GM_setValue(STORAGE_KEY, systemPrompt);
            GM_setValue(FORMAT_KEY, useNativeFormat);
            GM_setValue(TEMPLATE_KEY, customTemplate);
            GM_setValue(PREFIX_KEY, messagePrefix);
            GM_setValue(PREFIX_ENABLED_KEY, prefixEnabled);
            updateCurrentPreset();
            updateFab();
            panel.classList.remove('open');
            log("Saved:", { systemPrompt: systemPrompt ? '(set)' : '(empty)', useNativeFormat, prefixEnabled });
        });

        cancelBtn.addEventListener('click', () => {
            panel.classList.remove('open');
        });

        updatePreview();
    }

    // ═══════════════════════════════════════
    // DOM 清理器 - 隐藏显示出来的系统提示词
    // ═══════════════════════════════════════

    function escapeRegExp(string) {
        return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    const DS_TOKENS_ESCAPED = {
        SYSTEM: '&lt;｜System｜&gt;',
        USER: '&lt;｜User｜&gt;',
    };

    // 用于存储已清理元素的内容哈希，而不是简单的标记
    const cleanedContentHashes = new WeakMap();

    function simpleHash(str) {
        let hash = 0;
        for (let i = 0; i < str.length; i++) {
            const char = str.charCodeAt(i);
            hash = ((hash << 5) - hash) + char;
            hash = hash & hash;
        }
        return hash;
    }

    function cleanupDisplayedPrompts() {
        if (!systemPrompt && !(prefixEnabled && messagePrefix)) return;

        const allDivs = document.querySelectorAll('div');

        allDivs.forEach(el => {
            // 跳过我们自己的 UI 元素
            if (el.closest('.dsp-fab-container, .dsp-panel, .dsp-fab, .dsp-quick-toggle, .dsp-toast')) return;
            if (el.classList.contains('dsp-fab-container') ||
                el.classList.contains('dsp-panel') ||
                el.classList.contains('dsp-fab') ||
                el.classList.contains('dsp-quick-toggle') ||
                el.classList.contains('dsp-toast')) return;

            const text = el.textContent || '';
            const html = el.innerHTML || '';

            // 计算当前内容哈希
            const currentHash = simpleHash(html);
            const lastHash = cleanedContentHashes.get(el);

            // 如果内容没变且之前已清理过，跳过
            if (lastHash === currentHash) return;

            const hasNativeToken = html.includes(DS_TOKENS_ESCAPED.SYSTEM) ||
                                   html.includes(DS_TOKENS_ESCAPED.USER) ||
                                   text.includes(DS_TOKENS.SYSTEM) ||
                                   text.includes(DS_TOKENS.USER);

            // 使用系统提示词的多个片段来匹配（避免变量替换后匹配不上）
            const sysPromptStart = systemPrompt.substring(0, Math.min(20, systemPrompt.length));
            const hasPromptContent = sysPromptStart.length >= 10 && text.includes(sysPromptStart);

            // 额外检查：消息前缀的固定部分
            let hasPrefixContent = false;
            if (prefixEnabled && messagePrefix) {
                const fixedParts = messagePrefix.split(/\{[^}]+\}/).filter(p => p.trim());
                hasPrefixContent = fixedParts.some(part => text.includes(part.trim()));
            }

            if (hasNativeToken || hasPromptContent || hasPrefixContent) {
                const directTextLength = Array.from(el.childNodes)
                    .filter(n => n.nodeType === Node.TEXT_NODE)
                    .reduce((sum, n) => sum + (n.textContent?.length || 0), 0);

                if (directTextLength > 10 || (el.children.length === 0 && text.length > 20)) {
                    const cleaned = cleanElement(el);
                    if (cleaned) {
                        // 更新哈希为清理后的内容
                        cleanedContentHashes.set(el, simpleHash(el.innerHTML));
                    }
                }
            }
        });
    }

    function cleanElement(el) {
        let html = el.innerHTML;
        let text = el.textContent || '';
        let modified = false;

        // 先清理消息前缀（必须在系统提示词之前，因为系统提示词清理会改变html/text）
        if (prefixEnabled && messagePrefix) {
            // 改进策略：构建能匹配变量替换后的正则，找到匹配的结束位置，删除从开头到该位置的所有内容

            // 1. 先处理消息前缀中的特殊字符，构建正则模式
            let prefixPattern = messagePrefix;

            // 转义正则特殊字符（但保留换行符的处理）
            prefixPattern = prefixPattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

            // 2. 将变量替换为对应的通配模式
            prefixPattern = prefixPattern
                .replace(/\\\{date\\\}/g, '\\d{4}-\\d{2}-\\d{2}')
                .replace(/\\\{time\\\}/g, '\\d{2}:\\d{2}:\\d{2}')
                .replace(/\\\{datetime\\\}/g, '\\d{4}-\\d{2}-\\d{2}\\s+\\d{2}:\\d{2}')
                .replace(/\\\{year\\\}/g, '\\d{4}')
                .replace(/\\\{month\\\}/g, '\\d{1,2}')
                .replace(/\\\{day\\\}/g, '\\d{1,2}')
                .replace(/\\\{hour\\\}/g, '\\d{1,2}')
                .replace(/\\\{minute\\\}/g, '\\d{1,2}')
                .replace(/\\\{weekday\\\}/g, '[日一二三四五六]')
                .replace(/\\\{weekday_en\\\}/g, '(?:Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday)')
                .replace(/\\\{timestamp\\\}/g, '\\d+')
                .replace(/\\\{random\\\}/g, '[a-zA-Z0-9]+');

            // 3. 处理换行符（匹配各种形式的换行）
            // 关键：让用户前缀中的 \n 能匹配实际文本中的换行
            prefixPattern = prefixPattern.replace(/\\n/g, '(?:\\s*\\n\\s*|\\s*<br\\s*/?>\\s*|\\s{2,})*');

            // 4. 使用非贪婪匹配来找到前缀的结束位置
            // 匹配模式：前缀内容 + 后续的分隔符（冒号、换行等）
            const fullPattern = '^(' + prefixPattern + ')(?::|：|\\s*\\n\\s*|\\s*<br\\s*/?>\\s*|\\s{2,})*';

            log("Prefix cleanup pattern:", fullPattern.substring(0, 150));

            try {
                const regex = new RegExp(fullPattern, 'i');
                const match = text.match(regex);

                if (match) {
                    const matchedPrefix = match[0];  // 完整匹配的内容（包括分隔符）
                    const prefixContent = match[1];  // 前缀内容部分

                    log("Matched prefix length:", matchedPrefix.length, "content length:", prefixContent.length);

                    // 5. 在HTML中找到这个前缀的结束位置
                    // 方法：通过字符位置映射
                    // 先找到 prefixContent 在 text 中的结束位置
                    const prefixEndInText = text.indexOf(prefixContent) + prefixContent.length;

                    // 6. 现在需要在HTML中删除从开头到对应位置的内容
                    // 方法：逐个字符在HTML中定位
                    let textPos = 0;
                    let htmlPos = 0;
                    let foundHtmlEndPos = -1;

                    while (htmlPos < html.length && textPos < text.length) {
                        const htmlChar = html[htmlPos];

                        // 跳过HTML标签
                        if (htmlChar === '<') {
                            const tagEnd = html.indexOf('>', htmlPos);
                            if (tagEnd > htmlPos) {
                                htmlPos = tagEnd + 1;
                                continue;
                            }
                        }

                        // 跳过HTML实体（如 &nbsp;）
                        if (htmlChar === '&') {
                            const semiColonPos = html.indexOf(';', htmlPos);
                            if (semiColonPos > htmlPos && semiColonPos - htmlPos < 10) {
                                // 这是一个实体，对应文本中的一个字符或空格
                                htmlPos = semiColonPos + 1;
                                textPos++;  // 实体通常对应一个文本字符
                                continue;
                            }
                        }

                        // 比较字符
                        if (htmlChar === text[textPos]) {
                            textPos++;
                            htmlPos++;

                            // 检查是否到达了前缀的结束位置
                            if (textPos >= prefixEndInText) {
                                // 找到了！还要包括后续的分隔符
                                foundHtmlEndPos = htmlPos;

                                // 继续扫描，跳过可能的分隔符（在HTML中）
                                while (foundHtmlEndPos < html.length) {
                                    const remainingHtml = html.substring(foundHtmlEndPos);
                                    // 匹配分隔符：标签、空格、冒号、换行符等
                                    const separatorMatch = remainingHtml.match(/^(?:\s|<[^>]+>|&nbsp;|:|：|<br\s*\/?>|\*\s*)+/i);
                                    if (separatorMatch) {
                                        foundHtmlEndPos += separatorMatch[0].length;
                                    }
                                    break;  // 只处理一次
                                }
                                break;
                            }
                        } else {
                            // 字符不匹配，可能是空白字符的差异
                            if (/\s/.test(htmlChar) && /\s/.test(text[textPos])) {
                                // 都是空白，同步前进
                                htmlPos++;
                                textPos++;
                            } else {
                                // 真正的不匹配，跳到下一个HTML字符
                                htmlPos++;
                            }
                        }
                    }

                    if (foundHtmlEndPos > 0) {
                        // 删除从开头到 foundHtmlEndPos 的所有内容
                        html = html.substring(foundHtmlEndPos);
                        modified = true;
                        log("Cleaned message prefix (char mapping), removed", foundHtmlEndPos, "chars from HTML");
                    } else {
                        log("Failed to map prefix to HTML position");
                    }
                } else {
                    log("Prefix pattern did not match text");
                }
            } catch (e) {
                log("Prefix cleanup error:", e);
            }

            // 7. 如果正则方法失败，回退到简单方法：查找最后一个固定段落
            if (!modified) {
                // 提取所有固定段落（非变量部分）
                const fixedParts = messagePrefix.split(/\{[^}]+\}/).filter(p => p.trim().length >= 3);

                if (fixedParts.length > 0) {
                    // 使用最长的一个作为搜索目标
                    const searchPart = fixedParts.sort((a, b) => b.length - a.length)[0].trim();

                    if (text.includes(searchPart)) {
                        // 在文本中找到位置
                        const partIndex = text.indexOf(searchPart);
                        const endInText = partIndex + searchPart.length;

                        // 映射到HTML
                        let textPos = 0;
                        let htmlPos = 0;

                        while (htmlPos < html.length && textPos < endInText) {
                            const htmlChar = html[htmlPos];

                            if (htmlChar === '<') {
                                const tagEnd = html.indexOf('>', htmlPos);
                                if (tagEnd > htmlPos) {
                                    htmlPos = tagEnd + 1;
                                    continue;
                                }
                            }

                            if (htmlChar === '&') {
                                const semiColonPos = html.indexOf(';', htmlPos);
                                if (semiColonPos > htmlPos && semiColonPos - htmlPos < 10) {
                                    htmlPos = semiColonPos + 1;
                                    textPos++;
                                    continue;
                                }
                            }

                            if (htmlChar === text[textPos]) {
                                textPos++;
                            }
                            htmlPos++;
                        }

                        if (htmlPos > 0 && htmlPos <= html.length) {
                            // 跳过后续的分隔符
                            const afterMatch = html.substring(htmlPos);
                            const skipMatch = afterMatch.match(/^(?:\s|<[^>]+>|&nbsp;|:|：|<br\s*\/?>|\*\s*)+/i);
                            if (skipMatch) {
                                htmlPos += skipMatch[0].length;
                            }

                            html = html.substring(htmlPos);
                            modified = true;
                            log("Cleaned message prefix (fallback char mapping)");
                        }
                    }
                }
            }
        }

        if (modified) {
            el.innerHTML = html;
            log("Element cleaned:", el.className);
        }

        return modified;
    }

    function setupDOMObserver() {
        const observer = new MutationObserver((mutations) => {
            // 检查是否有相关的变化
            let hasRelevantChange = false;
            for (const mutation of mutations) {
                if (mutation.type === 'childList' && mutation.addedNodes.length > 0) {
                    hasRelevantChange = true;
                    break;
                }
                if (mutation.type === 'characterData') {
                    hasRelevantChange = true;
                    break;
                }
            }

            if (!hasRelevantChange) return;

            clearTimeout(window._dspCleanupTimeout);
            window._dspCleanupTimeout = setTimeout(() => {
                if ((systemPrompt && isEnabled) || (prefixEnabled && messagePrefix)) {
                    cleanupDisplayedPrompts();
                }
            }, 50);
        });

        observer.observe(document.body, {
            childList: true,
            subtree: true,
            characterData: true
        });

        log("DOM observer setup");
    }

    GM_addStyle(`
        .dsp-hidden-prompt {
            display: none !important;
            visibility: hidden !important;
            width: 0 !important;
            height: 0 !important;
            overflow: hidden !important;
        }
    `);

    // ═══════════════════════════════════════
    // 剪贴板拦截 - 清理复制内容中的注入部分
    // ═══════════════════════════════════════
    function cleanTextForClipboard(text) {
        if (!text) return text;
        let cleaned = text;

        // 清理原生 token（<｜System｜>...<｜User｜>）
        if (systemPrompt) {
            const nativePattern = new RegExp(
                escapeRegExp(DS_TOKENS.SYSTEM) + '[\\s\\S]*?' + escapeRegExp(DS_TOKENS.USER),
                'g'
            );
            cleaned = cleaned.replace(nativePattern, '');
        }

        // 清理自定义模板格式
        if (!useNativeFormat && systemPrompt && systemPrompt.length > 10) {
            const escapedSysPrompt = escapeRegExp(systemPrompt);
            const customRegex = new RegExp(escapedSysPrompt + '\\s*(?:---)?\\s*', 'g');
            cleaned = cleaned.replace(customRegex, '');
        }

        // 清理消息前缀（变量已替换后的格式）
        if (prefixEnabled && messagePrefix) {
            let prefixPattern = messagePrefix;
            prefixPattern = prefixPattern
                .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
                .replace(/\\\{date\\\}/g, '\\d{4}-\\d{2}-\\d{2}')
                .replace(/\\\{time\\\}/g, '\\d{2}:\\d{2}:\\d{2}')
                .replace(/\\\{datetime\\\}/g, '\\d{4}-\\d{2}-\\d{2}\\s+\\d{2}:\\d{2}')
                .replace(/\\\{year\\\}/g, '\\d{4}')
                .replace(/\\\{month\\\}/g, '\\d{2}')
                .replace(/\\\{day\\\}/g, '\\d{2}')
                .replace(/\\\{hour\\\}/g, '\\d{2}')
                .replace(/\\\{minute\\\}/g, '\\d{2}')
                .replace(/\\\{weekday\\\}/g, '[日一二三四五六]')
                .replace(/\\\{weekday_en\\\}/g, '(?:Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday)')
                .replace(/\\\{timestamp\\\}/g, '\\d+')
                .replace(/\\\{random\\\}/g, '[a-z0-9]+');
            prefixPattern = prefixPattern.replace(/\\n/g, '\\n');

            try {
                cleaned = cleaned.replace(new RegExp(prefixPattern, 'g'), '');
            } catch (e) {
                log("Clipboard prefix regex error:", e);
            }
        }

        return cleaned;
    }

    function interceptClipboard() {
        // 拦截 copy 事件（覆盖选中复制）
        document.addEventListener('copy', (e) => {
            const selection = window.getSelection();
            if (!selection || selection.isCollapsed) return;

            const text = selection.toString();
            const cleanedText = cleanTextForClipboard(text);

            if (text !== cleanedText) {
                e.preventDefault();
                e.clipboardData.setData('text/plain', cleanedText);
                log("Cleaned copy selection content");
            }
        });

        // 拦截 navigator.clipboard.writeText（DeepSeek 复制按钮可能用这个）
        const clipboard = unsafeWindow.navigator.clipboard;
        if (clipboard && clipboard.writeText) {
            const originalWriteText = clipboard.writeText.bind(clipboard);
            unsafeWindow.navigator.clipboard.writeText = async function(text) {
                const cleanedText = cleanTextForClipboard(text);
                if (text !== cleanedText) {
                    log("Cleaned clipboard.writeText content");
                }
                return originalWriteText(cleanedText);
            };
        }

        // 拦截 execCommand('copy')（某些旧式复制按钮可能用这个）
        const originalExecCommand = unsafeWindow.document.execCommand?.bind(unsafeWindow.document);
        if (originalExecCommand) {
            unsafeWindow.document.execCommand = function(cmd, ...args) {
                if (cmd === 'copy') {
                    const selection = window.getSelection();
                    if (selection && !selection.isCollapsed) {
                        const text = selection.toString();
                        const cleanedText = cleanTextForClipboard(text);
                        if (text !== cleanedText) {
                            // 创建一个临时元素来放清理后的文本
                            const tempEl = document.createElement('textarea');
                            tempEl.value = cleanedText;
                            tempEl.style.cssText = 'position:fixed;left:-9999px;top:-9999px;';
                            document.body.appendChild(tempEl);
                            tempEl.select();
                            const result = originalExecCommand('copy');
                            document.body.removeChild(tempEl);
                            // 恢复原来的选区
                            return result;
                        }
                    }
                }
                return originalExecCommand(cmd, ...args);
            };
        }

        log("Clipboard interception setup");
    }

    // ═══════════════════════════════════════
    // 初始化
    // ═══════════════════════════════════════
    interceptXHR();
    interceptFetch();

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => {
            createUI();
            setupDOMObserver();
            interceptClipboard();
            setTimeout(cleanupDisplayedPrompts, 200);
        });
    } else {
        setTimeout(() => {
            createUI();
            setupDOMObserver();
            interceptClipboard();
            setTimeout(cleanupDisplayedPrompts, 200);
        }, 100);
    }

    log("Initialized v3.8.0 (Nova Silent Sky UI + Multi-Account Email Login + Presets + Variables + Edit First Message Fix + Clipboard Cleanup) (Nova Silent Sky UI + Multi-Account Switcher + Presets + Variables + Edit First Message Fix + Clipboard Cleanup) (Nova Silent Sky UI + Presets + Variables + Edit First Message Fix + Clipboard Cleanup + Resizable Textarea)");
})();
