// popup.js
let collectedData = [];
let isCollecting = false;
let isPaused = false;
let messageListener = null;

// DOM 元素
const mainBtn = document.getElementById('mainBtn');
const exportBtn = document.getElementById('exportBtn');
const clearBtn = document.getElementById('clearBtn');
const logArea = document.getElementById('logArea');
const countSpan = document.getElementById('count');
const statusSpan = document.getElementById('status');

// 配置元素
const scrollsInput = document.getElementById('scrolls');
const pauseInput = document.getElementById('pause');
const maxItemsInput = document.getElementById('maxItems');
const pageCountInput = document.getElementById('pageCount');
const detailDelayInput = document.getElementById('detailDelay');
const useDetailPageCheck = document.getElementById('useDetailPage');
const autoDownloadCheck = document.getElementById('autoDownload');
const fastModeCheck = document.getElementById('fastMode');  // 🆕 快速采集
const concurrentLimitInput = document.getElementById('concurrentLimit');
const exportHtmlCheck = document.getElementById('exportHtml');  // 🆕 导出HTML

// 从 storage 加载历史数据、配置和日志
chrome.storage.local.get(['collectedData', 'config', 'logHistory'], (result) => {
    // 恢复数据
    if (result.collectedData && result.collectedData.length > 0) {
        collectedData = result.collectedData;
        console.log('[加载] 恢复数据:', collectedData.length, '条');
        updateUI();
    } else {
        // 如果没有数据，也要更新UI
        collectedData = [];
        updateUI();
    }

    // 恢复日志（🆕 限制最多显示100条，避免卡顿）
    if (result.logHistory && result.logHistory.length > 0) {
        const logsToShow = result.logHistory.slice(-100);  // 只显示最近100条
        const fragment = document.createDocumentFragment();  // 使用DocumentFragment优化性能
        logsToShow.forEach(log => {
            const logItem = document.createElement('div');
            logItem.className = `log-item log-${log.type || 'info'}`;
            logItem.textContent = log.text;
            fragment.appendChild(logItem);
        });
        logArea.appendChild(fragment);
        // 滚动容器是log-container
        const logContainer = logArea.parentElement;
        if (logContainer) {
            logContainer.scrollTop = logContainer.scrollHeight;
        }
    }

    // 恢复配置（注意：配置中的pause和detailDelay可能是毫秒值，需要转换）
    if (result.config) {
        // 确保使用正确的默认值，避免配置值异常
        scrollsInput.value = result.config.scrolls || 1;
        // 如果pause是毫秒值（大于10），则除以1000转换为秒
        const pauseValue = result.config.pause || 0.5;
        pauseInput.value = pauseValue > 10 ? pauseValue / 1000 : pauseValue;
        maxItemsInput.value = result.config.maxItems || 3;
        pageCountInput.value = result.config.pageCount || 1;
        // 如果detailDelay是毫秒值（大于10），则除以1000转换为秒
        const detailDelayValue = result.config.detailDelay || 0.1;
        detailDelayInput.value = detailDelayValue > 10 ? detailDelayValue / 1000 : detailDelayValue;
        useDetailPageCheck.checked = result.config.useDetailPage !== false;
        // 恢复自动下载设置
        if (autoDownloadCheck) {
            autoDownloadCheck.checked = result.config.autoDownload === true;
        }
        // 🆕 恢复快速采集设置
        if (fastModeCheck) {
            fastModeCheck.checked = result.config.fastMode === true;
        }
        // 恢复并发数量设置
        if (concurrentLimitInput) {
            concurrentLimitInput.value = result.config.concurrentLimit || 10;
        }
        // 恢复HTML导出设置
        if (exportHtmlCheck) {
            exportHtmlCheck.checked = result.config.exportHtml === true;
        }
    } else {
        // 设置默认值
        scrollsInput.value = 1;
        pauseInput.value = 0.3;
        maxItemsInput.value = 3;
        pageCountInput.value = 1;
        detailDelayInput.value = 0.05;
    }
});

// 日志历史（用于持久化）
let logHistory = [];

// 添加日志
function addLog(message, type = 'info') {
    const timestamp = new Date().toLocaleTimeString();
    const logText = `[${timestamp}] ${message}`;

    const logItem = document.createElement('div');
    logItem.className = `log-item log-${type}`;
    logItem.textContent = logText;
    logArea.appendChild(logItem);

    // 自动滚动到底部 - 滚动容器是log-container，不是logArea
    const logContainer = logArea.parentElement;
    setTimeout(() => {
        if (logContainer) {
            logContainer.scrollTop = logContainer.scrollHeight;
        }
    }, 10);

    // 保存到历史记录（最多保存200条）
    logHistory.push({ text: logText, type: type, timestamp: Date.now() });
    if (logHistory.length > 200) {
        logHistory = logHistory.slice(-200); // 只保留最近200条
    }

    // 保存到storage（防抖，每5秒保存一次）
    if (!window.logSaveTimer) {
        window.logSaveTimer = setTimeout(() => {
            chrome.storage.local.set({ logHistory: logHistory });
            window.logSaveTimer = null;
        }, 5000);
    }
}

function getLocal(keys) {
    return new Promise((resolve) => {
        try {
            chrome.storage.local.get(keys, (result) => resolve(result || {}));
        } catch (e) {
            resolve({});
        }
    });
}

function setLocal(obj) {
    return new Promise((resolve) => {
        try {
            chrome.storage.local.set(obj, () => resolve());
        } catch (e) {
            resolve();
        }
    });
}

// 更新UI
function updateUI() {
    countSpan.textContent = collectedData.length;
    // 只有在没有数据或正在采集时才禁用导出按钮
    exportBtn.disabled = collectedData.length === 0 || isCollecting;
    console.log('[UI更新] 已采集:', collectedData.length, '采集中:', isCollecting, '按钮禁用:', exportBtn.disabled);
}

// 🆕 重置UI到初始状态（确保按钮大小完全恢复）
function resetUI() {
    // 重置状态
    isCollecting = false;
    isPaused = false;

    // 恢复按钮
    mainBtn.disabled = false;
    mainBtn.textContent = '开始采集';

    // 🆕 强制设置所有样式（确保和初始状态一模一样）
    mainBtn.removeAttribute('class');
    mainBtn.setAttribute('class', 'btn-main');

    // 🆕 关键：强制设置内联样式，覆盖任何可能的样式问题
    mainBtn.style.cssText = `
        width: 80% !important;
        padding: 10px 40px !important;
        font-size: 15px !important;
        font-weight: bold !important;
        color: white !important;
        background: linear-gradient(135deg, #667eea 0%, #764ba2 100%) !important;
        border: none !important;
        border-radius: 30px !important;
        cursor: pointer !important;
        display: block !important;
        margin: 0 auto !important;
        letter-spacing: 1px !important;
        box-shadow: 0 4px 6px rgba(50, 50, 93, 0.11), 0 1px 3px rgba(0, 0, 0, 0.08) !important;
    `;

    // 恢复状态显示
    statusSpan.textContent = '就绪';

    // 确保更新导出按钮状态
    updateUI();
}

// 主按钮：开始采集 / 立即停止 两状态切换
mainBtn.addEventListener('click', async () => {
    // 如果正在采集 → 点击立即停止
    if (isCollecting) {
        // 🆕 立即停止：彻底停止所有功能
        addLog('🛑 正在停止采集，请稍候...', 'info');

        // 禁用按钮防止重复点击
        mainBtn.disabled = true;
        mainBtn.textContent = '⏳ 停止中...';

        // 发送停止消息到 background
        chrome.runtime.sendMessage({ type: 'forceStopCollection' }, (response) => {
            // 重置所有状态
            isCollecting = false;
            isPaused = false;

            // 🆕 使用 resetUI 函数完全恢复按钮样式
            resetUI();
            statusSpan.textContent = '已停止';

            addLog('✅ 采集已完全停止', 'success');
        });

        return;
    }

    // 未在采集 → 点击开始

    try {
        // 获取当前活动标签页
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

        if (!tab.url.includes('goofish.com') && !tab.url.includes('taobao.com')) {
            addLog('❌ 请在闲鱼页面使用此插件！', 'error');
            return;
        }

        // 记录“导出文件命名上下文”：搜索页用搜索词，个人主页用昵称
        // 说明：如果从搜索页打开详情页后才点击采集，则从 lastSearchKeyword 回溯
        let exportNameContext = {
            sourceType: 'other', // search | personal | other
            searchKeyword: '',
            startedAt: Date.now(),
            startUrl: tab.url || ''
        };
        try {
            const u = new URL(tab.url || '');
            if (u.hostname.endsWith('.goofish.com') && u.pathname === '/search') {
                const q = (u.searchParams.get('q') || u.searchParams.get('keyword') || u.searchParams.get('query') || '').trim();
                exportNameContext.sourceType = 'search';
                exportNameContext.searchKeyword = q;
            } else if (u.hostname.endsWith('.goofish.com') && (u.pathname === '/personal' || u.pathname.startsWith('/personal/'))) {
                exportNameContext.sourceType = 'personal';
            } else {
                // 不是搜索/个人主页：尝试回溯最近一次搜索关键词
                const cached = await getLocal(['lastSearchKeyword', 'lastSearchUpdatedAt']);
                const lastKw = (cached.lastSearchKeyword || '').trim();
                const lastAt = cached.lastSearchUpdatedAt || 0;
                // 30分钟内认为“从搜索页打开详情页”仍然有效
                if (lastKw && (Date.now() - lastAt) < 30 * 60 * 1000) {
                    exportNameContext.sourceType = 'search';
                    exportNameContext.searchKeyword = lastKw;
                }
            }
        } catch (e) {
            // ignore
        }
        await setLocal({ exportNameContext });

        // 获取配置（只读取最多采集，其他使用固定默认值）
        const maxItems = parseInt(maxItemsInput.value) || 3;
        const pageCount = Math.max(1, parseInt(pageCountInput.value) || 1);

        // 使用固定的默认值（隐藏的配置项）
        const scrolls = 1;  // 固定值
        const pauseSeconds = 0.3;  // 固定值（秒）
        const detailDelaySeconds = 0.05;  // 固定值（秒）
        const concurrentLimit = parseInt(concurrentLimitInput?.value) || 10;

        // 转换为毫秒值用于内部使用
        const config = {
            scrolls: scrolls,
            pause: pauseSeconds * 1000,  // 转换为毫秒
            maxItems: maxItems,
            pageCount: pageCount,
            detailDelay: detailDelaySeconds * 1000,  // 转换为毫秒
            useDetailPage: useDetailPageCheck.checked,
            concurrentLimit: concurrentLimit,
            fastMode: fastModeCheck ? fastModeCheck.checked : false  // 🆕 快速采集
        };

        // 保存配置（保存秒值，方便下次加载）
        chrome.storage.local.set({
            config: {
                scrolls: scrolls,
                pause: pauseSeconds,  // 保存秒值
                maxItems: maxItems,
                pageCount: pageCount,
                detailDelay: detailDelaySeconds,  // 保存秒值
                useDetailPage: useDetailPageCheck.checked,
                autoDownload: autoDownloadCheck ? autoDownloadCheck.checked : false,
                fastMode: fastModeCheck ? fastModeCheck.checked : false,  // 🆕 保存快速采集设置
                concurrentLimit: concurrentLimit,
                exportHtml: exportHtmlCheck ? exportHtmlCheck.checked : false  // 🆕 保存HTML导出设置
            }
        });

        // ========== 强制清空所有旧数据，避免累积 ==========
        collectedData = [];
        logHistory = [];

        // 立即清空storage，防止恢复旧数据
        chrome.storage.local.set({
            collectedData: [],
            logHistory: []
        });

        // 清空UI
        logArea.innerHTML = '';
        countSpan.textContent = '0';

        addLog('🗑️ 已自动清空旧数据', 'info');

        // 🔧 修复：向后台发送重置消息，清除可能残留的采集锁
        chrome.runtime.sendMessage({ type: 'resetCollectionState' });
        // ===================================================

        isCollecting = true;
        isPaused = false;

        // 🆕 按钮动效：先显示启动动画，然后变成「立即停止」
        mainBtn.textContent = '⚡ 启动中...';
        mainBtn.className = 'btn-main btn-starting';

        setTimeout(() => {
            mainBtn.textContent = '🛑 立即停止';
            mainBtn.className = 'btn-main btn-stop';
        }, 500);

        statusSpan.textContent = '采集中';

        addLog('🚀 V7.1 极速模式启动！', 'success');
        addLog(`[配置] 最多采集:${config.maxItems}条 | 采集页数:${config.pageCount}页`, 'info');
        addLog(`[模式] ${config.fastMode ? '⚡ 快速采集（仅列表页）' : '深度采集（详情页）'}`, 'info');

        // 移除旧的监听器（如果存在）
        if (messageListener) {
            chrome.runtime.onMessage.removeListener(messageListener);
        }

        // 创建新的监听器
        messageListener = handleMessage;
        chrome.runtime.onMessage.addListener(messageListener);

        // 向 content script 发送消息
        chrome.tabs.sendMessage(tab.id, {
            action: 'startCollect',
            config: config
        }, (response) => {
            if (chrome.runtime.lastError) {
                // 获取重试次数
                chrome.storage.local.get(['connectionRetryCount'], async (result) => {
                    const retryCount = result.connectionRetryCount || 0;
                    const maxRetries = 3;

                    if (retryCount < maxRetries) {
                        // 增加重试计数
                        await chrome.storage.local.set({ connectionRetryCount: retryCount + 1 });

                        addLog(`❌ 连接失败 (${retryCount + 1}/${maxRetries})，正在自动刷新页面...`, 'error');

                        // 保存当前配置，刷新后自动继续
                        await chrome.storage.local.set({
                            pendingAutoCollect: true,
                            pendingConfig: config
                        });

                        // 刷新当前页面
                        chrome.tabs.reload(tab.id, {}, () => {
                            addLog('🔄 页面刷新中，请稍候...', 'info');

                            // 等待页面加载完成后自动重试
                            const checkPageReady = setInterval(async () => {
                                try {
                                    // 尝试发送测试消息检查页面是否准备好
                                    chrome.tabs.sendMessage(tab.id, { action: 'ping' }, (pingResponse) => {
                                        if (!chrome.runtime.lastError && pingResponse) {
                                            clearInterval(checkPageReady);
                                            addLog('✅ 页面已就绪，自动重新开始采集...', 'success');

                                            // 重新发送采集指令
                                            setTimeout(() => {
                                                chrome.tabs.sendMessage(tab.id, {
                                                    action: 'startCollect',
                                                    config: config
                                                }, (retryResponse) => {
                                                    if (chrome.runtime.lastError) {
                                                        addLog('❌ 重试后仍然连接失败，请手动刷新页面', 'error');
                                                        resetUI();
                                                    } else if (retryResponse && retryResponse.success) {
                                                        addLog('✅ 采集任务已启动！', 'success');
                                                        // 重置重试计数
                                                        chrome.storage.local.set({ connectionRetryCount: 0 });
                                                    }
                                                });
                                            }, 500);
                                        }
                                    });
                                } catch (e) {
                                    // 页面还没准备好，继续等待
                                }
                            }, 1000);

                            // 30秒超时
                            setTimeout(() => {
                                clearInterval(checkPageReady);
                            }, 30000);
                        });
                    } else {
                        // 超过最大重试次数
                        addLog('❌ 多次重试后连接仍失败，请手动刷新页面后重试', 'error');
                        // 重置重试计数
                        chrome.storage.local.set({ connectionRetryCount: 0 });
                        resetUI();
                    }
                });
                return;
            }

            if (response && response.success) {
                addLog('✅ 采集任务已启动！', 'success');
                // 重置重试计数
                chrome.storage.local.set({ connectionRetryCount: 0 });
            }
        });

    } catch (error) {
        addLog(`❌ 错误: ${error.message}`, 'error');
        resetUI();
    }
});

// 处理来自 content script 和 background 的消息
function handleMessage(message, sender, sendResponse) {
    if (message.type === 'log') {
        addLog(message.text, message.level || 'info');
    } else if (message.type === 'data') {
        collectedData.push(message.data);
        updateUI();
    } else if (message.type === 'complete') {
        addLog(`✅ 采集完成！共采集 ${collectedData.length} 条数据`, 'success');

        // 🆕 显示失败数量
        if (message.failedCount && message.failedCount > 0) {
            addLog(`⚠️ 有 ${message.failedCount} 个商品因验证失败，可点击"重试失败"按钮`, 'error');
        }

        statusSpan.textContent = '完成';
        isCollecting = false;
        resetUI();

        // 保存数据和日志
        chrome.storage.local.set({
            collectedData: collectedData,
            logHistory: logHistory
        });
        updateUI();

        // 🆕 自动导出功能：已移到 background.js 中处理
        // popup 这里不再触发导出，避免重复下载
        // if (collectedData.length > 0 && message.autoDownload) { ... }

    } else if (message.type === 'verificationNeeded') {
        // 🆕 处理需要验证的消息
        addLog(`🛑 检测到验证码！请在浏览器窗口中完成验证`, 'error');
        addLog(`📋 有 ${message.failedCount || 0} 个商品等待重试`, 'info');
        addLog(`✅ 验证完成后，点击"继续采集"按钮`, 'success');

        statusSpan.textContent = '需要验证';
        isPaused = true;
        mainBtn.textContent = '✅ 验证完成，继续采集';
        mainBtn.className = 'btn-success';

    } else if (message.type === 'error') {
        addLog(`❌ ${message.text}`, 'error');
        resetUI();
        if (messageListener) {
            chrome.runtime.onMessage.removeListener(messageListener);
            messageListener = null;
        }
    }
}

// 🆕 resetUI 函数已在文件开头定义（第156行），这里不再重复定义

// 导出Excel
exportBtn.addEventListener('click', async () => {
    if (collectedData.length === 0) {
        addLog('❌ 没有数据可导出', 'error');
        return;
    }

    try {
        addLog(`💾 正在生成Excel文件，共 ${collectedData.length} 条数据...`, 'info');
        exportBtn.disabled = true;
        exportBtn.textContent = '⏳ 导出中...';

        // 确保有消息监听器
        if (!messageListener) {
            messageListener = handleMessage;
            chrome.runtime.onMessage.addListener(messageListener);
        }

        // 发送数据到 background script 生成文件
        const useHtml = exportHtmlCheck ? exportHtmlCheck.checked : false;
        chrome.runtime.sendMessage({
            action: 'exportExcel',
            data: collectedData,
            exportHtml: useHtml
        }, (response) => {
            exportBtn.disabled = false;
            exportBtn.textContent = '💾 导出Excel';

            if (chrome.runtime.lastError) {
                addLog(`❌ 导出失败: ${chrome.runtime.lastError.message}`, 'error');
                console.error('导出错误:', chrome.runtime.lastError);
                return;
            }

            if (response && response.success) {
                addLog(`✅ 文件已保存: ${response.filename}`, 'success');
                if (response.path) {
                    addLog(`📁 ${response.path}`, 'info');
                } else {
                    addLog(`📁 保存位置：以浏览器默认下载目录为准`, 'info');
                }
            } else {
                addLog(`❌ 导出失败: ${response?.error || '未知错误'}`, 'error');
                console.error('导出响应:', response);
            }
        });
    } catch (error) {
        exportBtn.disabled = false;
        exportBtn.textContent = '💾 导出Excel';
        addLog(`❌ 导出错误: ${error.message}`, 'error');
        console.error('导出异常:', error);
    }
});

// 清空日志
clearBtn.addEventListener('click', () => {
    logArea.innerHTML = '';
    collectedData = [];
    logHistory = [];
    chrome.storage.local.remove(['collectedData', 'logHistory']);
    updateUI();
    addLog('🗑️ 已清空', 'info');
});

// 页面卸载时保存日志和数据
window.addEventListener('beforeunload', () => {
    if (logHistory && logHistory.length > 0) {
        chrome.storage.local.set({
            logHistory: logHistory,
            collectedData: collectedData
        });
    }
});

// 定期保存日志和数据（每10秒）
setInterval(() => {
    if (logHistory && logHistory.length > 0) {
        chrome.storage.local.set({
            logHistory: logHistory,
            collectedData: collectedData
        });
    }
}, 10000);

// =========================
// 数据对比功能
// =========================
const compareBtn = document.getElementById('compareBtn');
const csvUpload = document.getElementById('csvUpload');

// 从HYPERLINK公式或纯URL中提取真实URL - 增强版
function extractUrlFromCell(cellValue) {
    if (!cellValue) return null;
    const val = String(cellValue).trim();

    console.log('[对比] 解析单元格:', val.substring(0, 100));

    // 方法1: 解析HYPERLINK公式 - 多种格式支持
    // 格式: =HYPERLINK("url","text") 或 =HYPERLINK(""url"",""text"")
    const hyperlinkPatterns = [
        /=HYPERLINK\s*\(\s*""([^"]+)""\s*,/i,  // =HYPERLINK(""url"",
        /=HYPERLINK\s*\(\s*"([^"]+)"\s*,/i,     // =HYPERLINK("url",
        /=HYPERLINK\s*\(\s*'([^']+)'\s*,/i,     // =HYPERLINK('url',
        /=HYPERLINK\s*\(([^,)]+),/i,             // =HYPERLINK(url,
    ];

    for (const pattern of hyperlinkPatterns) {
        const match = val.match(pattern);
        if (match && match[1]) {
            const url = match[1].trim();
            if (url.includes('goofish.com') || url.includes('taobao.com')) {
                console.log('[对比] 从HYPERLINK提取URL:', url);
                return url;
            }
        }
    }

    // 方法2: 直接从字符串中提取goofish.com的URL（更宽松的正则）
    const urlPatterns = [
        /https?:\/\/(?:www\.)?goofish\.com\/item[^\s\"'<>\)\]\}]*/gi,
        /https?:\/\/[^\s\"'<>\)\]\}]*goofish\.com[^\s\"'<>\)\]\}]*/gi,
        /https?:\/\/[^\s\"'<>\)\]\}]*taobao\.com[^\s\"'<>\)\]\}]*/gi,
    ];

    for (const pattern of urlPatterns) {
        const matches = val.match(pattern);
        if (matches && matches[0]) {
            const url = matches[0].trim();
            console.log('[对比] 正则提取URL:', url);
            return url;
        }
    }

    // 方法3: 纯URL
    if (val.startsWith('http://') || val.startsWith('https://')) {
        return val;
    }

    console.log('[对比] 未能提取URL, 原始值:', val);
    return null;
}

// 🆕 解析HTML文件（从插件导出的HTML表格中提取数据）
function parseHTMLFile(htmlText) {
    try {
        const parser = new DOMParser();
        const doc = parser.parseFromString(htmlText, 'text/html');
        const table = doc.querySelector('table');
        if (!table) {
            console.log('[对比] HTML中未找到table标签');
            return [];
        }

        // 从thead提取列名
        const headerRow = table.querySelector('thead tr');
        if (!headerRow) {
            console.log('[对比] HTML表格中未找到thead');
            return [];
        }

        const headers = [];
        headerRow.querySelectorAll('th').forEach(th => {
            headers.push(th.textContent.trim());
        });
        console.log('[对比] HTML表头:', headers);

        // 列名映射（HTML表头名 → 内部字段名）
        const columnMap = {
            '#': '_rank',
            '封面': '_cover',
            '商品信息': '_info',
            '卖家': '卖家昵称',
            '价格(¥)': '价格',
            '想要': '想要',
            '浏览量': '浏览量',
            '询单率': '询单率',
            '日均想要': '日均想要',
            '发布时间': '发布时间',
            '采集时间': '采集时间',
            '发布天数': '发布天数'
        };

        // 遍历tbody每一行
        const rows = table.querySelectorAll('tbody tr');
        const result = [];

        rows.forEach(tr => {
            const cells = tr.querySelectorAll('td');
            if (cells.length === 0) return;

            const rowData = {};

            cells.forEach((td, index) => {
                if (index >= headers.length) return;
                const headerName = headers[index];
                const fieldName = columnMap[headerName] || headerName;

                // 特殊处理"商品信息"列：提取链接和标题
                if (headerName === '商品信息') {
                    const link = td.querySelector('a');
                    if (link) {
                        rowData['商品链接'] = link.getAttribute('href') || '';
                        rowData['商品标题'] = link.textContent.trim();
                    } else {
                        // 没有链接时取纯文本作为标题
                        const titleDiv = td.querySelector('.item-title');
                        rowData['商品标题'] = titleDiv ? titleDiv.textContent.trim() : td.textContent.trim();
                        rowData['商品链接'] = '';
                    }
                    // 提取描述
                    const descDiv = td.querySelector('.item-desc');
                    if (descDiv) {
                        rowData['商品描述'] = descDiv.textContent.trim();
                    }
                } else if (headerName === '封面') {
                    // 提取封面图URL
                    const img = td.querySelector('img');
                    if (img) {
                        rowData['封面图'] = img.getAttribute('src') || '';
                    }
                } else if (headerName !== '#') {
                    // 普通列：取纯文本
                    rowData[fieldName] = td.textContent.trim();
                }
            });

            // 只保留有商品链接的行
            if (rowData['商品链接'] || rowData['商品标题']) {
                result.push(rowData);
            }
        });

        console.log('[对比] HTML解析完成，共', result.length, '条数据');
        return result;
    } catch (e) {
        console.error('[对比] HTML解析错误:', e);
        return [];
    }
}

// 解析CSV内容
function parseCSV(csvText) {
    // 移除BOM
    if (csvText.charCodeAt(0) === 0xFEFF) {
        csvText = csvText.substring(1);
    }

    const lines = csvText.split(/\r?\n/).filter(line => line.trim());
    if (lines.length < 2) return [];

    // 解析表头
    const headers = parseCSVLine(lines[0]);

    // 解析数据行
    const data = [];
    for (let i = 1; i < lines.length; i++) {
        const values = parseCSVLine(lines[i]);
        if (values.length === 0) continue;

        const row = {};
        headers.forEach((header, index) => {
            row[header.trim()] = values[index] || '';
        });
        data.push(row);
    }

    return data;
}

// 解析CSV行（处理引号内的逗号）
function parseCSVLine(line) {
    const result = [];
    let current = '';
    let inQuotes = false;

    for (let i = 0; i < line.length; i++) {
        const char = line[i];
        const nextChar = line[i + 1];

        if (char === '"') {
            if (inQuotes && nextChar === '"') {
                current += '"';
                i++;
            } else {
                inQuotes = !inQuotes;
            }
        } else if (char === ',' && !inQuotes) {
            result.push(current);
            current = '';
        } else {
            current += char;
        }
    }
    result.push(current);

    return result;
}

// 格式化日期值为统一格式 YYYY/MM/DD HH:mm
function formatDateValue(value) {
    if (!value) return '';

    // 如果已经是格式化好的字符串，直接返回
    if (typeof value === 'string') {
        // 检查是否是 "Sat Dec 27 2025 00:40:00 GMT+0800" 这种格式
        if (value.includes('GMT') || value.includes('(')) {
            try {
                const date = new Date(value);
                if (!isNaN(date.getTime())) {
                    return formatDate(date);
                }
            } catch (e) {
                // 无法解析，返回原值
            }
        }
        return value;
    }

    // 如果是Date对象（可能来自 Excel 解析，已被 ExcelJS 转换时区）
    // 使用 formatDateAsNaive 避免重复时区转换
    if (value instanceof Date) {
        return formatDateAsNaive(value);
    }

    // 如果是数字（Excel序列号日期）
    if (typeof value === 'number') {
        // Excel日期序列号转换（不涉及时区，直接计算）
        // Excel的日期起点是1900-01-01 (序列号1)
        // 但有一个bug：Excel认为1900年是闰年，所以序列号60是1900-02-29

        // 直接计算年月日时分（不通过Date对象，避免时区问题）
        const totalDays = value;
        const wholeDays = Math.floor(totalDays);
        const timeFraction = totalDays - wholeDays;

        // 计算日期部分（从1899-12-30开始）
        const baseDate = new Date(Date.UTC(1899, 11, 30));
        const targetDate = new Date(baseDate.getTime() + wholeDays * 24 * 60 * 60 * 1000);

        // 提取年月日（使用UTC方法避免时区转换）
        const year = targetDate.getUTCFullYear();
        const month = String(targetDate.getUTCMonth() + 1).padStart(2, '0');
        const day = String(targetDate.getUTCDate()).padStart(2, '0');

        // 计算时间部分
        const totalMinutes = Math.round(timeFraction * 24 * 60);
        const hours = String(Math.floor(totalMinutes / 60)).padStart(2, '0');
        const minutes = String(totalMinutes % 60).padStart(2, '0');

        return `${year}/${month}/${day} ${hours}:${minutes}`;
    }

    return String(value);
}

// 格式化Date对象为 YYYY/MM/DD HH:mm（用于本地时间）
function formatDate(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    return `${year}/${month}/${day} ${hours}:${minutes}`;
}

// ========== 修复 XLSX 时区偏移问题 ==========
// ExcelJS 将日期视为 UTC 并转换为本地时区（导致 +8 小时偏移）
// 使用 UTC 方法提取原始的年月日时分秒，避免时区转换
// ===========================================
function formatDateAsNaive(date) {
    if (!(date instanceof Date) || isNaN(date.getTime())) {
        return '';
    }
    // 使用 UTC 方法获取"原始"时间值，避免时区转换
    const year = date.getUTCFullYear();
    const month = String(date.getUTCMonth() + 1).padStart(2, '0');
    const day = String(date.getUTCDate()).padStart(2, '0');
    const hours = String(date.getUTCHours()).padStart(2, '0');
    const minutes = String(date.getUTCMinutes()).padStart(2, '0');
    return `${year}/${month}/${day} ${hours}:${minutes}`;
}

// 读取Excel文件 (xlsx格式)
async function parseExcelFile(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = async (e) => {
            try {
                // 使用ExcelJS解析
                const ExcelJS = await loadExcelJS();
                const workbook = new ExcelJS.Workbook();
                await workbook.xlsx.load(e.target.result);

                const worksheet = workbook.worksheets[0];
                if (!worksheet) {
                    reject(new Error('Excel文件为空'));
                    return;
                }

                const data = [];
                const headers = [];

                // 读取表头
                const headerRow = worksheet.getRow(1);
                headerRow.eachCell((cell, colNumber) => {
                    let headerValue = '';
                    if (cell.value && typeof cell.value === 'object' && cell.value.text) {
                        headerValue = cell.value.text;
                    } else {
                        headerValue = String(cell.value || '').trim();
                    }
                    headers[colNumber - 1] = headerValue;
                });

                console.log('[Excel] 表头:', headers);

                // 读取数据行
                worksheet.eachRow((row, rowNumber) => {
                    if (rowNumber === 1) return; // 跳过表头

                    const rowData = {};
                    row.eachCell((cell, colNumber) => {
                        const header = headers[colNumber - 1];
                        if (!header) return;

                        let value = '';
                        const cellValue = cell.value;

                        // 处理超链接
                        if (cell.hyperlink) {
                            value = cell.hyperlink;
                        } else if (cellValue instanceof Date) {
                            // 直接处理Date对象 - 使用 formatDateAsNaive 避免时区转换
                            value = formatDateAsNaive(cellValue);
                        } else if (cellValue && typeof cellValue === 'object') {
                            // 处理富文本或公式
                            if (cellValue.hyperlink) {
                                value = cellValue.hyperlink;
                            } else if (cellValue.text) {
                                value = cellValue.text;
                            } else if (cellValue.formula) {
                                value = '=' + cellValue.formula;
                            } else if (cellValue.result !== undefined) {
                                // 处理公式结果，可能是日期 - 使用 formatDateAsNaive 避免时区转换
                                if (cellValue.result instanceof Date) {
                                    value = formatDateAsNaive(cellValue.result);
                                } else {
                                    value = cellValue.result;
                                }
                            } else {
                                value = String(cellValue);
                            }
                        } else {
                            value = cellValue !== null && cellValue !== undefined ? String(cellValue) : '';
                        }

                        // 对时间相关列进行额外的格式化检查
                        const cleanHeader = cleanColumnName(header);
                        if (cleanHeader.includes('时间') || cleanHeader.includes('日期') || cleanHeader.includes('Time') || cleanHeader.includes('Date')) {
                            value = formatDateValue(value);
                        }

                        rowData[header] = value;
                    });

                    if (Object.keys(rowData).length > 0) {
                        data.push(rowData);
                    }
                });

                console.log('[Excel] 解析完成, 数据行数:', data.length);
                resolve(data);
            } catch (err) {
                reject(err);
            }
        };
        reader.onerror = () => reject(new Error('文件读取失败'));
        reader.readAsArrayBuffer(file);
    });
}

// 动态加载ExcelJS
function loadExcelJS() {
    return new Promise((resolve, reject) => {
        if (window.ExcelJS) {
            resolve(window.ExcelJS);
            return;
        }
        const script = document.createElement('script');
        script.src = chrome.runtime.getURL('exceljs.min.js');
        script.onload = () => {
            if (window.ExcelJS) {
                resolve(window.ExcelJS);
            } else {
                reject(new Error('ExcelJS加载失败'));
            }
        };
        script.onerror = () => reject(new Error('ExcelJS脚本加载失败'));
        document.head.appendChild(script);
    });
}

// 清理列名（去除BOM、不可见字符、多余空格）
function cleanColumnName(name) {
    if (!name) return '';
    return String(name)
        .replace(/^\uFEFF/, '')  // 去除BOM
        .replace(/[\u200B-\u200D\uFEFF\u00A0]/g, '')  // 去除零宽字符和不间断空格
        .replace(/^\s+|\s+$/g, '')  // 去除首尾空格
        .replace(/\s+/g, ' ');  // 多个空格合并为一个
}

// 智能查找商品链接列
function findLinkColumn(data) {
    if (!data || data.length === 0) return null;

    const firstRow = data[0];
    const allKeys = Object.keys(firstRow);

    console.log('[对比] 所有列名:', allKeys);

    // 优先级1: 精确匹配常见列名
    const exactMatches = ['商品链接', '链接', 'URL', 'url', 'Link', 'link', '商品URL', '商品url'];
    for (const key of allKeys) {
        const cleanKey = cleanColumnName(key);
        if (exactMatches.includes(cleanKey)) {
            console.log('[对比] 精确匹配列名:', key, '->', cleanKey);
            return key;
        }
    }

    // 优先级2: 模糊匹配包含关键词的列名
    const fuzzyKeywords = ['链接', 'URL', 'url', 'link', 'Link', 'href', 'HREF'];
    for (const key of allKeys) {
        const cleanKey = cleanColumnName(key);
        for (const kw of fuzzyKeywords) {
            if (cleanKey.includes(kw)) {
                console.log('[对比] 模糊匹配列名:', key, '包含', kw);
                return key;
            }
        }
    }

    // 优先级3: 扫描所有列的值，查找包含goofish.com URL的列
    console.log('[对比] 开始扫描列值查找URL...');
    for (const key of allKeys) {
        // 检查前5行数据
        for (let i = 0; i < Math.min(5, data.length); i++) {
            const cellValue = data[i][key];
            const url = extractUrlFromCell(cellValue);
            if (url && (url.includes('goofish.com') || url.includes('taobao.com'))) {
                console.log('[对比] 从值中发现链接列:', key, '值:', cellValue);
                return key;
            }
        }
    }

    return null;
}

// 对比按钮点击
compareBtn.addEventListener('click', () => {
    if (isCollecting) {
        addLog('❌ 正在采集中，请等待完成', 'error');
        return;
    }

    addLog('📂 请选择之前采集的CSV、Excel或HTML文件...', 'info');
    csvUpload.click();
});

// 文件选择处理
csvUpload.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    // 重置input以便重复选择同一文件
    csvUpload.value = '';

    addLog(`📄 正在解析文件: ${file.name}`, 'info');

    // 提取原文件名（去掉扩展名）
    const originalFileName = file.name.replace(/\.(csv|xlsx?|html)$/i, '');
    const isExcel = /\.xlsx?$/i.test(file.name);
    const isHtml = /\.html?$/i.test(file.name);

    try {
        let fileData;

        if (isHtml) {
            // 🆕 HTML文件使用DOMParser解析
            addLog('📄 检测到HTML文件，正在解析表格...', 'info');
            const text = await file.text();
            fileData = parseHTMLFile(text);
        } else if (isExcel) {
            // Excel文件使用ExcelJS解析
            addLog('📊 检测到Excel文件，正在加载解析器...', 'info');
            fileData = await parseExcelFile(file);
        } else {
            // CSV文件使用文本解析
            const text = await file.text();
            fileData = parseCSV(text);
        }

        if (!fileData || fileData.length === 0) {
            addLog('❌ 文件为空或格式错误', 'error');
            return;
        }

        addLog(`✅ 解析成功，共 ${fileData.length} 条数据`, 'success');

        // 使用智能列查找
        const linkColumn = findLinkColumn(fileData);

        if (!linkColumn) {
            addLog('❌ 未找到商品链接列', 'error');
            addLog('💡 提示: 请确保文件包含"商品链接"列，且其中包含goofish.com的URL', 'info');
            // 打印所有列名帮助调试
            const allCols = Object.keys(fileData[0] || {}).join(', ');
            addLog(`📋 文件包含的列: ${allCols}`, 'info');
            return;
        }

        addLog(`📍 找到链接列: ${linkColumn}`, 'info');

        // 提取每条数据的链接和原始信息
        const items = [];
        for (const row of fileData) {
            const url = extractUrlFromCell(row[linkColumn]);
            if (!url || (!url.includes('goofish.com') && !url.includes('taobao.com'))) continue;

            // 解析原始数据
            const oldWant = parseInt(String(row['想要'] || '0').replace(/[^\d]/g, '')) || 0;
            const oldView = parseInt(String(row['浏览量'] || '0').replace(/[^\d]/g, '')) || 0;
            const oldTime = row['采集时间'] || '';

            // 处理询单率：如果是小数形式(如0.2143)转换为百分比形式(21.43%)
            let oldRate = row['询单率'] || '0%';
            if (oldRate !== null && oldRate !== undefined) {
                const rateStr = String(oldRate).trim();
                // 检查是否是小数形式（无%符号且是数字）
                if (!rateStr.includes('%') && !isNaN(parseFloat(rateStr))) {
                    const rateNum = parseFloat(rateStr);
                    // 如果是小于等于1的小数，认为是比例形式，需要乘以100
                    if (rateNum > 0 && rateNum <= 1) {
                        oldRate = (rateNum * 100).toFixed(2) + '%';
                    } else if (rateNum > 1) {
                        // 已经是百分比数值形式（如21.43），直接加%
                        oldRate = rateNum.toFixed(2) + '%';
                    } else {
                        oldRate = '0%';
                    }
                }
            }

            items.push({
                url: url,
                原标题: row['商品标题'] || row['标题'] || '',  // 🆕 支持两种列名
                原卖家昵称: row['卖家昵称'] || '',
                原想要: oldWant,
                原浏览量: oldView,
                原询单率: oldRate,
                原采集时间: oldTime,
                原价格: row['价格'] || ''
            });
        }

        if (items.length === 0) {
            addLog('❌ 未找到有效的商品链接', 'error');
            return;
        }

        addLog(`🔗 提取到 ${items.length} 个商品链接`, 'success');
        addLog('🚀 开始对比采集...', 'info');

        // 开始对比采集
        isCollecting = true;
        compareBtn.disabled = true;
        mainBtn.disabled = true;
        statusSpan.textContent = '对比采集中';
        if (!messageListener) {
            messageListener = handleMessage;
            chrome.runtime.onMessage.addListener(messageListener);
        }

        // 发送对比采集请求到background，包含原文件名
        chrome.runtime.sendMessage({
            action: 'startCompareCollection',
            items: items,
            originalFileName: originalFileName  // 传递原文件名
        }, (response) => {
            if (chrome.runtime.lastError) {
                addLog(`❌ 启动对比采集失败: ${chrome.runtime.lastError.message}`, 'error');
                isCollecting = false;
                compareBtn.disabled = false;
                mainBtn.disabled = false;
                statusSpan.textContent = '就绪';
            }
        });

    } catch (error) {
        addLog(`❌ 文件解析错误: ${error.message}`, 'error');
        console.error('CSV解析错误:', error);
    }
});

// 处理对比采集完成消息
const originalHandleMessage = handleMessage;
handleMessage = function (message, sender, sendResponse) {
    if (message.type === 'compareComplete') {
        addLog(`✅ 对比采集完成！共 ${message.count} 条数据`, 'success');
        statusSpan.textContent = '对比完成';
        isCollecting = false;
        compareBtn.disabled = false;
        startBtn.disabled = false;
        return;
    }
    return originalHandleMessage(message, sender, sendResponse);
};

