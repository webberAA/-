// background.js - 后台服务 worker
// 版本：V6.7 - API拦截模式 | 处理详情页采集和Excel导出

// ⚠️ 重要：在 Service Worker 启动时加载 ExcelJS（必须在最前面）
// 这是唯一符合 CSP 策略的方法
try {
    console.log('[ExcelJS] 尝试加载本地库...');
    importScripts('./exceljs.min.js');
    console.log('[ExcelJS] ✅ 本地库加载成功');
} catch (e) {
    console.error('[ExcelJS] ❌ 本地库加载失败:', e);
    console.error('[ExcelJS] 请确保 exceljs.min.js 文件存在于插件目录');
}

// Edge浏览器兼容性：确保Service Worker激活
console.log('[Service Worker] ========== 启动中 ==========');
console.log('[Service Worker] 时间:', new Date().toLocaleString());
console.log('[Service Worker] 浏览器:', navigator.userAgent);

// 监听安装事件（Edge需要）
chrome.runtime.onInstalled.addListener((details) => {
    console.log('[Service Worker] 插件已安装/更新:', details.reason);
    console.log('[Service Worker] 版本:', chrome.runtime.getManifest().version);
});

// 监听启动事件（Edge需要）
chrome.runtime.onStartup.addListener(() => {
    console.log('[Service Worker] 扩展启动');
});

// 保持Service Worker活跃（Edge兼容性）
chrome.runtime.onConnect.addListener((port) => {
    console.log('[Service Worker] 连接建立:', port.name);
    port.onDisconnect.addListener(() => {
        console.log('[Service Worker] 连接断开:', port.name);
    });
});

// 定期发送心跳，保持Service Worker活跃（Edge兼容性）
setInterval(() => {
    console.log('[Service Worker] 心跳检测 - 保持活跃状态');
}, 20000); // 每20秒一次

console.log('[Service Worker] ========== 初始化完成 ==========');

// 🆕 存储待修改的文件名（用于 Data URL 下载）
let pendingFilename = null;

// 🆕 监听下载文件名确定事件，用于修复 Data URL 下载时文件名无效的问题
try {
    chrome.downloads.onDeterminingFilename.addListener((downloadItem, suggest) => {
        // 检查是否是我们的下载（Data URL 且有待处理的文件名）
        if (pendingFilename && downloadItem.url.startsWith('data:')) {
            console.log('[文件名修复] 原文件名:', downloadItem.filename, '-> 新文件名:', pendingFilename);
            suggest({ filename: pendingFilename, conflictAction: 'uniquify' });
            pendingFilename = null;  // 清空，只处理一次
            return true;  // 表示已处理
        }
        // 不处理其他下载
    });
} catch (e) {
    // 忽略重复注册错误（多个 Service Worker 实例时会发生）
    console.log('[Service Worker] onDeterminingFilename 监听器已存在或注册失败:', e.message);
}

// 🆕 Service Worker 实例锁（防止多个 Service Worker 实例同时工作）
const WORKER_ID = `worker_${Date.now()}_${Math.random()}`; // 唯一实例ID
let isActiveWorker = false; // 当前实例是否是活跃实例

// 获取工作锁
async function acquireWorkerLock() {
    try {
        const result = await chrome.storage.local.get(['activeWorkerId', 'activeWorkerTime']);
        const now = Date.now();

        // 检查是否有其他实例持有锁
        if (result.activeWorkerId && result.activeWorkerId !== WORKER_ID) {
            // 如果锁超过30秒，认为是死锁，可以抢占
            if (result.activeWorkerTime && (now - result.activeWorkerTime) < 30000) {
                console.log('[实例锁] 其他实例正在工作，本实例待命');
                return false;
            }
        }

        // 获取锁
        await chrome.storage.local.set({
            activeWorkerId: WORKER_ID,
            activeWorkerTime: now
        });

        isActiveWorker = true;
        console.log('[实例锁] ✅ 获取工作锁成功，实例ID:', WORKER_ID);
        return true;
    } catch (e) {
        console.error('[实例锁] 获取锁失败:', e);
        return false;
    }
}

// 释放工作锁
async function releaseWorkerLock() {
    try {
        const result = await chrome.storage.local.get(['activeWorkerId']);
        if (result.activeWorkerId === WORKER_ID) {
            await chrome.storage.local.remove(['activeWorkerId', 'activeWorkerTime']);
            isActiveWorker = false;
            console.log('[实例锁] 🔓 释放工作锁');
        }
    } catch (e) {
        console.error('[实例锁] 释放锁失败:', e);
    }
}

// 定期刷新锁（防止被认为是死锁）
setInterval(async () => {
    if (isActiveWorker) {
        try {
            await chrome.storage.local.set({
                activeWorkerId: WORKER_ID,
                activeWorkerTime: Date.now()
            });
        } catch (e) { }
    }
}, 10000); // 每10秒刷新一次

let isPaused = false;
let currentCollectionTask = null;
let isDetailCollecting = false; // 防止重复采集的锁
let lastCollectionId = null; // 用于去重的采集ID
let forceStopFlag = false;  // 🆕 强制停止标志（彻底停止采集和重试）

// 🆕 验证检测相关变量
let needsVerification = false;  // 是否需要验证
let verificationTabId = null;   // 验证窗口的标签页ID
let failedItems = [];           // 因验证失败的商品队列
let activeTabs = [];            // 当前活跃的采集标签页

// 🆕 采集数据存储（用于自动导出）
let collectedDataInBackground = [];

// 🆕 浏览器通知函数
function showNotification(title, message) {
    try {
        chrome.notifications.create({
            type: 'basic',
            iconUrl: 'icons/icon.png',
            title: title,
            message: message,
            priority: 2,
            requireInteraction: true  // 需要用户手动关闭
        });
    } catch (e) {
        console.warn('[通知] 发送失败:', e);
    }
}

// 🆕 关闭所有采集标签页（保留指定的验证标签页）
async function closeAllTabsExcept(keepTabId) {
    for (const tabId of activeTabs) {
        if (tabId !== keepTabId) {
            try {
                await chrome.tabs.remove(tabId);
            } catch (e) {
                // 标签页可能已关闭
            }
        }
    }
    activeTabs = keepTabId ? [keepTabId] : [];
}

// 🆕 自动检测验证完成（监听验证标签页的更新）
let verificationCheckInterval = null;
let pendingRetryConfig = null;  // 保存待重试的配置

async function startVerificationCheck() {
    if (verificationCheckInterval) return;  // 已经在检测中

    console.log('[验证检测] 开始监控验证标签页...');

    verificationCheckInterval = setInterval(async () => {
        if (!needsVerification || !verificationTabId) {
            clearInterval(verificationCheckInterval);
            verificationCheckInterval = null;
            return;
        }

        try {
            // 检查验证标签页是否存在
            const tab = await new Promise((resolve) => {
                chrome.tabs.get(verificationTabId, (t) => {
                    if (chrome.runtime.lastError) {
                        resolve(null);
                    } else {
                        resolve(t);
                    }
                });
            });

            if (!tab) {
                console.log('[验证检测] 验证标签页已关闭，停止检测');
                clearInterval(verificationCheckInterval);
                verificationCheckInterval = null;
                return;
            }

            // 检查页面是否加载完成
            if (tab.status === 'complete') {
                console.log('[验证检测] 页面加载完成，尝试采集验证...');

                // 尝试在验证页面采集数据
                const result = await new Promise((resolve) => {
                    chrome.scripting.executeScript({
                        target: { tabId: verificationTabId },
                        func: extractDetailMetricsInPage,
                        world: "MAIN"
                    }, (results) => {
                        if (chrome.runtime.lastError || !results || !results[0]) {
                            resolve(null);
                        } else {
                            resolve(results[0].result);
                        }
                    });
                });

                // 检查是否成功获取到浏览量（说明验证通过）
                if (result && result.view && result.view !== "" && result.view !== "0") {
                    console.log('[验证检测] ✅ 验证成功！获取到浏览量:', result.view);

                    // 停止检测
                    clearInterval(verificationCheckInterval);
                    verificationCheckInterval = null;

                    // 发送通知
                    showNotification('✅ 验证成功', '检测到验证已通过，自动继续采集...');

                    chrome.runtime.sendMessage({
                        type: 'log',
                        text: '[验证检测] ✅ 检测到验证已通过，自动继续采集...',
                        level: 'success'
                    });

                    // 关闭验证窗口
                    try {
                        await chrome.tabs.remove(verificationTabId);
                    } catch (e) { }

                    // 重置状态
                    needsVerification = false;
                    isPaused = false;
                    verificationTabId = null;

                    // 自动重试失败的商品
                    if (failedItems.length > 0) {
                        const itemsToRetry = [...failedItems];
                        failedItems = [];

                        chrome.runtime.sendMessage({
                            type: 'log',
                            text: `[验证重试] 🔄 自动重试 ${itemsToRetry.length} 个失败的商品...`,
                            level: 'info'
                        });

                        const retryItems = itemsToRetry.map(f => f.item);
                        processDetailCollection(retryItems, pendingRetryConfig || { detailDelay: 50, useDetailPage: true });
                    }
                }
            }
        } catch (e) {
            console.error('[验证检测] 检测出错:', e);
        }
    }, 3000);  // 每3秒检测一次
}

// =========================
// Excel/CSV 生成
// =========================
function stripEmojisForExport(text) {
    if (text === undefined || text === null) return "";
    const s = String(text);
    // 优先使用 Unicode 属性（现代 Chrome/Edge 支持）
    try {
        // Extended_Pictographic 覆盖绝大多数 emoji；再去掉变体选择符
        return s.replace(/\p{Extended_Pictographic}+/gu, "").replace(/\uFE0F/gu, "").trim();
    } catch (e) {
        // 兜底：只去掉本插件里用到的 emoji
        return s.replace(/[🔥💥📈➡️📉❄️]/g, "").replace(/\uFE0F/g, "").trim();
    }
}

function parseInquiryRateNumber(rateText) {
    if (!rateText) return 0;
    const t = stripEmojisForExport(rateText).replace('%', '').replace('％', '');
    const n = parseFloat(t);
    return isNaN(n) ? 0 : n;
}

function buildHeatText(wantInt, rateNum) {
    // 💥：每 1000 想要 1 个，最多 5 个
    const bombCount = Math.min(5, Math.floor((wantInt || 0) / 1000));
    // 🔥：>15% 1个，>20% 2个，>25% 3个，最多 3 个
    let fireCount = 0;
    if (rateNum > 25) fireCount = 3;
    else if (rateNum > 20) fireCount = 2;
    else if (rateNum > 15) fireCount = 1;

    const bombs = bombCount > 0 ? "💥".repeat(bombCount) : "";
    const fires = fireCount > 0 ? "🔥".repeat(fireCount) : "";
    if (bombs && fires) return `${bombs} ${fires}`;
    return bombs || fires || "";
}

function generateCSVFile(data) {
    if (data.length === 0) return null;

    // 处理数据：计算日均想要；确保字段完整；规范化数值
    const processedData = data.map(item => {
        const processed = { ...item };

        // 确保"询单率"字段（只在字段存在时处理，不添加新字段）
        if ('询单率' in processed) {
            if (!processed.询单率 || processed.询单率 === "" || processed.询单率 === "未获取") {
                if (processed.想要 === "0") {
                    processed.询单率 = "0%";
                } else {
                    processed.询单率 = processed.询单率 || "0%";
                }
            }
        }

        // 规范化浏览量（只在字段存在时处理）
        if ('浏览量' in processed && processed.浏览量 && processed.浏览量 !== "" && processed.浏览量 !== "未获取") {
            const viewInt = parseCountToInt(processed.浏览量);
            processed.浏览量 = viewInt > 0 ? String(viewInt) : "";
        }

        // 规范化想要数：导出时把"x万"转为纯数字（如 3万 -> 30000）
        if (processed.想要 && processed.想要 !== "" && processed.想要 !== "未获取" && processed.想要 !== "0") {
            const wantIntForExport = parseCountToInt(processed.想要);
            processed.想要 = wantIntForExport > 0 ? String(wantIntForExport) : "0";
        }

        // 🆕 计算日均想要 = 想要 / 发布天数（保留1位小数）
        const wantInt = parseCountToInt(processed.想要 || "0");
        const publishDays = parseFloat(processed.发布天数 || "0");
        if (wantInt > 0 && publishDays > 0) {
            processed["日均想要"] = (wantInt / publishDays).toFixed(1);
        } else {
            processed["日均想要"] = "0";
        }

        // 移除旧列（流行/热度已删除）
        if ("状态提醒" in processed) delete processed.状态提醒;
        if ("流行/热度" in processed) delete processed["流行/热度"];

        // 确保"发布时间"字段存在（发布时间如果被删除了，说明可能是不需要的，不过这里保留原逻辑，但加上判断）
        if (!('发布时间' in processed) || processed.发布时间 === undefined || processed.发布时间 === null) {
            processed.发布时间 = "";
        }
        // 发布时间列不允许 emoji
        if ('发布时间' in processed) {
            processed.发布时间 = stripEmojisForExport(processed.发布时间);
        }

        // 询单率列不允许 emoji（只在字段存在时处理）
        if ('询单率' in processed) {
            processed.询单率 = stripEmojisForExport(processed.询单率);
        }

        // 其他列去除 emoji（保留商品链接公式）
        Object.keys(processed).forEach((k) => {
            if (k === "商品链接") return;
            processed[k] = stripEmojisForExport(processed[k]);
        });

        // 重命名"标题"为"商品标题"
        if (processed.标题 !== undefined) {
            processed["商品标题"] = processed.标题;
            delete processed.标题;
        }

        // 强制超链接格式：CSV 中双引号需要转义为双双引号
        if (processed.商品链接) {
            const itemUrl = String(processed.商品链接).trim();
            if (itemUrl && (itemUrl.startsWith('http') || itemUrl.startsWith('https'))) {
                const escapedUrl = itemUrl.replace(/"/g, '""');
                // 正确格式：=HYPERLINK(""链接"",""点击打开"")
                processed.商品链接 = `=HYPERLINK(""${escapedUrl}"",""点击打开"")`;
            }
        }

        return processed;
    });

    // 🆕 按「日均想要」降序排列
    processedData.sort((a, b) => {
        const aVal = parseFloat(a["日均想要"] || "0");
        const bVal = parseFloat(b["日均想要"] || "0");
        return bVal - aVal;  // 降序
    });

    // 新的列顺序（删除流行/热度，新增日均想要）
    const fixedHeaders = [
        "卖家昵称",
        "商品标题",
        "价格",
        "想要",
        "浏览量",
        "询单率",
        "日均想要",
        "发布时间",
        "采集时间",
        "发布天数",
        "商品链接"
    ];

    // 获取数据中的所有字段
    const allFields = Object.keys(processedData[0]);

    // 构建表头：先按固定顺序，然后添加其他字段（如流行程度相关字段）
    const headers = [];

    // 1. 添加固定顺序的字段
    fixedHeaders.forEach(header => {
        if (allFields.includes(header)) {
            headers.push(header);
        }
    });

    // 2. 添加其他字段（如流行程度、浏览量增长等）
    allFields.forEach(field => {
        if (!fixedHeaders.includes(field)) {
            headers.push(field);
        }
    });

    const csvRows = [];

    // 添加表头行（不带BOM，BOM会在最后添加）
    csvRows.push(headers.join(','));

    // 添加数据行
    processedData.forEach(row => {
        const values = headers.map(header => {
            let value = row[header];

            // 处理undefined和null
            if (value === undefined || value === null) {
                value = '';
            }

            const valueStr = String(value);

            // 特殊处理：商品链接列（包含HYPERLINK公式）
            if (header === "商品链接" && valueStr.startsWith('=HYPERLINK(')) {
                // HYPERLINK公式在CSV中必须用双引号包裹
                // 格式："=HYPERLINK(""链接"",""点我查看"")"
                return `"${valueStr}"`;
            }

            // 普通字段处理：转义双引号
            const escapedValue = valueStr.replace(/"/g, '""');
            // 如果包含逗号、双引号、换行符或等号，需要用双引号包裹
            if (escapedValue.includes(',') || escapedValue.includes('"') || escapedValue.includes('\n') || escapedValue.includes('\r') || (escapedValue.includes('=') && !escapedValue.startsWith('='))) {
                return `"${escapedValue}"`;
            }
            return escapedValue;
        });
        csvRows.push(values.join(','));
    });

    // 生成CSV内容（不含BOM）
    const csvContent = csvRows.join('\n');

    // 在Blob创建时添加BOM头，解决Emoji和中文乱码
    // 这是火苗显示的关键
    const blob = new Blob(["\ufeff" + csvContent], {
        type: 'text/csv;charset=utf-8;'
    });

    return blob;
}

// 🆕 生成HTML文件（带图片、完整文案、表格形式，按日均想要降序排列）
// reportTitle: 报告标题（与文件名一致）
function generateHTMLFile(data, reportTitle = '') {
    if (data.length === 0) return null;

    // 处理数据：计算日均想要；确保字段完整；规范化数值
    const processedData = data.map(item => {
        const processed = { ...item };

        // 规范化想要数
        if (processed.想要 && processed.想要 !== "" && processed.想要 !== "未获取" && processed.想要 !== "0") {
            const wantIntForExport = parseCountToInt(processed.想要);
            processed.想要 = wantIntForExport > 0 ? String(wantIntForExport) : "0";
        }

        // 规范化浏览量
        if ('浏览量' in processed && processed.浏览量 && processed.浏览量 !== "" && processed.浏览量 !== "未获取") {
            const viewInt = parseCountToInt(processed.浏览量);
            processed.浏览量 = viewInt > 0 ? String(viewInt) : "";
        }

        // 确保询单率字段
        if ('询单率' in processed) {
            if (!processed.询单率 || processed.询单率 === "" || processed.询单率 === "未获取") {
                processed.询单率 = "0%";
            }
        }

        // 计算日均想要
        const wantInt = parseCountToInt(processed.想要 || "0");
        const publishDays = parseFloat(processed.发布天数 || "0");
        if (wantInt > 0 && publishDays > 0) {
            processed["日均想要"] = (wantInt / publishDays).toFixed(1);
        } else {
            processed["日均想要"] = "0";
        }

        // 移除旧列
        if ("状态提醒" in processed) delete processed.状态提醒;
        if ("流行/热度" in processed) delete processed["流行/热度"];

        // 确保发布时间字段
        if (!('发布时间' in processed) || processed.发布时间 === undefined || processed.发布时间 === null) {
            processed.发布时间 = "";
        }

        // 重命名标题
        if (processed.标题 !== undefined) {
            processed["商品标题"] = processed.标题;
            delete processed.标题;
        }

        return processed;
    });

    // 按日均想要降序排列
    processedData.sort((a, b) => {
        const aVal = parseFloat(a["日均想要"] || "0");
        const bVal = parseFloat(b["日均想要"] || "0");
        return bVal - aVal;
    });

    // 🆕 智能检测快速采集模式：如果所有数据都没有浏览量和询单率字段，说明是快速采集
    const isFastMode = processedData.every(item => !('浏览量' in item) && !('询单率' in item));
    if (isFastMode) {
        console.log('[HTML导出] 检测到快速采集模式，将隐藏浏览量和询单率列');
    }

    // 生成采集时间
    const now = new Date();
    const exportTime = `${now.getFullYear()}/${String(now.getMonth() + 1).padStart(2, '0')}/${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

    // 🆕 报告标题：优先用传入的文件名，否则回退到默认
    const displayTitle = reportTitle ? `🐟 ${reportTitle}` : `🐟 闲鱼采集数据报告`;

    // 转义HTML特殊字符
    const escapeHtml = (text) => {
        if (text === undefined || text === null) return "";
        return String(text)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    };

    // 生成HTML内容
    let html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${displayTitle}</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: 'Microsoft YaHei', '微软雅黑', 'PingFang SC', 'Helvetica Neue', Arial, sans-serif;
            background: linear-gradient(135deg, #f5f7fa 0%, #c3cfe2 100%);
            min-height: 100vh;
            padding: 20px;
        }
        .header {
            text-align: center;
            padding: 30px 20px;
            margin-bottom: 20px;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            border-radius: 16px;
            color: white;
            box-shadow: 0 10px 40px rgba(102, 126, 234, 0.3);
        }
        .header h1 {
            font-size: 28px;
            margin-bottom: 8px;
            text-shadow: 0 2px 4px rgba(0,0,0,0.2);
        }
        .header .subtitle {
            font-size: 14px;
            opacity: 0.85;
        }
        .stats-bar {
            display: flex;
            justify-content: center;
            gap: 30px;
            margin: 15px 0 0;
            padding-top: 15px;
            border-top: 1px solid rgba(255,255,255,0.2);
        }
        .stats-bar .stat-item {
            text-align: center;
        }
        .stats-bar .stat-value {
            font-size: 24px;
            font-weight: bold;
        }
        .stats-bar .stat-label {
            font-size: 12px;
            opacity: 0.8;
        }
        .controls {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 15px;
            padding: 12px 16px;
            background: white;
            border-radius: 12px;
            box-shadow: 0 2px 12px rgba(0,0,0,0.08);
        }
        .controls input {
            padding: 8px 12px;
            border: 2px solid #e2e8f0;
            border-radius: 8px;
            font-size: 14px;
            width: 300px;
            outline: none;
            transition: border-color 0.3s;
        }
        .controls input:focus {
            border-color: #667eea;
        }
        .controls .sort-info {
            font-size: 13px;
            color: #718096;
        }
        .table-container {
            background: white;
            border-radius: 16px;
            overflow: hidden;
            box-shadow: 0 4px 20px rgba(0,0,0,0.08);
        }
        table {
            width: 100%;
            border-collapse: collapse;
            font-size: 13px;
        }
        thead {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            position: sticky;
            top: 0;
            z-index: 10;
        }
        thead th {
            padding: 14px 12px;
            text-align: center;
            font-weight: 600;
            font-size: 13px;
            white-space: nowrap;
            border-right: 1px solid rgba(255,255,255,0.15);
        }
        thead th:last-child { border-right: none; }
        tbody tr {
            border-bottom: 1px solid #f0f0f0;
            transition: all 0.2s;
        }
        tbody tr:hover {
            background: #f8f9ff !important;
            transform: scale(1.002);
            box-shadow: 0 2px 8px rgba(102, 126, 234, 0.1);
        }
        tbody tr:nth-child(even) {
            background: #fafbff;
        }
        td {
            padding: 12px 10px;
            text-align: center;
            vertical-align: middle;
            border-right: 1px solid #f0f0f0;
        }
        td:last-child { border-right: none; }

        /* 序号列 */
        .col-rank {
            width: 40px;
            font-weight: bold;
            color: #667eea;
        }
        .rank-badge {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            width: 28px;
            height: 28px;
            border-radius: 50%;
            font-size: 12px;
            font-weight: bold;
        }
        .rank-1 { background: linear-gradient(135deg, #FFD700, #FFA500); color: white; }
        .rank-2 { background: linear-gradient(135deg, #C0C0C0, #A0A0A0); color: white; }
        .rank-3 { background: linear-gradient(135deg, #CD7F32, #B87333); color: white; }

        /* 封面图列 */
        .col-image { width: 90px; }
        .fast-mode .col-image { width: 120px; }
        .cover-img {
            width: 80px;
            height: 80px;
            object-fit: cover;
            border-radius: 8px;
            border: 2px solid #f0f0f0;
            cursor: pointer;
            transition: transform 0.3s, box-shadow 0.3s;
        }
        .fast-mode .cover-img {
            width: 100px;
            height: 100px;
        }
        .fast-mode .no-img {
            width: 100px;
            height: 100px;
        }
        .cover-img:hover {
            box-shadow: 0 4px 15px rgba(0,0,0,0.2);
            border-color: #667eea;
        }
        .no-img {
            width: 80px;
            height: 80px;
            background: #f5f5f5;
            border-radius: 8px;
            display: flex;
            align-items: center;
            justify-content: center;
            color: #ccc;
            font-size: 11px;
        }

        /* 商品信息列（标题+描述） */
        .col-info {
            text-align: left;
            min-width: 250px;
            max-width: 400px;
        }
        .fast-mode .col-info {
            min-width: 350px;
            max-width: 600px;
        }
        .item-title {
            font-weight: 600;
            color: #2d3748;
            margin-bottom: 6px;
            line-height: 1.5;
        }
        .item-title a {
            color: #2d3748;
            text-decoration: none;
        }
        .item-title a:hover {
            color: #667eea;
            text-decoration: underline;
        }
        .item-desc {
            font-size: 12px;
            color: #718096;
            line-height: 1.5;
            word-break: break-word;
        }

        /* 卖家列 */
        .col-seller {
            min-width: 80px;
            max-width: 120px;
            font-size: 12px;
            color: #4a5568;
        }

        /* 价格列 */
        .col-price {
            font-weight: bold;
            color: #e53e3e;
            white-space: nowrap;
        }

        /* 数值列 */
        .col-num { white-space: nowrap; }
        .want-high { color: #e53e3e; font-weight: bold; }
        .rate-high { background: #e8f5e9 !important; font-weight: bold; color: #2e7d32; }
        .daily-high { background: #fff3e0 !important; font-weight: bold; color: #e65100; }

        /* 时间列 */
        .col-time {
            font-size: 11px;
            color: #718096;
            white-space: nowrap;
        }

        .footer {
            text-align: center;
            padding: 20px;
            color: #a0aec0;
            font-size: 12px;
            margin-top: 20px;
        }

        /* 搜索过滤 */
        .hidden { display: none !important; }

        /* AI弹窗 */
        .ai-overlay {
            position: fixed; top: 0; left: 0; width: 100%; height: 100%;
            background: rgba(0,0,0,0.6); z-index: 9999;
            display: flex; align-items: center; justify-content: center;
        }
        .ai-modal {
            background: white; border-radius: 16px; width: 600px; max-width: 90vw;
            max-height: 80vh; display: flex; flex-direction: column;
            box-shadow: 0 25px 80px rgba(0,0,0,0.3);
            overflow: hidden;
        }
        .ai-modal-header {
            padding: 16px 20px; background: linear-gradient(135deg, #667eea, #764ba2);
            color: white; display: flex; justify-content: space-between; align-items: center;
        }
        .ai-modal-header h3 { margin: 0; font-size: 16px; }
        .ai-modal-close {
            background: none; border: none; color: white; font-size: 20px;
            cursor: pointer; padding: 0 4px; opacity: 0.8;
        }
        .ai-modal-close:hover { opacity: 1; }
        .ai-modal-body {
            padding: 20px; overflow-y: auto; flex: 1;
            line-height: 1.8; font-size: 14px; color: #2d3748;
        }
        .ai-modal-body .ai-loading {
            text-align: center; padding: 40px; color: #a0aec0;
        }
        .ai-modal-body .ai-error {
            color: #e53e3e; background: #fff5f5; padding: 12px; border-radius: 8px;
        }
        .ai-cursor {
            display: inline-block; width: 2px; height: 1.1em;
            background: #667eea; margin-left: 2px; vertical-align: text-bottom;
            animation: blink 0.7s infinite;
        }
        @keyframes blink { 0%,100%{opacity:1} 50%{opacity:0} }
        .ai-modal-wide { width: 900px; max-width: 95vw; max-height: 90vh; }
        .ai-modal-body h2 { color: #667eea; margin: 20px 0 10px; font-size: 18px; border-bottom: 2px solid #eee; padding-bottom: 6px; }
        .ai-modal-body h3 { color: #764ba2; margin: 16px 0 8px; font-size: 16px; }
        .ai-modal-body h4 { color: #667eea; margin: 12px 0 6px; font-size: 14px; }
        .ai-modal-body table { border-collapse: collapse; width: 100%; margin: 10px 0; font-size: 13px; }
        .ai-modal-body th, .ai-modal-body td { border: 1px solid #e2e8f0; padding: 6px 10px; text-align: left; }
        .ai-modal-body th { background: #f7fafc; font-weight: 600; }
        .ai-analyze-btn {
            background: linear-gradient(135deg, #667eea, #764ba2); color: white;
            border: none; border-radius: 8px; padding: 8px 20px; font-size: 14px;
            cursor: pointer; transition: all 0.3s; font-weight: 500; margin-left: 12px;
        }
        .ai-analyze-btn:hover { transform: translateY(-1px); box-shadow: 0 4px 15px rgba(102,126,234,0.4); }
        .ai-analyze-btn:disabled { opacity: 0.6; cursor: wait; transform: none; }
        .ai-header-actions { display:flex; gap:8px; align-items:center; }
        .ai-retry-btn {
            background: linear-gradient(135deg, #f6d365, #fda085); color: #333;
            border: none; border-radius: 6px; padding: 6px 14px; font-size: 13px;
            cursor: pointer; font-weight: 500; transition: all 0.3s;
        }
        .ai-retry-btn:hover { transform: translateY(-1px); box-shadow: 0 3px 10px rgba(253,160,133,0.4); }
        .ai-chat-bar {
            display: flex; gap: 8px; padding: 12px 20px;
            border-top: 1px solid #e2e8f0; background: #f8fafc;
            border-radius: 0 0 16px 16px;
        }
        .ai-chat-input {
            flex: 1; padding: 10px 14px; border: 1px solid #e2e8f0; border-radius: 8px;
            font-size: 14px; outline: none; transition: border 0.3s;
        }
        .ai-chat-input:focus { border-color: #667eea; box-shadow: 0 0 0 3px rgba(102,126,234,0.1); }
        .ai-chat-send {
            background: linear-gradient(135deg, #667eea, #764ba2); color: white;
            border: none; border-radius: 8px; padding: 10px 20px; font-size: 14px;
            cursor: pointer; font-weight: 500; transition: all 0.3s;
        }
        .ai-chat-send:hover { transform: translateY(-1px); box-shadow: 0 3px 10px rgba(102,126,234,0.4); }
        .ai-user-msg {
            background: linear-gradient(135deg, #e8f0fe, #f0e6ff); padding: 10px 14px;
            border-radius: 10px; margin: 12px 0 8px; font-size: 14px;
        }
        .ai-divider { height: 1px; background: #e2e8f0; margin: 8px 0; }
        .ai-answer { margin: 8px 0; }
        .ai-modal-body { max-height: calc(90vh - 130px); overflow-y: auto; }


        @media print {
            body { background: white; padding: 10px; }
            .header { break-inside: avoid; }
            .controls { display: none; }
            .cover-img:hover { transform: none; box-shadow: none; }
            thead { background: #667eea !important; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
        }
    </style>
</head>
<body>
    <div class="header">
        <h1>${displayTitle}</h1>
        <p class="subtitle">导出时间: ${exportTime} | 按日均想要降序排列${isFastMode ? ' | ⚡ 快速采集模式' : ''}</p>
        <div class="stats-bar">
            <div class="stat-item">
                <div class="stat-value">${processedData.length}</div>
                <div class="stat-label">商品总数</div>
            </div>
            <div class="stat-item">
                <div class="stat-value">${processedData.filter(d => parseFloat(d["日均想要"] || "0") > 0).length}</div>
                <div class="stat-label">有效商品</div>
            </div>
            <div class="stat-item">
                <div class="stat-value">${processedData.length > 0 ? parseFloat(processedData[0]["日均想要"] || "0") : 0}</div>
                <div class="stat-label">最高日均想要</div>
            </div>
        </div>
    </div>

    <div class="controls">
        <input type="text" id="searchInput" placeholder="🔍 搜索标题、卖家、描述..." oninput="filterTable(this.value)">
        <span class="sort-info">📊 已按"日均想要"降序排列</span>
        <button id="aiAnalyzeBtn" class="ai-analyze-btn" onclick="callAIAll()">🤖 AI 综合分析</button>
    </div>

    <div class="table-container${isFastMode ? ' fast-mode' : ''}">
        <table>
            <thead>
                <tr>
                    <th>#</th>
                    <th>封面</th>
                    <th>商品信息</th>
                    <th>卖家</th>
                    <th>价格(¥)</th>
                    <th>想要</th>${isFastMode ? '' : `
                    <th>浏览量</th>
                    <th>询单率</th>`}
                    <th>日均想要</th>
                    <th>发布时间</th>
                    <th>采集时间</th>
                    <th>发布天数</th>
                </tr>
            </thead>
            <tbody>`;

    // 生成数据行
    processedData.forEach((item, index) => {
        const rank = index + 1;
        const rankClass = rank <= 3 ? ` rank-${rank}` : '';
        const rankBadge = rank <= 3
            ? `<span class="rank-badge${rankClass}">${rank}</span>`
            : `${rank}`;

        // 封面图（单击放大，双击下载）
        const coverImg = item.封面图 || '';
        const imgHtml = coverImg
            ? `<img class="cover-img" src="${escapeHtml(coverImg)}" alt="封面" loading="lazy" onclick="enlargeImg(this)" ondblclick="downloadImg(this)" onerror="this.outerHTML='<div class=\\'no-img\\'>加载失败</div>'">`
            : `<div class="no-img">暂无图片</div>`;

        // 商品信息（标题 + 描述）
        const title = item.商品标题 || '';
        let desc = item.商品描述 || '';
        const link = item.商品链接 || '';

        // 🔧 最终清洗：过滤掉混入的垃圾描述
        if (desc) {
            const junkFinalCheck = /人想要|累计降价|降价\d+%|[￥¥]\s*\d|^\d+(\.\d+)?$/;
            const provinces = '北京|天津|上海|重庆|河北|山西|辽宁|吉林|黑龙江|江苏|浙江|安徽|福建|江西|山东|河南|湖北|湖南|广东|海南|四川|贵州|云南|陕西|甘肃|青海|内蒙古|广西|西藏|宁夏|新疆';
            const pureProvince = new RegExp(`^(${provinces})(省|市|自治区)?$`);
            const shortProvince = new RegExp(`^(${provinces})`);
            if (junkFinalCheck.test(desc)
                || pureProvince.test(desc.trim())
                || (shortProvince.test(desc.trim()) && desc.trim().length <= 8)
                || desc.trim().length <= 3) {
                desc = '';
            }
        }

        // 🔧 模糊去重：去掉空格和标点后比较，避免仅因空格差异导致重复展示
        if (desc && title) {
            // 去除所有空白符、标点符号，只留纯汉字字母数字来比较
            const normalize = (s) => s.replace(/[\s\u3000，。、；：""''！？·…—\-\[\]【】（）()《》<>,.;:!?'"\/\\|`~@#$%^&*+={}]+/g, '').toLowerCase();
            const dNorm = normalize(desc);
            const tNorm = normalize(title);
            // 完全相同 或 其中一个包含另一个 → 判定为重复
            if (dNorm === tNorm || tNorm.includes(dNorm) || dNorm.includes(tNorm)) {
                desc = '';
            }
        }

        const titleHtml = link
            ? `<a href="${escapeHtml(link)}" target="_blank" title="${escapeHtml(title)}">${escapeHtml(title)}</a>`
            : escapeHtml(title);
        const descHtml = desc ? `<div class="item-desc">${escapeHtml(desc)}</div>` : '';

        // 数值样式
        const wantInt = parseInt(item.想要 || "0");
        const wantClass = wantInt >= 500 ? ' want-high' : '';

        const rateNum = parseFloat(String(item.询单率 || "0").replace('%', ''));
        const rateClass = rateNum > 10 ? ' rate-high' : '';

        const dailyWant = parseFloat(item["日均想要"] || "0");
        const dailyClass = dailyWant > 5 ? ' daily-high' : '';

        html += `
                <tr class="data-row">
                    <td class="col-rank">${rankBadge}</td>
                    <td class="col-image">${imgHtml}</td>
                    <td class="col-info">
                        <div class="item-title">${titleHtml}</div>
                        ${descHtml}
                    </td>
                    <td class="col-seller">${escapeHtml(item.卖家昵称 || '')}</td>
                    <td class="col-price">${escapeHtml(item.价格 || '')}</td>
                    <td class="col-num${wantClass}">${escapeHtml(item.想要 || '0')}</td>${isFastMode ? '' : `
                    <td class="col-num">${escapeHtml(item.浏览量 || '')}</td>
                    <td class="col-num${rateClass}">${escapeHtml(item.询单率 || '0%')}</td>`}
                    <td class="col-num${dailyClass}">${escapeHtml(item["日均想要"] || '0')}</td>
                    <td class="col-time">${escapeHtml(item.发布时间 || '')}</td>
                    <td class="col-time">${escapeHtml(item.采集时间 || '')}</td>
                    <td class="col-time">${escapeHtml(item.发布天数 || '')}</td>
                </tr>`;
    });

    html += `
            </tbody>
        </table>
    </div>

    <div class="footer">
        <p>🐟 闲鱼采集助手 | 共 ${processedData.length} 条数据 | ${exportTime}</p>
    </div>

    <script>
        var AI_CONFIG = { baseUrl: 'http://127.0.0.1:8045/v1/chat/completions', apiKey: 'sk-1658b57979714b219726d76bedffda18', model: 'claude-sonnet-4-5' };
        var ALL_DATA = ${JSON.stringify(processedData.map(function (item, idx) { return { n: idx + 1, t: item.商品标题 || '', p: item.价格 || '', w: item.想要 || '0', dw: item["日均想要"] || '0', v: item.浏览量 || '', d: item.发布天数 || '', desc: (item.商品描述 || '').substring(0, 80) }; }))};
        // ---- AI State ----
        // ---- AI State ----
        var aiCache = null;
        var aiMessages = [];
        var aiGenerating = false;

        function renderMd(t) {
            return t.replace(/\\*\\*(.+?)\\*\\*/g,'<strong>$1</strong>').replace(/\\*(.+?)\\*/g,'<em>$1</em>')
                .replace(/^### (.+)$/gm,'<h4>$1</h4>').replace(/^## (.+)$/gm,'<h3>$1</h3>').replace(/^# (.+)$/gm,'<h2>$1</h2>')
                .replace(/^- (.+)$/gm,'<li>$1</li>').replace(/^\\d+\\. (.+)$/gm,'<li>$1</li>')
                .replace(/\\n{2,}/g,'<br><br>').replace(/\\n/g,'<br>');
        }

        function buildPrompt() {
            var dt='';
            for(var i=0;i<ALL_DATA.length;i++){
                var d=ALL_DATA[i];
                dt+=d.n+'. '+d.t+' | 价格:'+d.p+' | 想要:'+d.w+' | 日均:'+d.dw+' | 浏览:'+(d.v||'-')+' | 天数:'+(d.d||'-')+' | 描述:'+(d.desc||'-')+'\\n';
            }
            return '你是专业的闲鱼电商数据分析师。请根据以下'+ALL_DATA.length+'条数据进行三个维度深度分析。\\n\\n数据:\\n'+dt+'\\n---\\n\\n请严格按以下三板块分析:\\n\\n## 一、商品分布分析\\n对所有商品智能分类归纳(语义聚类):\\n1. 主要/次要/长尾商品类型的名称、数量、占比\\n2. 用表格展示\\n3. 总结赛道特点，哪些竞争激烈，哪些有机会\\n\\n## 二、利润与定价分析\\n1. 价格区间分布(表格)\\n2. 热度与价格关系，最受欢迎价格带\\n3. 引流款识别(低价高想要、含咨询/私聊等词)，预估实际客单价\\n4. 排除引流款后真实均价\\n5. 哪些价格区间存活率最高\\n6. 定价建议(引流价/主力价/利润价)\\n\\n## 三、文案SEO优化\\n1. TOP20高频关键词(标注核心词/长尾词/场景词)\\n2. 想要数最高前5商品的标题和文案特点\\n3. 生成3套可直接粘贴使用的优化文案:\\n   - 不用emoji，不加格式标签(如[标题][描述])\\n   - 每套是完整可直接发布的文字\\n   - 关键词密度要高，核心词和长尾词全覆盖\\n   - 三套风格:专业信任型/场景痛点型/性价比引流型\\n   - 对标表现最好商品深度优化\\n\\n输出要求:结构清晰，数据用表格，百分比保留一位小数，结合实际电商经验。';
        }

        // 智能滚动：判断滚动容器是否处于底部附近
        function isScrollNearBottom(container, threshold) {
            if (!container) return true;
            return container.scrollHeight - container.scrollTop - container.clientHeight < (threshold || 30);
        }
        function smartAutoScroll(container) {
            if (container && isScrollNearBottom(container, 60)) {
                container.scrollTop = container.scrollHeight;
            }
        }

        async function streamChat(el, messages) {
            aiGenerating = true;
            // 找到真正的滚动容器（ai-modal-body），无论 el 是 bodyEl 本身还是其子元素
            var scrollContainer = el.closest ? el.closest('.ai-modal-body') : null;
            if (!scrollContainer) scrollContainer = document.getElementById('aiBody');
            try {
                var r = await fetch(AI_CONFIG.baseUrl, {method:'POST', headers:{'Content-Type':'application/json','Authorization':'Bearer '+AI_CONFIG.apiKey}, body:JSON.stringify({model:AI_CONFIG.model, messages:messages, stream:true})});
                if (!r.ok) throw new Error('API '+r.status);
                var reader=r.body.getReader(), dec=new TextDecoder(), full='', buf='';
                el.innerHTML='';
                while(true) {
                    var ch=await reader.read();
                    if(ch.done) break;
                    buf+=dec.decode(ch.value,{stream:true});
                    var ls=buf.split('\\n');
                    buf=ls.pop();
                    for(var i=0;i<ls.length;i++){
                        var ln=ls[i].trim();
                        if(!ln.startsWith('data:')) continue;
                        var j=ln.slice(5).trim();
                        if(j==='[DONE]') continue;
                        try{
                            var p=JSON.parse(j);
                            var delta=p.choices&&p.choices[0]&&p.choices[0].delta;
                            if(delta&&delta.content){
                                full+=delta.content;
                                el.innerHTML=renderMd(full)+'<span class="ai-cursor"></span>';
                                smartAutoScroll(scrollContainer);
                            }
                        }catch(e){}
                    }
                }
                el.innerHTML=renderMd(full);
                smartAutoScroll(scrollContainer);
                return full;
            } catch(e) { el.innerHTML='<div class="ai-error">❌ '+e.message+'</div>'; return null; }
            finally { aiGenerating = false; }
        }

        function createModal() {
            var ov=document.createElement('div');
            ov.className='ai-overlay';
            ov.id='aiOverlay';
            ov.innerHTML='<div class="ai-modal ai-modal-wide">'
                +'<div class="ai-modal-header">'
                +'<h3>🤖 AI 综合分析报告</h3>'
                +'<div class="ai-header-actions">'
                +'<button class="ai-retry-btn" onclick="retryAI()" title="重新生成">🔄 重试</button>'
                +'<button class="ai-modal-close" onclick="closeAI()">✕</button>'
                +'</div></div>'
                +'<div class="ai-modal-body" id="aiBody"></div>'
                +'<div class="ai-chat-bar">'
                +'<input type="text" id="aiChatInput" class="ai-chat-input" placeholder="输入追问，深入了解数据..." onkeydown="if(event.keyCode===13)sendChat()">'
                +'<button class="ai-chat-send" onclick="sendChat()">发送</button>'
                +'</div></div>';
            document.body.appendChild(ov);
            ov.addEventListener('click',function(e){if(e.target===ov)closeAI();});
            return ov;
        }

        async function callAIAll() {
            var existing = document.getElementById('aiOverlay');
            if (existing) { existing.style.display='flex'; return; }
            var ov = createModal();
            var bodyEl = document.getElementById('aiBody');
            bodyEl.innerHTML='<div class="ai-loading">✨ 正在综合分析所有商品数据，请稍等...</div>';
            var sysPrompt = buildPrompt();
            aiMessages = [{role:'user', content: sysPrompt}];
            var result = await streamChat(bodyEl, aiMessages);
            if (result) { aiCache = result; aiMessages.push({role:'assistant', content: result}); }
        }

        async function retryAI() {
            if (aiGenerating) return;
            var bodyEl = document.getElementById('aiBody');
            if (!bodyEl) return;
            bodyEl.innerHTML='<div class="ai-loading">✨ 正在重新分析...</div>';
            var sysPrompt = buildPrompt();
            aiMessages = [{role:'user', content: sysPrompt}];
            var result = await streamChat(bodyEl, aiMessages);
            if (result) { aiCache = result; aiMessages.push({role:'assistant', content: result}); }
        }

        async function sendChat() {
            if (aiGenerating) return;
            var input = document.getElementById('aiChatInput');
            if (!input || !input.value.trim()) return;
            var q = input.value.trim();
            input.value = '';
            var bodyEl = document.getElementById('aiBody');
            bodyEl.innerHTML += '<div class="ai-user-msg"><strong>你:</strong> '+q+'</div><div class="ai-divider"></div>';
            var ansEl = document.createElement('div');
            ansEl.className='ai-answer';
            bodyEl.appendChild(ansEl);
            smartAutoScroll(bodyEl);
            aiMessages.push({role:'user', content: q});
            var result = await streamChat(ansEl, aiMessages);
            if (result) { aiMessages.push({role:'assistant', content: result}); }
        }

        function closeAI() { var o=document.getElementById('aiOverlay'); if(o) o.style.display='none'; }
        // 🔍 单击放大图片
        function enlargeImg(img) {
            // 创建遮罩层
            const overlay = document.createElement('div');
            overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.85);display:flex;align-items:center;justify-content:center;z-index:9999;cursor:zoom-out;';
            const bigImg = document.createElement('img');
            bigImg.src = img.src;
            bigImg.style.cssText = 'max-width:90vw;max-height:90vh;border-radius:12px;box-shadow:0 20px 60px rgba(0,0,0,0.5);';
            // 提示文字
            const tip = document.createElement('div');
            tip.textContent = '单击关闭 | 双击下载图片';
            tip.style.cssText = 'position:absolute;bottom:30px;color:rgba(255,255,255,0.7);font-size:14px;';
            overlay.appendChild(bigImg);
            overlay.appendChild(tip);
            // 单击遮罩层关闭
            overlay.addEventListener('click', () => overlay.remove());
            // 双击大图下载
            bigImg.addEventListener('dblclick', (e) => {
                e.stopPropagation();
                downloadImg(img);
                overlay.remove();
            });
            document.body.appendChild(overlay);
        }

        // ⬇️ 双击下载图片
        function downloadImg(img) {
            const url = img.src;
            if (!url) return;
            // 从 URL 提取文件名
            const parts = url.split('/');
            let fileName = parts[parts.length - 1] || 'cover.jpg';
            // 去掉查询参数
            fileName = fileName.split('?')[0] || 'cover.jpg';
            if (!fileName.includes('.')) fileName += '.jpg';

            // 使用 fetch 下载（避免跨域问题）
            fetch(url)
                .then(resp => resp.blob())
                .then(blob => {
                    const a = document.createElement('a');
                    a.href = URL.createObjectURL(blob);
                    a.download = fileName;
                    document.body.appendChild(a);
                    a.click();
                    document.body.removeChild(a);
                    URL.revokeObjectURL(a.href);
                })
                .catch(() => {
                    // fetch 失败时直接打开原图
                    window.open(url, '_blank');
                });
        }

        // 🔍 搜索过滤
        function filterTable(keyword) {
            const rows = document.querySelectorAll('.data-row');
            const kw = keyword.toLowerCase().trim();
            rows.forEach(row => {
                if (!kw) {
                    row.classList.remove('hidden');
                    return;
                }
                const text = row.textContent.toLowerCase();
                if (text.includes(kw)) {
                    row.classList.remove('hidden');
                } else {
                    row.classList.add('hidden');
                }
            });
        }
    </script>
</body>
</html>`;

    const blob = new Blob([html], {
        type: 'text/html;charset=utf-8'
    });

    return blob;
}

// 缓存ExcelJS库（避免每次都要下载）
let cachedExcelJS = null;
let isExcelJSLoading = false;
let excelJSLoadPromise = null;

// 加载ExcelJS库（已经在 Service Worker 启动时加载）
async function loadExcelJS() {
    // ExcelJS 已经通过 importScripts 在文件开头加载了
    // 直接返回全局 ExcelJS 对象
    if (typeof ExcelJS !== 'undefined') {
        console.log('[导出] ✅ 使用已加载的 ExcelJS');
        cachedExcelJS = ExcelJS;
        return ExcelJS;
    }

    // 如果没有加载成功，抛出错误
    const error = new Error('ExcelJS 未加载。请确保 exceljs.min.js 文件存在于插件目录，并重新加载插件。');
    console.error('[导出] ❌', error.message);
    throw error;
}

// 解析采集时间（支持多种格式）
function parseCollectionTime(timeStr) {
    if (!timeStr) return new Date();

    try {
        // 格式1: "2025-12-20 01:46:18" (旧版 toLocaleString格式，带年份和秒)
        const match1 = timeStr.match(/(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})\s+(\d{1,2}):(\d{1,2}):(\d{1,2})/);
        if (match1) {
            const [, year, month, day, hour, minute, second] = match1;
            return new Date(parseInt(year), parseInt(month) - 1, parseInt(day), parseInt(hour), parseInt(minute), parseInt(second));
        }

        // 格式1b: "2025/12/26 1:52" (年/月/日 不带秒)
        const match1b = timeStr.match(/(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})\s+(\d{1,2}):(\d{1,2})/);
        if (match1b) {
            const [, year, month, day, hour, minute] = match1b;
            return new Date(parseInt(year), parseInt(month) - 1, parseInt(day), parseInt(hour), parseInt(minute), 0);
        }

        // 格式2: "12-25 17:11" 或 "12/25 17:11" (新版简化格式，不带年份和秒)
        const match2 = timeStr.match(/(\d{1,2})[-\/](\d{1,2})\s+(\d{1,2}):(\d{1,2})/);
        if (match2) {
            const [, month, day, hour, minute] = match2;
            const now = new Date();
            return new Date(now.getFullYear(), parseInt(month) - 1, parseInt(day), parseInt(hour), parseInt(minute), 0);
        }

        // 格式3: ISO格式或其他标准格式
        const date = new Date(timeStr);
        if (!isNaN(date.getTime())) {
            return date;
        }

        return new Date();
    } catch (e) {
        return new Date();
    }
}

// 标准化商品链接（去掉参数，用于匹配）
function normalizeProductUrl(url) {
    if (!url) return "";
    try {
        const urlObj = new URL(url);
        // 保留基础路径和item参数（商品ID）
        const itemId = urlObj.searchParams.get('id');
        if (itemId) {
            return `${urlObj.origin}${urlObj.pathname}?id=${itemId}`;
        }
        return url;
    } catch (e) {
        return url;
    }
}

// 计算流行程度（单位时间内流量增长速度）
function calculatePopularity(currentItem, historyItem) {
    if (!historyItem) {
        return {
            浏览量增长: "",
            想要数增长: "",
            时间差小时: "",
            流行程度: "新商品",
            流行程度数值: "0"
        };
    }

    // 解析数值
    const parseCount = (text) => {
        if (!text || text === "" || text === "未获取") return 0;
        const t = String(text).trim();
        const m = t.match(/(\d+(?:\.\d+)?)\s*万/);
        if (m) {
            return Math.floor(parseFloat(m[1]) * 10000);
        }
        const m2 = t.match(/(\d+)/);
        return m2 ? parseInt(m2[1]) : 0;
    };

    const currentView = parseCount(currentItem.浏览量 || "0");
    const currentWant = parseCount(currentItem.想要 || "0");
    const historyView = parseCount(historyItem.浏览量 || "0");
    const historyWant = parseCount(historyItem.想要 || "0");

    // 计算增长
    const viewGrowth = currentView - historyView;
    const wantGrowth = currentWant - historyWant;

    // 计算时间差（小时）- 使用改进的时间解析
    let timeDiffHours = 0;
    try {
        const currentTime = parseCollectionTime(currentItem.采集时间);
        const historyTime = parseCollectionTime(historyItem.采集时间);
        timeDiffHours = (currentTime - historyTime) / (1000 * 60 * 60); // 转换为小时
        if (timeDiffHours <= 0) timeDiffHours = 0.1; // 最小0.1小时，避免除零
    } catch (e) {
        timeDiffHours = 0.1;
    }

    // 计算流行程度
    // 方法：浏览量增长速度 + 想要数增长速度（想要数权重更高）
    // 流行程度 = (浏览量增长/时间差 + 想要数增长*2/时间差) / 1000，保留2位小数
    let popularity = 0;
    let popularityText = "稳定";

    if (timeDiffHours > 0) {
        const viewSpeed = viewGrowth / timeDiffHours; // 每小时浏览量增长
        const wantSpeed = wantGrowth / timeDiffHours; // 每小时想要数增长

        // 综合计算：浏览量权重0.4，想要数权重0.6（想要数更能反映热度）
        popularity = (viewSpeed * 0.4 + wantSpeed * 1.5) / 1000;

        if (popularity > 10) {
            popularityText = "🔥🔥🔥 爆火";
        } else if (popularity > 5) {
            popularityText = "🔥🔥 热门";
        } else if (popularity > 2) {
            popularityText = "🔥 上升";
        } else if (popularity > 0.5) {
            popularityText = "📈 增长";
        } else if (popularity > -0.5) {
            popularityText = "➡️ 稳定";
        } else if (popularity > -2) {
            popularityText = "📉 下降";
        } else {
            popularityText = "❄️ 冷门";
        }
    }

    return {
        浏览量增长: viewGrowth > 0 ? `+${viewGrowth}` : viewGrowth.toString(),
        想要数增长: wantGrowth > 0 ? `+${wantGrowth}` : wantGrowth.toString(),
        时间差小时: timeDiffHours.toFixed(1) + "小时",
        流行程度: popularityText,
        流行程度数值: popularity.toFixed(2)
    };
}

// 导出函数：根据参数选择生成CSV或HTML文件
async function generateExcelFile(data, exportHtml = false, reportTitle = '') {
    if (exportHtml) {
        console.log('[导出] ========== 开始生成HTML文件 ==========');
        console.log('[导出] 数据条数:', data?.length);
        return generateHTMLFile(data, reportTitle);
    }

    console.log('[导出] ========== 开始生成CSV文件 ==========');
    console.log('[导出] 数据条数:', data?.length);

    // 直接使用CSV格式导出，更稳定可靠
    return generateCSVFile(data);
}

// ========== 以下是原ExcelJS代码（已禁用）==========
// 改用CSV格式后，此段代码不再执行
async function _oldExcelCode_disabled() {
    try {
        const historyResult = chrome.storage.local.get(['exportHistory']);
        const historyData = historyResult.exportHistory || [];

        // 处理数据：添加流行程度计算、确保“发布时间”字段，并应用导出展示规则（emoji 仅允许出现在“流行/热度”列）
        const processedData = data.map(item => {
            const processed = { ...item };
            // 确保"想要"字段：如果为空、未定义或"未获取"，改为"0"
            if (!processed.想要 || processed.想要 === "" || processed.想要 === "未获取" || processed.想要.trim() === "") {
                processed.想要 = "0";
            }
            // 确保"询单率"字段：如果"想要"为0，询单率也应该是"0%"
            if (processed.想要 === "0" && (!processed.询单率 || processed.询单率 === "" || processed.询单率 === "未获取")) {
                processed.询单率 = "0%";
            }

            // 询单率数值（不改动询单率列文本）
            const rateNum = parseInquiryRateNumber(processed.询单率 || "0%");
            const wantInt = parseCountToInt(processed.想要 || "0");
            processed["流行/热度"] = buildHeatText(wantInt, rateNum);
            if ("状态提醒" in processed) delete processed.状态提醒;

            // 确保“发布时间”字段存在（列表页可采集到；详情页可能为空）
            if (processed.发布时间 === undefined || processed.发布时间 === null) {
                processed.发布时间 = "";
            }

            // 规范化浏览量：导出时把“x万”转为纯数字（如 1万 -> 10000）
            if (processed.浏览量 && processed.浏览量 !== "" && processed.浏览量 !== "未获取") {
                const viewInt = parseCountToInt(processed.浏览量);
                processed.浏览量 = viewInt > 0 ? String(viewInt) : "";
            }

            // 规范化想要数：导出时把"x万"转为纯数字（如 3万 -> 30000）
            if (processed.想要 && processed.想要 !== "" && processed.想要 !== "未获取" && processed.想要 !== "0") {
                const wantIntForExport = parseCountToInt(processed.想要);
                processed.想要 = wantIntForExport > 0 ? String(wantIntForExport) : "0";
            }

            // 其他列禁止 emoji（包括：询单率、发布时间、流行程度等）
            processed.询单率 = stripEmojisForExport(processed.询单率);
            processed.发布时间 = stripEmojisForExport(processed.发布时间);
            Object.keys(processed).forEach((k) => {
                if (k === "流行/热度" || k === "商品链接") return;
                processed[k] = stripEmojisForExport(processed[k]);
            });

            // 查找历史数据（根据商品链接匹配，支持标准化匹配）
            const currentUrl = processed.商品链接 || "";
            const normalizedCurrentUrl = normalizeProductUrl(currentUrl);

            // 先尝试精确匹配
            let historyItem = historyData.find(h => {
                const historyUrl = h.商品链接 || "";
                return historyUrl === currentUrl || normalizeProductUrl(historyUrl) === normalizedCurrentUrl;
            });

            // 如果没找到，尝试通过商品ID匹配（从URL中提取id参数）
            if (!historyItem && normalizedCurrentUrl) {
                try {
                    const currentUrlObj = new URL(currentUrl);
                    const currentItemId = currentUrlObj.searchParams.get('id');
                    if (currentItemId) {
                        historyItem = historyData.find(h => {
                            try {
                                const hUrlObj = new URL(h.商品链接 || "");
                                return hUrlObj.searchParams.get('id') === currentItemId;
                            } catch (e) {
                                return false;
                            }
                        });
                    }
                } catch (e) {
                    // URL解析失败，忽略
                }
            }

            // 计算流行程度
            const popularity = calculatePopularity(processed, historyItem);
            processed.浏览量增长 = popularity.浏览量增长;
            processed.想要数增长 = popularity.想要数增长;
            processed.时间差 = popularity.时间差小时;
            processed.流行程度 = popularity.流行程度;
            processed.流行程度数值 = popularity.流行程度数值;

            return processed;
        });

        // 验证字段是否添加成功
        if (processedData.length > 0) {
            const firstItem = processedData[0];
            console.log('[导出] 处理后的第一条数据字段:', Object.keys(firstItem));
            console.log('[导出] 流行程度字段值:', {
                浏览量增长: firstItem.浏览量增长,
                想要数增长: firstItem.想要数增长,
                时间差: firstItem.时间差,
                流行程度: firstItem.流行程度,
                流行程度数值: firstItem.流行程度数值
            });
        }

        // 确保所有数据都包含必需字段
        const requiredFields = ['浏览量增长', '想要数增长', '时间差', '流行程度', '流行程度数值'];
        processedData.forEach(item => {
            requiredFields.forEach(field => {
                if (!(field in item)) {
                    item[field] = field === '流行程度' ? '新商品' : (field === '流行程度数值' ? '0' : '');
                }
            });
        });

        // 创建新的工作簿
        const workbook = new ExcelJS.Workbook();
        const worksheet = workbook.addWorksheet('采集结果');

        // 按照指定顺序排列表头：卖家昵称、标题、价格、想要、浏览量、询单率、流行/热度、发布时间、商品链接、采集时间
        // 定义固定顺序的表头（卖家昵称在第一列）
        const fixedHeaders = [
            "卖家昵称",
            "标题",
            "价格",
            "想要",
            "浏览量",
            "询单率",
            "发布时间",
            "商品链接",
            "采集时间"
        ];

        // 获取数据中的所有字段
        const allFields = Object.keys(processedData[0]);

        // 构建表头：先按固定顺序，然后添加其他字段（如流行程度相关字段）
        const headers = [];

        // 1. 添加固定顺序的字段
        fixedHeaders.forEach(header => {
            if (allFields.includes(header)) {
                headers.push(header);
            }
        });

        // 2. 添加其他字段（如流行程度、浏览量增长等）
        allFields.forEach(field => {
            if (!fixedHeaders.includes(field)) {
                headers.push(field);
            }
        });

        const 询单率列索引 = headers.indexOf("询单率");
        const 商品链接列索引 = headers.indexOf("商品链接");
        const 流行程度列索引 = headers.indexOf("流行程度");
        const 想要列索引 = headers.indexOf("想要");
        const 价格列索引 = headers.indexOf("价格");

        // 设置表头
        // ExcelJS中，width单位是字符宽度，1厘米 ≈ 2.54个字符宽度
        // 5厘米 ≈ 12.7个字符宽度
        // 标题列：4.8厘米 ≈ 12.2个字符宽度
        // 采集时间列：3.6厘米 ≈ 9.1个字符宽度
        worksheet.columns = headers.map(header => ({
            header: header,
            key: header,
            width: header === "商品链接" ? 12.7 :  // 5cm
                header === "价格" ? 12.7 :      // 5cm
                    header === "卖家昵称" ? 20 :
                        header === "标题" ? 12.2 :
                            header === "采集时间" ? 9.1 :
                                header === "发布时间" ? 12 :
                                    header === "流行程度" ? 15 :
                                        header === "浏览量增长" ? 15 :
                                            header === "想要数增长" ? 15 :
                                                header === "状态提醒" ? 12 : 15
        }));

        // 设置表头样式
        worksheet.getRow(1).font = { bold: true };
        worksheet.getRow(1).fill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: { argb: 'FFE0E0E0' }
        };

        // 添加数据行
        processedData.forEach((item, rowIndex) => {
            // 按照headers顺序创建行数据
            const rowData = headers.map(header => item[header] || "");
            const row = worksheet.addRow(rowData);
            const rowNumber = rowIndex + 2; // +2因为第1行是表头

            // ========== 询单率列：渐变浅绿色 ==========
            // 使用浅色背景+黑色文字，确保数据清晰可见
            if (询单率列索引 >= 0) {
                const 询单率值 = item.询单率 || "";
                const 询单率数字 = parseFloat(String(询单率值).replace('%', '').replace('％', '').replace('％', ''));

                if (!isNaN(询单率数字) && 询单率数字 > 0) {
                    const cell = worksheet.getCell(rowNumber, 询单率列索引 + 1);
                    let bgColor = 'FFE8F5E9'; // 默认最淡绿色

                    // 根据询单率选择浅绿色深度 (都是浅色系)
                    if (询单率数字 > 15) {
                        bgColor = 'FFA5D6A7'; // 稍深的浅绿 (Material Green 200)
                    } else if (询单率数字 > 10) {
                        bgColor = 'FFC8E6C9'; // 浅绿 (Material Green 100)
                    } else if (询单率数字 > 5) {
                        bgColor = 'FFDCEDC8'; // 更浅的绿 (Material Light Green 100)
                    } else {
                        bgColor = 'FFE8F5E9'; // 最淡绿色 (Material Green 50)
                    }

                    cell.fill = {
                        type: 'pattern',
                        pattern: 'solid',
                        fgColor: { argb: bgColor }
                    };

                    // 始终使用黑色文字
                    cell.font = {
                        bold: true,
                        color: { argb: 'FF000000' },
                        size: 11
                    };
                    cell.alignment = {
                        horizontal: 'center',
                        vertical: 'middle'
                    };
                    cell.value = 询单率值;
                }
            }

            // ========== 想要数列：渐变浅红色 ==========
            // 使用浅色背景+黑色文字，确保数据清晰可见
            if (想要列索引 >= 0) {
                const 想要值 = item.想要 || "";
                const 想要数字 = parseCountToInt(想要值);

                if (想要数字 > 500) {
                    const cell = worksheet.getCell(rowNumber, 想要列索引 + 1);
                    let bgColor = 'FFFFEBEE'; // 默认最淡红色

                    // 根据想要数选择浅红色深度 (都是浅色系)
                    if (想要数字 > 5000) {
                        bgColor = 'FFEF9A9A'; // 稍深的浅红 (Material Red 200)
                    } else if (想要数字 > 2000) {
                        bgColor = 'FFFFCDD2'; // 浅红 (Material Red 100)
                    } else if (想要数字 > 1000) {
                        bgColor = 'FFFFEBEE'; // 更浅的红 (Material Red 50)
                    } else {
                        bgColor = 'FFFFF3E0'; // 最淡橙红 (Material Orange 50)
                    }

                    cell.fill = {
                        type: 'pattern',
                        pattern: 'solid',
                        fgColor: { argb: bgColor }
                    };

                    // 始终使用黑色文字
                    cell.font = {
                        bold: true,
                        color: { argb: 'FF000000' },
                        size: 11
                    };
                    cell.alignment = {
                        horizontal: 'center',
                        vertical: 'middle'
                    };
                    cell.value = 想要值;
                }
            }

            // 处理“流行/热度”列：仅此列允许 emoji，并做醒目样式
            if (热度列索引 >= 0) {
                const 热度值 = item["流行/热度"] || "";
                if (热度值) {
                    const cell = worksheet.getCell(rowNumber, 热度列索引 + 1);
                    cell.value = 热度值;
                    cell.fill = {
                        type: 'pattern',
                        pattern: 'solid',
                        fgColor: { argb: 'FFFF6600' }  // 橙色背景
                    };
                    cell.font = {
                        bold: true,
                        color: { argb: 'FFFFFFFF' },  // 白色文字
                        size: 11
                    };
                    cell.alignment = {
                        horizontal: 'center',
                        vertical: 'middle'
                    };
                }
            }

            // 处理商品链接列：写入真正的超链接（显示“点击打开”），避免不同表格软件对公式兼容性差导致“点了没反应”
            if (商品链接列索引 >= 0) {
                const linkUrl = item.商品链接 || "";
                if (linkUrl && (linkUrl.startsWith('http') || linkUrl.startsWith('https'))) {
                    const cell = worksheet.getCell(rowNumber, 商品链接列索引 + 1);
                    const safeUrl = String(linkUrl).trim();
                    // ExcelJS 标准超链接写法：{ text, hyperlink }（比公式更稳定）
                    // 少数环境若不支持该对象写法，则回退到 HYPERLINK 公式（并写入 result，避免显示空白）
                    try {
                        cell.value = { text: "点击打开", hyperlink: safeUrl };
                    } catch (e) {
                        const escaped = safeUrl.replace(/"/g, '""');
                        cell.value = { formula: `HYPERLINK("${escaped}", "点击打开")`, result: "点击打开" };
                    }
                    cell.tooltip = safeUrl;
                    cell.font = { color: { argb: 'FF0000FF' }, underline: true };
                    cell.alignment = { horizontal: 'center', vertical: 'middle' };
                }
            }

            // 处理流行程度列：根据数值设置颜色
            if (流行程度列索引 >= 0) {
                const 流行程度值 = item.流行程度 || "";
                const 流行程度数值 = parseFloat(item.流行程度数值 || "0");

                if (!isNaN(流行程度数值)) {
                    const cell = worksheet.getCell(rowNumber, 流行程度列索引 + 1);

                    // 根据流行程度设置颜色
                    if (流行程度数值 > 5) {
                        // 爆火/热门：红色背景
                        cell.fill = {
                            type: 'pattern',
                            pattern: 'solid',
                            fgColor: { argb: 'FFFF0000' }  // 红色
                        };
                        cell.font = {
                            bold: true,
                            color: { argb: 'FFFFFFFF' },  // 白色
                            size: 11
                        };
                    } else if (流行程度数值 > 2) {
                        // 上升：橙色背景
                        cell.fill = {
                            type: 'pattern',
                            pattern: 'solid',
                            fgColor: { argb: 'FFFF8800' }  // 橙色
                        };
                        cell.font = {
                            bold: true,
                            color: { argb: 'FFFFFFFF' },  // 白色
                            size: 11
                        };
                    } else if (流行程度数值 > 0.5) {
                        // 增长：黄色背景
                        cell.fill = {
                            type: 'pattern',
                            pattern: 'solid',
                            fgColor: { argb: 'FFFFFF00' }  // 黄色
                        };
                        cell.font = {
                            bold: true,
                            color: { argb: 'FF000000' },  // 黑色
                            size: 11
                        };
                    }

                    cell.alignment = {
                        horizontal: 'center',
                        vertical: 'middle'
                    };
                }
            }
        });

        // 生成Excel文件 - 确保样式被写入
        const buffer = await workbook.xlsx.writeBuffer({
            useStyles: true,
            useSharedStrings: true
        });
        console.log('[导出] ✅ Excel文件生成成功，大小:', buffer.byteLength, '字节');
        return new Blob([buffer], {
            type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
        });
    } catch (error) {
        console.error('[导出] ❌❌❌ Excel生成失败，回退到CSV ❌❌❌');
        console.error('[导出] 错误类型:', error.name);
        console.error('[导出] 错误信息:', error.message);
        console.error('[导出] 错误堆栈:', error.stack);

        // 发送日志到popup（如果可能）
        try {
            chrome.runtime.sendMessage({
                type: 'log',
                text: `⚠️ Excel生成失败，使用CSV格式。错误: ${error.message}`,
                level: 'error'
            });
        } catch (e) { }

        return generateCSVFile(data);
    }
}

// =========================
// 详情页采集（通过新标签页）- 带重试机制
// =========================
// 处理已创建的标签页的采集（用于并发采集）
async function processTabCollection(tab, item, detailDelay, itemIndex = null, total = null, retryCount = 0) {
    const MAX_RETRIES = 2; // 最多重试2次
    const logPrefix = itemIndex && total ? `[${itemIndex}/${total}]` : '[详情页]';

    // 🆕 检查强制停止标志
    if (forceStopFlag) {
        console.log(`${logPrefix} 🛑 检测到强制停止标志，跳过采集`);
        // 关闭已打开的标签页
        try {
            chrome.tabs.remove(tab.id);
        } catch (e) { }
        return Promise.reject(new Error('采集已被强制停止'));
    }

    return new Promise((resolve, reject) => {
        const attemptCollection = () => {
            if (retryCount > 0) {
                chrome.runtime.sendMessage({
                    type: 'log',
                    text: `${logPrefix} 重试采集 (第${retryCount}次): ${item.标题.substring(0, 30)}...`,
                    level: 'info'
                });
            } else {
                chrome.runtime.sendMessage({
                    type: 'log',
                    text: `${logPrefix} 等待页面加载: ${item.标题.substring(0, 30)}...`,
                    level: 'info'
                });
            }

            let checkCount = 0;
            const maxChecks = 300; // 最多等待150秒（增加检查次数）

            // 等待页面加载 - 极限优化：最小检查间隔
            const checkComplete = () => {
                if (isPaused) {
                    // 如果暂停，等待恢复
                    setTimeout(checkComplete, 100);
                    return;
                }

                checkCount++;
                if (checkCount > maxChecks) {
                    chrome.tabs.remove(tab.id);
                    const error = new Error('页面加载超时');

                    // 如果还有重试次数，进行重试
                    if (retryCount < MAX_RETRIES) {
                        // 🆕 检查强制停止标志
                        if (forceStopFlag) {
                            reject(new Error('采集已被强制停止'));
                            return;
                        }

                        chrome.runtime.sendMessage({
                            type: 'log',
                            text: `${logPrefix} ⚠️ 页面加载超时，准备重试 (${retryCount + 1}/${MAX_RETRIES})...`,
                            level: 'error'
                        });

                        // 等待1秒后重试
                        setTimeout(() => {
                            // 🆕 再次检查强制停止标志
                            if (forceStopFlag) {
                                reject(new Error('采集已被强制停止'));
                                return;
                            }

                            // 重新创建标签页并重试
                            chrome.tabs.create({
                                url: item.商品链接,
                                active: false
                            }, (newTab) => {
                                if (chrome.runtime.lastError) {
                                    reject(new Error('重试时无法创建标签页: ' + chrome.runtime.lastError.message));
                                    return;
                                }
                                // 递归调用，增加重试计数
                                processTabCollection(newTab, item, detailDelay, itemIndex, total, retryCount + 1)
                                    .then(resolve)
                                    .catch(reject);
                            });
                        }, 1000);
                        return;
                    }

                    reject(error);
                    return;
                }

                chrome.tabs.get(tab.id, (tabInfo) => {
                    if (chrome.runtime.lastError) {
                        const error = new Error('标签页已关闭');

                        // 如果还有重试次数，进行重试
                        if (retryCount < MAX_RETRIES) {
                            // 🆕 检查强制停止标志
                            if (forceStopFlag) {
                                reject(new Error('采集已被强制停止'));
                                return;
                            }

                            chrome.runtime.sendMessage({
                                type: 'log',
                                text: `${logPrefix} ⚠️ 标签页已关闭，准备重试 (${retryCount + 1}/${MAX_RETRIES})...`,
                                level: 'error'
                            });

                            // 等待1秒后重试
                            setTimeout(() => {
                                // 🆕 再次检查强制停止标志
                                if (forceStopFlag) {
                                    reject(new Error('采集已被强制停止'));
                                    return;
                                }

                                // 重新创建标签页并重试
                                chrome.tabs.create({
                                    url: item.商品链接,
                                    active: false
                                }, (newTab) => {
                                    if (chrome.runtime.lastError) {
                                        reject(new Error('重试时无法创建标签页: ' + chrome.runtime.lastError.message));
                                        return;
                                    }
                                    // 递归调用，增加重试计数
                                    processTabCollection(newTab, item, detailDelay, itemIndex, total, retryCount + 1)
                                        .then(resolve)
                                        .catch(reject);
                                });
                            }, 1000);
                            return;
                        }

                        reject(error);
                        return;
                    }

                    if (tabInfo.status === 'complete') {
                        // 页面加载完成，立即提取数据（极限速度：最小延迟）
                        // 使用最小延迟（30ms）确保DOM渲染完成
                        setTimeout(() => {
                            // 注入脚本提取数据 - 🔧 必须在 MAIN 世界执行才能访问 API 拦截数据！
                            chrome.scripting.executeScript({
                                target: { tabId: tab.id },
                                func: extractDetailMetricsInPage,
                                world: "MAIN"  // 🆕 关键！在 MAIN 世界执行，才能读取 window.__GOOFISH_DETAIL_API_DATA__
                            }, (results) => {
                                // 立即关闭标签页（采集完成后自动关闭）
                                chrome.tabs.remove(tab.id, () => { });

                                if (chrome.runtime.lastError) {
                                    const error = new Error('脚本执行失败: ' + chrome.runtime.lastError.message);

                                    // 如果还有重试次数，进行重试
                                    if (retryCount < MAX_RETRIES) {
                                        // 🆕 检查强制停止标志
                                        if (forceStopFlag) {
                                            reject(new Error('采集已被强制停止'));
                                            return;
                                        }

                                        chrome.runtime.sendMessage({
                                            type: 'log',
                                            text: `${logPrefix} ⚠️ 脚本执行失败，准备重试 (${retryCount + 1}/${MAX_RETRIES}): ${chrome.runtime.lastError.message}`,
                                            level: 'error'
                                        });

                                        // 等待1秒后重试
                                        setTimeout(() => {
                                            // 🆕 再次检查强制停止标志
                                            if (forceStopFlag) {
                                                reject(new Error('采集已被强制停止'));
                                                return;
                                            }

                                            // 重新创建标签页并重试
                                            chrome.tabs.create({
                                                url: item.商品链接,
                                                active: false
                                            }, (newTab) => {
                                                if (chrome.runtime.lastError) {
                                                    reject(new Error('重试时无法创建标签页: ' + chrome.runtime.lastError.message));
                                                    return;
                                                }
                                                // 递归调用，增加重试计数
                                                processTabCollection(newTab, item, detailDelay, itemIndex, total, retryCount + 1)
                                                    .then(resolve)
                                                    .catch(reject);
                                            });
                                        }, 1000);
                                        return;
                                    }

                                    reject(error);
                                    return;
                                }

                                if (!results || !results[0] || !results[0].result) {
                                    const error = new Error('提取结果为空');

                                    // 如果还有重试次数，进行重试
                                    if (retryCount < MAX_RETRIES) {
                                        chrome.runtime.sendMessage({
                                            type: 'log',
                                            text: `${logPrefix} ⚠️ 提取结果为空，准备重试 (${retryCount + 1}/${MAX_RETRIES})...`,
                                            level: 'error'
                                        });

                                        // 等待1秒后重试
                                        setTimeout(() => {
                                            // 重新创建标签页并重试
                                            chrome.tabs.create({
                                                url: item.商品链接,
                                                active: false
                                            }, (newTab) => {
                                                if (chrome.runtime.lastError) {
                                                    reject(new Error('重试时无法创建标签页: ' + chrome.runtime.lastError.message));
                                                    return;
                                                }
                                                // 递归调用，增加重试计数
                                                processTabCollection(newTab, item, detailDelay, itemIndex, total, retryCount + 1)
                                                    .then(resolve)
                                                    .catch(reject);
                                            });
                                        }, 1000);
                                        return;
                                    }

                                    reject(error);
                                    return;
                                }

                                // 成功提取数据
                                if (retryCount > 0) {
                                    chrome.runtime.sendMessage({
                                        type: 'log',
                                        text: `${logPrefix} ✅ 重试成功！`,
                                        level: 'success'
                                    });
                                }

                                resolve(results[0].result);
                            });
                        }, Math.max(30, detailDelay)); // 极限优化：最小30ms延迟
                    } else {
                        // 极限优化：检查间隔减少到50ms（最快检测）
                        setTimeout(checkComplete, 50);
                    }
                });
            };

            // 极限优化：立即开始检查，最小延迟100ms
            setTimeout(checkComplete, 100);
        };

        attemptCollection();
    });
}

// 在详情页中执行的提取函数（异步，支持等待 API 数据）
async function extractDetailMetricsInPage() {
    // =========================
    // 轮询等待 API 数据（最多 1.5 秒，通常 API 返回很快）
    // =========================
    let apiData = null;
    for (let i = 0; i < 15; i++) {  // 15 * 100ms = 1.5秒
        apiData = window.__GOOFISH_DETAIL_API_DATA__;
        if (apiData && apiData.browseCnt !== undefined) {
            console.log('[详情页] ✅ API 数据已就绪，等待了', i * 100, 'ms');
            break;
        }
        await new Promise(r => setTimeout(r, 100));
    }
    if (!apiData) {
        console.log('[详情页] ⚠️ 等待超时，将使用 DOM 解析');
    }

    function cleanOneLine(s) {
        if (!s) return "";
        return s.replace(/\r/g, " ").replace(/\n/g, " ").replace(/\t/g, " ")
            .replace(/\s+/g, " ").trim();
    }

    function normalizePriceText(t) {
        if (!t) return "";
        return t.replace(/\r/g, "").replace(/\n/g, "").replace(/ /g, "").replace("￥", "¥");
    }

    function parsePriceText(t) {
        t = normalizePriceText(t);
        if (!t) return "";
        const rangeMatch = t.match(/(\d+(?:\.\d+)?)\s*[-~—～至到]\s*(\d+(?:\.\d+)?)/);
        if (rangeMatch) {
            return `${rangeMatch[1]}-${rangeMatch[2]}`;
        }
        const numMatch = t.match(/(\d+(?:\.\d+)?)/);
        return numMatch ? numMatch[1] : "";
    }

    function parseWantFromText(t) {
        t = cleanOneLine(t);
        if (!t) return "";

        // 更精确的匹配：必须包含"人想要"三个字，且前面是数字
        // 确保匹配的是完整的"人想要"，不是其他包含"想要"的文本

        // 优先匹配"万"单位：例如 "1.5万 人想要"
        const m = t.match(/(\d+(?:\.\d+)?)\s*万\s*人想要/);
        if (m) {
            let num = m[1];
            if (num.endsWith(".0")) num = num.slice(0, -2);
            return num + "万";
        }

        // 匹配普通数字，但必须紧跟着"人想要"：例如 "15 人想要"
        // 使用单词边界确保不会误匹配
        const m2 = t.match(/(\d+)\s*人想要/);
        if (m2) {
            // 验证：确保匹配的是"人想要"，不是其他文本
            const matchedText = m2[0];
            if (matchedText.includes("人想要")) {
                return m2[1];
            }
        }

        // 如果都没有匹配到，返回空字符串（表示没有"想要"数据）
        return "";
    }

    function parseViewFromText(t) {
        t = cleanOneLine(t);
        if (!t) return "";
        const m = t.match(/(\d+(?:\.\d+)?)\s*万\s*浏览/);
        if (m) {
            const num = Math.floor(parseFloat(m[1]) * 10000);
            if (num >= 10000) {
                const v = num / 10000.0;
                let s = v.toFixed(1);
                if (s.endsWith(".0")) s = s.slice(0, -2);
                return s + "万";
            }
            return String(num);
        }
        const m2 = t.match(/(\d+)\s*浏览/);
        if (m2) {
            const num = parseInt(m2[1]);
            if (num >= 10000) {
                const v = num / 10000.0;
                let s = v.toFixed(1);
                if (s.endsWith(".0")) s = s.slice(0, -2);
                return s + "万";
            }
            return String(num);
        }
        return "";
    }

    let bodyText = "";
    try {
        bodyText = cleanOneLine(document.body.innerText || "");
    } catch (e) {
        bodyText = "";
    }

    // =========================
    // 使用轮询获取的 API 数据（已在函数开头等待）
    // =========================
    let price = "";
    let want = "";
    let view = "";
    let publishTime = "";  // 新增发布时间
    let apiCoverImage = "";   // 🆕 API封面图
    let apiDescription = "";  // 🆕 API商品描述

    if (apiData) {
        console.log('[详情页] 🎯 使用 API 拦截数据:', apiData);

        // 浏览量 - 从 API 获取精确数值
        if (apiData.browseCnt !== undefined) {
            view = String(apiData.browseCnt);
        }

        // 想要数 - 从 API 获取精确数值
        if (apiData.wantCnt !== undefined) {
            want = String(apiData.wantCnt);
        }

        // 价格 - 从 API 获取（作为备用）
        if (apiData.soldPrice) {
            price = apiData.soldPrice;
        }

        // 发布时间 - 从 API 获取精确时间
        if (apiData.publishTime) {
            publishTime = apiData.publishTime;
        }

        // 🆕 封面图 - 从 API 获取
        if (apiData.coverImage) {
            apiCoverImage = apiData.coverImage;
        }

        // 🆕 商品描述 - 从 API 获取
        if (apiData.description) {
            apiDescription = apiData.description;
        }

        // 🔧 使用后清除，避免被下一个页面误用
        window.__GOOFISH_DETAIL_API_DATA__ = null;
    }

    // =========================
    // 如果 API 数据不完整，回退到 DOM 解析
    // =========================

    // 价格 - 仍然优先从 DOM 获取（更准确）
    const priceSelectors = ['div[class^="price--"]', '*[class^="price--"]'];
    for (const sel of priceSelectors) {
        const el = document.querySelector(sel);
        if (el) {
            const domPrice = parsePriceText(el.innerText || "");
            if (domPrice) {
                price = domPrice;
                break;
            }
        }
    }
    if (!price) {
        const priceWrap = document.querySelector('div[class^="price-wrap--"]');
        if (priceWrap) {
            price = parsePriceText(priceWrap.innerText || "");
        }
    }

    // 如果 API 没有想要/浏览数据，从 DOM 解析
    if (!want || !view) {
        let statText = "";
        const wantBox = document.querySelector('div[class^="want--"]');
        if (wantBox) {
            statText = cleanOneLine(wantBox.innerText || "");
        }

        if (!want) {
            want = parseWantFromText(statText);
        }
        if (!view) {
            view = parseViewFromText(statText) || parseViewFromText(bodyText);
        }
    }

    // =========================
    // 仅在“真实商品详情页”执行（必须带商品 id），避免把 https://www.goofish.com/item 当详情页误采集
    // =========================
    let sellerNickname = "未知卖家";

    const url = window.location.href;
    try {
        const u = new URL(url);
        const hostOk = u.hostname === 'www.goofish.com' || u.hostname.endsWith('.goofish.com');
        const p = u.pathname || "";
        const hasQueryId = !!u.searchParams.get('id');
        const hasPathId = /^\/item\/[^/]+/.test(p);
        const isItemPath = p === '/item' || p.startsWith('/item/');
        const isItemHtml = /item\.htm$/i.test(p);
        const isRealDetail = hostOk && ((isItemHtml && hasQueryId) || (isItemPath && (hasQueryId || hasPathId)));
        if (!isRealDetail) {
            return { price, want, view, sellerNickname };
        }
    } catch (e) {
        return { price, want, view, sellerNickname };
    }

    // 核心修正：精准区分昵称与地区
    // ❌ 严禁抓取包含 item-user-info-label 的元素（这是省份/地区，如"武汉"）
    // ✅ 正确抓取：使用属性选择器精准定位昵称，类名中包含关键字 nick 才是真正的卖家名字

    // 方法1：精准定位 - 使用 document.querySelector('div[class*="item-user-info-nick"]')
    // 使用更精确的选择器：确保包含 nick 且不包含 label
    const nickSelectors = [
        'div[class*="item-user-info-nick"]:not([class*="label"])',
        'div[class*="item-user-info-nick"]',
        '*[class*="item-user-info-nick"]:not([class*="label"])'
    ];

    for (const selector of nickSelectors) {
        const nickEl = document.querySelector(selector);
        if (nickEl) {
            // 双重验证：确保不是 label 元素
            const classList = nickEl.className || "";
            if (classList.includes("nick") && !classList.includes("label")) {
                // 尝试多种方式获取文本
                let nick = nickEl.getAttribute("title") ||
                    nickEl.getAttribute("data-nick") ||
                    nickEl.innerText ||
                    nickEl.textContent || "";

                if (nick) {
                    nick = cleanOneLine(nick);
                    if (nick && nick.length > 1 && nick.length < 50) {
                        // 过滤掉无效文本和地区名
                        if (nick !== "查看主页" && nick !== "关注" && !nick.includes("点击") && !nick.includes("查看")) {
                            // 排除常见省份名和城市名（避免误抓地区）
                            const provinces = ['北京', '上海', '天津', '重庆', '河北', '山西', '辽宁', '吉林', '黑龙江',
                                '江苏', '浙江', '安徽', '福建', '江西', '山东', '河南', '湖北', '湖南',
                                '广东', '海南', '四川', '贵州', '云南', '陕西', '甘肃', '青海', '台湾',
                                '内蒙古', '广西', '西藏', '宁夏', '新疆', '香港', '澳门', '武汉', '杭州',
                                '成都', '深圳', '广州', '南京', '苏州', '西安', '郑州', '长沙', '合肥'];
                            if (!provinces.includes(nick) && nick.length > 1) {
                                sellerNickname = nick;
                                break;
                            }
                        }
                    }
                }
            }
        }
    }

    // 方法2：如果方法1失败，在 item-user-info 区域查找，但明确排除 label 元素
    if (sellerNickname === "未知卖家") {
        const userInfoArea = document.querySelector('div[class*="item-user-info"]');
        if (userInfoArea) {
            // 查找所有可能的昵称元素，但排除 label
            const candidates = userInfoArea.querySelectorAll('a, span, div');
            for (const nameEl of candidates) {
                const classList = nameEl.className || "";
                // 必须包含 nick，且不包含 label
                if (classList.includes("nick") && !classList.includes("label")) {
                    let nick = nameEl.getAttribute("title") ||
                        nameEl.getAttribute("data-nick") ||
                        nameEl.innerText ||
                        nameEl.textContent || "";
                    if (nick) {
                        nick = cleanOneLine(nick);
                        if (nick && nick.length > 1 && nick.length < 50) {
                            if (nick !== "查看主页" && nick !== "关注" && !nick.includes("点击") && !nick.includes("查看")) {
                                sellerNickname = nick;
                                break;
                            }
                        }
                    }
                }
            }
        }
    }

    // 🆕 提取商品封面图URL（从详情页轮播图/主图区域）
    let coverImage = "";
    try {
        const imgSelectors = [
            'div[class*="slider"] img',
            'div[class*="carousel"] img',
            'div[class*="gallery"] img',
            'div[class*="main-pic"] img',
            'div[class*="image-view"] img',
            'img[class*="item-img"]',
            'img[src*="img.alicdn"]',
            'img[src*="gw.alicdn"]'
        ];
        for (const sel of imgSelectors) {
            const imgEl = document.querySelector(sel);
            if (imgEl) {
                const imgSrc = imgEl.getAttribute('src') || imgEl.getAttribute('data-src') || '';
                if (imgSrc && (imgSrc.includes('alicdn') || imgSrc.includes('goofish') || imgSrc.startsWith('http'))) {
                    coverImage = imgSrc.replace(/^\/\//, 'https://');
                    break;
                }
            }
        }
    } catch (e) { }

    // 🆕 提取商品文案/描述（详情页正文区域）
    // 🔧 增加垃圾内容过滤
    let description = "";
    try {
        const descSelectors = [
            'div[class*="desc-content"]',
            'div[class*="detail-desc"]',
            'div[class*="item-desc"]',
            'pre[class*="desc"]',
            'div[class*="description"]'
        ];
        const junkPatterns = /人想要|累计降价|降价\d|[￥¥]\s*\d|^(北京|天津|上海|重庆|河北|山西|辽宁|吉林|黑龙江|江苏|浙江|安徽|福建|江西|山东|河南|湖北|湖南|广东|海南|四川|贵州|云南|陕西|甘肃|青海|内蒙古|广西|西藏|宁夏|新疆)/;
        for (const sel of descSelectors) {
            const descEl = document.querySelector(sel);
            if (descEl) {
                const text = cleanOneLine(descEl.innerText || descEl.textContent || "");
                if (text && text.length > 5 && !junkPatterns.test(text)) {
                    description = text;
                    break;
                }
            }
        }
    } catch (e) { }

    return { price, want, view, sellerNickname, publishTime, coverImage: coverImage || apiCoverImage, description: description || apiDescription };
}

// =========================
// 处理详情页采集任务
// =========================
async function processDetailCollection(items, config) {
    // ========== 防重复采集检查（带超时重置） ==========
    // 生成本次采集的唯一ID（基于第一个商品链接和数量）
    const collectionId = `${items[0]?.商品链接 || ''}_${items.length}_${Date.now()}`;

    // 检查是否有采集任务正在进行
    if (isDetailCollecting) {
        // 🔧 修复：检查上次采集时间，如果超过2分钟，自动释放锁（防止暂停后刷新导致的死锁）
        const now = Date.now();
        const lastCollectionTime = parseInt(lastCollectionId?.split('_').pop() || '0');
        const timeSinceLastCollection = now - lastCollectionTime;

        if (timeSinceLastCollection > 120000) { // 2分钟
            console.warn('[详情页采集] ⚠️ 检测到采集锁超时（超过2分钟），自动释放锁');
            isDetailCollecting = false;
            currentCollectionTask = null;
            chrome.runtime.sendMessage({
                type: 'log',
                text: `[系统] 检测到上次采集已超时，已自动重置状态`,
                level: 'info'
            });
        } else {
            console.warn('[详情页采集] ⚠️ 已有采集任务正在进行中，忽略重复请求');
            chrome.runtime.sendMessage({
                type: 'log',
                text: `[警告] 忽略重复的采集请求（已有任务进行中）`,
                level: 'error'
            });
            return;
        }
    }

    // 设置锁
    isDetailCollecting = true;
    isPaused = false; // 🔧 修复：开始新采集时重置暂停状态
    forceStopFlag = false;  // 🆕 重置强制停止标志
    lastCollectionId = collectionId;
    collectedDataInBackground = [];  // 🆕 清空之前的采集数据
    console.log('[详情页采集] 开始采集，ID:', collectionId);
    // ====================================

    const detailDelay = config.detailDelay || 3000;
    const useDetailPage = config.useDetailPage !== false;
    const fastMode = config.fastMode === true;  // 🆕 快速采集模式

    currentCollectionTask = { items, config, index: 0 };

    // 🆕 如果开启快速采集，不进入详情页，直接使用列表页数据
    if (!useDetailPage || fastMode) {
        chrome.runtime.sendMessage({
            type: 'log',
            text: `[模式] ⚡ 快速采集模式（不进入详情页）`,
            level: 'success'
        });

        items.forEach((item, idx) => {
            // 确保"想要"字段：如果为空、"未获取"或未定义，改为"0"
            if (!item.想要 || item.想要 === "" || item.想要 === "未获取" || (typeof item.想要 === 'string' && item.想要.trim() === "")) {
                item.想要 = "0";
            }

            // 🆕 快速采集模式下，删除浏览量和询单率字段
            if (fastMode) {
                delete item.浏览量;
                delete item.询单率;
            } else {
                // 如果"想要"为0，询单率也应该是"0%"
                if (item.想要 === "0" && (!item.询单率 || item.询单率 === "" || item.询单率 === "未获取")) {
                    item.询单率 = "0%";
                }
            }

            // 清理临时标记字段（避免污染最终数据）
            delete item._listPageWant;

            // 🆕 保存数据到 background（用于自动导出）
            collectedDataInBackground.push({ ...item });

            try {
                chrome.runtime.sendMessage({
                    type: 'data',
                    data: item
                });
            } catch (e) { }

            chrome.runtime.sendMessage({
                type: 'log',
                text: `[快速] ${idx + 1}/${items.length} | ${(item.标题 || item.商品标题 || '').substring(0, 25)}...`,
                level: 'info'
            });
        });

        chrome.runtime.sendMessage({
            type: 'complete',
            count: items.length,
            autoDownload: true  // 🆕 触发自动下载
        });
        currentCollectionTask = null;
        isDetailCollecting = false; // 释放锁

        // 🆕 快速采集完成后也执行自动导出
        if (collectedDataInBackground.length > 0) {
            setTimeout(async () => {
                await autoExportData();
            }, 500);
        }

        return;
    }

    // 发送日志
    chrome.runtime.sendMessage({
        type: 'log',
        text: `[详情页采集] 开始采集 ${items.length} 个商品的详情页数据...`,
        level: 'info'
    });
    chrome.runtime.sendMessage({
        type: 'log',
        text: `[详情页采集] 将自动打开新标签页，请勿手动关闭`,
        level: 'info'
    });

    const total = items.length;
    let completed = 0;
    let failed = 0;

    // 并发采集：从配置中读取并发数量（用户可调整）
    const CONCURRENT_LIMIT = config.concurrentLimit || 10;
    let currentIndex = 0;

    chrome.runtime.sendMessage({
        type: 'log',
        text: `[详情页采集] 并发采集模式：同时打开 ${CONCURRENT_LIMIT} 个标签页`,
        level: 'info'
    });

    // 并发采集函数
    const processBatch = async () => {
        while (currentIndex < items.length) {
            // 🆕 检查强制停止标志
            if (forceStopFlag) {
                console.log('[详情页采集] 🛑 检测到强制停止标志，立即退出采集');
                return;
            }

            // 检查暂停
            while (isPaused && !forceStopFlag) {
                await new Promise(resolve => setTimeout(resolve, 500));
            }

            // 🆕 再次检查强制停止（防止在暂停期间被停止）
            if (forceStopFlag) {
                console.log('[详情页采集] 🛑 检测到强制停止标志，立即退出采集');
                return;
            }

            // 获取当前批次（最多3个）
            const batch = [];
            for (let i = 0; i < CONCURRENT_LIMIT && currentIndex < items.length; i++) {
                batch.push({ item: items[currentIndex], index: currentIndex });
                currentIndex++;
            }

            if (batch.length === 0) break;

            // 安全地更新任务索引
            if (currentCollectionTask) {
                currentCollectionTask.index = currentIndex - 1;
            }

            // 并发处理批次 - 确保真正同时打开2个标签页
            chrome.runtime.sendMessage({
                type: 'log',
                text: `[详情页] 🚀 同时打开 ${batch.length} 个标签页 (${currentIndex - batch.length + 1}-${currentIndex}/${total})...`,
                level: 'info'
            });

            // 关键：使用数组立即存储所有创建请求，确保真正并发
            const createPromises = [];
            const tabData = [];

            // 第一步：立即发起所有标签页创建请求（不等待任何回调）
            batch.forEach(({ item, index }) => {
                const createPromise = new Promise((resolve, reject) => {
                    // 立即调用 chrome.tabs.create，不等待
                    chrome.tabs.create({
                        url: item.商品链接,
                        active: false
                    }, (tab) => {
                        if (chrome.runtime.lastError) {
                            reject(new Error('无法打开标签页: ' + chrome.runtime.lastError.message));
                            return;
                        }
                        // 创建成功，保存标签页信息
                        tabData.push({ tab, item, index });
                        resolve({ tab, item, index });
                    });
                });
                createPromises.push(createPromise);
            });

            // 等待所有标签页创建完成
            const createdTabs = await Promise.all(createPromises);

            chrome.runtime.sendMessage({
                type: 'log',
                text: `[详情页] ✅ 已创建 ${createdTabs.length} 个标签页，开始并发采集...`,
                level: 'info'
            });

            // 第二步：并发处理所有标签页的采集（采集完成后自动关闭）
            const collectPromises = createdTabs.map(({ tab, item, index }) => {
                // 🆕 记录活跃标签页
                activeTabs.push(tab.id);

                return processTabCollection(tab, item, detailDelay, index + 1, total)
                    .then(metrics => {
                        // 采集成功，从活跃列表移除
                        activeTabs = activeTabs.filter(id => id !== tab.id);
                        return { success: true, item, index, metrics, tabId: tab.id };
                    })
                    .catch(error => {
                        // 采集失败
                        activeTabs = activeTabs.filter(id => id !== tab.id);
                        return { success: false, item, index, error, tabId: tab.id };
                    });
            });

            // 等待所有采集任务完成
            const results = await Promise.all(collectPromises);

            // 处理结果
            for (const result of results) {
                const { item, index } = result;

                if (result.success) {
                    const metrics = result.metrics;

                    // 更新卖家昵称：使用从详情页精准提取的昵称（使用 item-user-info-nick 选择器）
                    if (metrics.sellerNickname && metrics.sellerNickname !== "未知卖家") {
                        item.卖家昵称 = metrics.sellerNickname;
                    }

                    item.价格 = metrics.price || "";

                    // ========== "想要"数精准优先策略 ==========
                    // 规则1: 如果列表页有有效的精准数据（非空且不带"万"），优先使用
                    // 规则2: 否则使用详情页数据
                    // 规则3: 都没有则为"0"
                    const listPageWant = item._listPageWant || "";
                    const detailPageWant = metrics.want || "";
                    let wantValue = "";

                    // 判断列表页数据是否为精准值（不包含"万"）
                    const isListPagePrecise = listPageWant && listPageWant !== "" && listPageWant !== "0" && !listPageWant.includes("万");

                    if (isListPagePrecise) {
                        // 使用列表页精准值
                        wantValue = listPageWant;
                        console.log('[精准优先] 使用列表页精准值:', wantValue, '（详情页值:', detailPageWant, '）');
                    } else if (detailPageWant && detailPageWant !== "" && detailPageWant !== "未获取") {
                        // 使用详情页数据
                        wantValue = detailPageWant;
                        if (listPageWant) {
                            console.log('[精准优先] 列表页值含"万"或为空，使用详情页值:', wantValue);
                        }
                    } else if (listPageWant && listPageWant !== "") {
                        // 回退到列表页数据（即使带"万"也比没有好）
                        wantValue = listPageWant;
                    }

                    // 最终兜底
                    if (!wantValue || wantValue === "" || wantValue === "未获取" || wantValue.trim() === "") {
                        wantValue = "0";
                    }

                    item.想要 = wantValue;

                    // 清理临时标记字段（避免污染最终数据）
                    delete item._listPageWant;
                    // =============================================

                    item.浏览量 = metrics.view || "";

                    // 🆕 验证检测：如果浏览量为空，可能需要人工验证
                    if (!metrics.view || metrics.view === "" || metrics.view === "0") {
                        // 检查是否有连续多个商品浏览量为空（表示可能触发了验证）
                        if (!needsVerification) {
                            // 第一次检测到，记录日志
                            chrome.runtime.sendMessage({
                                type: 'log',
                                text: `[验证检测] ⚠️ 商品 [${index + 1}] 浏览量为空，可能需要人工验证！`,
                                level: 'error'
                            });

                            // 将这个商品加入失败队列（后续重试）
                            failedItems.push({ item: { ...item }, index, url: item.商品链接 });

                            // 检测连续失败：如果有3个或以上商品浏览量为空，触发验证流程
                            const emptyViewCount = results.filter(r =>
                                r.success && (!r.metrics.view || r.metrics.view === "" || r.metrics.view === "0")
                            ).length;

                            if (emptyViewCount >= 2) {
                                needsVerification = true;
                                isPaused = true;

                                chrome.runtime.sendMessage({
                                    type: 'log',
                                    text: `[验证检测] 🛑 检测到多个商品采集失败，可能需要人工验证！`,
                                    level: 'error'
                                });
                                chrome.runtime.sendMessage({
                                    type: 'log',
                                    text: `[验证检测] 📢 正在关闭其他窗口，只保留一个验证窗口...`,
                                    level: 'info'
                                });

                                // 发送浏览器通知
                                showNotification('🛑 需要人工验证', '检测到闲鱼验证码，请在浏览器中完成验证，验证后将自动继续采集');

                                // 创建一个新的验证窗口（使用第一个失败商品的链接）
                                try {
                                    const verifyTab = await new Promise((resolve, reject) => {
                                        chrome.tabs.create({
                                            url: item.商品链接,
                                            active: true  // 设为活跃窗口
                                        }, (tab) => {
                                            if (chrome.runtime.lastError) {
                                                reject(chrome.runtime.lastError);
                                            } else {
                                                resolve(tab);
                                            }
                                        });
                                    });
                                    verificationTabId = verifyTab.id;

                                    // 关闭其他所有采集窗口
                                    await closeAllTabsExcept(verificationTabId);

                                    chrome.runtime.sendMessage({
                                        type: 'log',
                                        text: `[验证检测] ✅ 已保留验证窗口，完成验证后将自动继续采集`,
                                        level: 'success'
                                    });

                                    // 发送验证状态到 popup
                                    chrome.runtime.sendMessage({
                                        type: 'verificationNeeded',
                                        failedCount: failedItems.length
                                    });

                                    // 🆕 保存当前配置并启动自动验证检测
                                    pendingRetryConfig = { detailDelay: detailDelay, useDetailPage: true };
                                    startVerificationCheck();

                                } catch (e) {
                                    console.error('[验证检测] 创建验证窗口失败:', e);
                                }
                            }
                        } else {
                            // 已经在验证模式，只记录失败
                            failedItems.push({ item: { ...item }, index, url: item.商品链接 });
                        }
                    }

                    // 🔧 修复：封面图优先使用列表页首图（列表页的才是真正的封面/首图）
                    // 详情页可能抓到轮播中的第2张或其他图片，只在列表页没有图时才用详情页的
                    if (!item.封面图 && metrics.coverImage && metrics.coverImage !== "") {
                        item.封面图 = metrics.coverImage;
                    }

                    // 🔧 修复：合并描述时去重
                    // 如果详情页描述和标题完全一样（或包含标题），不覆盖，避免文案重复显示
                    if (metrics.description && metrics.description !== "") {
                        const title = item.标题 || "";
                        const descTrimmed = metrics.description.trim();
                        const titleTrimmed = title.trim();
                        // 只有描述和标题不同，且不是标题的重复，才合并
                        if (descTrimmed !== titleTrimmed && !descTrimmed.startsWith(titleTrimmed + titleTrimmed)) {
                            item.商品描述 = metrics.description;
                        }
                    }

                    // 🆕 如果详情页 API 返回了精确的发布时间，覆盖列表页的时间
                    if (metrics.publishTime && metrics.publishTime !== "") {
                        item.发布时间 = metrics.publishTime;
                        console.log('[详情页] 使用 API 精确发布时间:', metrics.publishTime);

                        // 🆕 重新计算发布天数
                        try {
                            const publishDateStr = metrics.publishTime.replace(/-/g, '/');
                            const publishDate = new Date(publishDateStr);
                            const now = new Date();
                            if (!isNaN(publishDate.getTime())) {
                                const diffMs = now.getTime() - publishDate.getTime();
                                const diffDays = diffMs / (1000 * 60 * 60 * 24);
                                item.发布天数 = diffDays.toFixed(1);
                            }
                        } catch (e) {
                            console.warn('[发布天数] 重新计算失败:', e);
                        }
                    }

                    // 计算询单率并验证数据正确性
                    const wantInt = parseCountToInt(item.想要);
                    const viewInt = parseCountToInt(item.浏览量);

                    // 验证：浏览量一定大于想要数，如果询单率>100%说明数据有误
                    if (viewInt > 0 && wantInt > viewInt) {
                        item.想要 = "0";
                        item.询单率 = "0%";
                        chrome.runtime.sendMessage({
                            type: 'log',
                            text: `[详情页] [${index + 1}/${total}] ⚠️ 数据验证失败：想要数异常，已修正为0`,
                            level: 'error'
                        });
                    } else {
                        if (wantInt === 0 || viewInt === 0) {
                            item.询单率 = "0%";
                        } else {
                            item.询单率 = calcInquiryRate(wantInt, viewInt);
                        }

                        if (item.询单率 && parseFloat(item.询单率) > 100) {
                            item.想要 = "0";
                            item.询单率 = "0%";
                            chrome.runtime.sendMessage({
                                type: 'log',
                                text: `[详情页] [${index + 1}/${total}] ⚠️ 数据验证失败：询单率>100%，已修正为0`,
                                level: 'error'
                            });
                        }
                    }

                    completed++;

                    // 🆕 保存数据到 background（用于自动导出）
                    collectedDataInBackground.push({ ...item });

                    // 发送数据到 popup（如果 popup 打开的话）
                    try {
                        chrome.runtime.sendMessage({
                            type: 'data',
                            data: item
                        });
                    } catch (e) {
                        // popup 可能已关闭，忽略错误
                    }

                    chrome.runtime.sendMessage({
                        type: 'log',
                        text: `[详情页] [${index + 1}/${total}] ✅ 完成 | 价格:${item.价格 || '未获取'} | 想要:${item.想要 || '0'} | 浏览:${item.浏览量 || '未获取'} | 询单率:${item.询单率 || '0%'}`,
                        level: 'success'
                    });
                } else {
                    failed++;

                    // 改进错误处理：即使详情页采集失败，也发送列表页基础数据
                    // 确保"想要"字段：如果为空、"未获取"或未定义，改为"0"
                    if (!item.想要 || item.想要 === "" || item.想要 === "未获取" || (typeof item.想要 === 'string' && item.想要.trim() === "")) {
                        item.想要 = "0";
                    }
                    // 如果"想要"为0，询单率也应该是"0%"
                    if (item.想要 === "0" && (!item.询单率 || item.询单率 === "" || item.询单率 === "未获取")) {
                        item.询单率 = "0%";
                    }

                    // 清理临时标记字段（避免污染最终数据）
                    delete item._listPageWant;

                    // 添加详细失败日志
                    const errorMessage = result.error ? result.error.message : '未知错误';
                    chrome.runtime.sendMessage({
                        type: 'log',
                        text: `[详情页] [${index + 1}/${total}] ❌ 详情页采集失败: ${errorMessage}（已保留列表页基础数据）`,
                        level: 'error'
                    });

                    // 即使失败，也发送列表页的基础数据
                    chrome.runtime.sendMessage({
                        type: 'data',
                        data: item
                    });

                    // 失败也算作完成（因为至少保留了列表页数据）
                    completed++;
                }
            }
        }
    };

    // 开始并发采集
    await processBatch();

    // =========================
    // 采集完整性验证：验证采集成功的数量
    // =========================
    const expectedCount = items.length;
    const successRate = expectedCount > 0 ? ((completed / expectedCount) * 100).toFixed(1) : 0;

    chrome.runtime.sendMessage({
        type: 'log',
        text: `[详情页采集] ✅ 完成！成功: ${completed} 条，失败: ${failed} 条，成功率: ${successRate}%`,
        level: 'success'
    });

    // 如果采集数量明显少于预期，输出警告
    if (completed < expectedCount) {
        const missingCount = expectedCount - completed;
        const missingRate = ((missingCount / expectedCount) * 100).toFixed(1);

        chrome.runtime.sendMessage({
            type: 'log',
            text: `⚠️ 警告：采集不完全！预期 ${expectedCount} 条，实际完成 ${completed} 条，缺失 ${missingCount} 条（${missingRate}%）`,
            level: 'error'
        });

        if (failed > 0) {
            chrome.runtime.sendMessage({
                type: 'log',
                text: `💡 建议：${failed} 个商品详情页采集失败，已保留列表页基础数据。可检查网络连接或重试采集。`,
                level: 'info'
            });
        }
    } else if (completed === expectedCount) {
        chrome.runtime.sendMessage({
            type: 'log',
            text: `✅ 采集完整性验证通过：成功采集所有 ${completed} 个商品`,
            level: 'success'
        });
    }

    // 🆕 检查是否有因验证失败的商品需要重试
    if (failedItems.length > 0 && !needsVerification) {
        chrome.runtime.sendMessage({
            type: 'log',
            text: `[验证重试] 📋 有 ${failedItems.length} 个商品因验证失败，稍后可手动重试`,
            level: 'info'
        });
    }

    chrome.runtime.sendMessage({
        type: 'complete',
        count: completed,
        failedCount: failedItems.length,
        autoDownload: true  // 🆕 标记自动下载
    });

    currentCollectionTask = null;

    // ========== 释放防重复采集锁 ==========
    isDetailCollecting = false;
    needsVerification = false;  // 重置验证状态
    verificationTabId = null;
    console.log('[详情页采集] 采集完成，释放锁');
    // ====================================

    // 🆕 调用自动导出函数
    await autoExportData();
}

// 🆕 自动导出函数（可复用）
async function autoExportData() {
    if (collectedDataInBackground.length === 0) {
        return;
    }

    try {
        // 检查是否开启了自动下载
        const settings = await chrome.storage.local.get(['autoDownload', 'config']);
        const autoDownloadEnabled = settings.autoDownload !== false;  // 默认开启

        if (autoDownloadEnabled) {
            console.log('[自动导出] 采集完成，开始自动导出...');

            // 🆕 检查是否需要导出为HTML
            const exportHtml = settings.config?.exportHtml === true;
            const formatStr = exportHtml ? 'HTML' : 'CSV';

            try {
                chrome.runtime.sendMessage({
                    type: 'log',
                    text: `[自动导出] 📥 正在生成${formatStr}文件，共 ${collectedDataInBackground.length} 条数据...`,
                    level: 'info'
                });
            } catch (e) { }

            // 🆕 先算出文件名（用于HTML报告标题）
            const baseName = await getExportBaseName(collectedDataInBackground);
            let nickS = String(baseName || "未知卖家")
                .replace(/[<>:"\/\\|?*\x00-\x1f]/g, "_")
                .trim();
            if (!nickS) nickS = "未知卖家";
            nickS = nickS.substring(0, 30);

            const autoNow = new Date();
            const month = String(autoNow.getMonth() + 1).padStart(2, '0');
            const day = String(autoNow.getDate()).padStart(2, '0');
            const hour = String(autoNow.getHours()).padStart(2, '0');
            const minute = String(autoNow.getMinutes()).padStart(2, '0');
            const autoBaseFilename = `${nickS}-${month}.${day}-${hour}.${minute}`;

            // 🆕 根据设置生成对应格式的文件（HTML报告标题=文件名）
            const blob = exportHtml
                ? generateHTMLFile(collectedDataInBackground, autoBaseFilename)
                : generateCSVFile(collectedDataInBackground);

            if (blob) {
                // 直接使用上面已算好的文件名
                const ext = exportHtml ? 'html' : 'csv';
                const filename = `${autoBaseFilename}.${ext}`;
                const dataCount = collectedDataInBackground.length;

                // 使用 FileReader 将 Blob 转换为 Data URL
                const reader = new FileReader();
                reader.onloadend = () => {
                    const dataUrl = reader.result;

                    console.log('[自动导出] 准备下载，文件名:', filename);
                    pendingFilename = filename;

                    chrome.downloads.download({
                        url: dataUrl,
                        filename: filename,
                        saveAs: false,
                        conflictAction: 'uniquify'
                    }, (downloadId) => {
                        if (chrome.runtime.lastError) {
                            console.error('[自动导出] 下载失败:', chrome.runtime.lastError.message);
                            const simpleName = `闲鱼数据_${Date.now()}.${ext}`;
                            pendingFilename = simpleName;
                            chrome.downloads.download({
                                url: dataUrl,
                                filename: simpleName,
                                saveAs: false
                            });
                        } else {
                            console.log('[自动导出] ✅ 文件已下载, ID:', downloadId, '文件名:', filename);
                            try {
                                chrome.runtime.sendMessage({
                                    type: 'log',
                                    text: `[自动导出] ✅ 文件已保存: ${filename}`,
                                    level: 'success'
                                });
                            } catch (e) { }
                            showNotification('✅ 采集完成', `已自动导出 ${dataCount} 条数据`);
                        }
                    });
                };
                reader.onerror = () => {
                    console.error('[自动导出] FileReader 错误:', reader.error);
                };
                reader.readAsDataURL(blob);
            }

            // 清空 background 数据
            collectedDataInBackground = [];
        }
    } catch (e) {
        console.error('[自动导出] 导出失败:', e);
    }
}

// 辅助函数
function parseCountToInt(text) {
    if (!text) return 0;
    const t = String(text).trim();
    const m = t.match(/(\d+(?:\.\d+)?)\s*万/);
    if (m) {
        return Math.floor(parseFloat(m[1]) * 10000);
    }
    const m2 = t.match(/(\d+)/);
    return m2 ? parseInt(m2[1]) : 0;
}

function calcInquiryRate(wantInt, viewInt) {
    if (viewInt <= 0 || wantInt <= 0) return "";
    return ((wantInt / viewInt) * 100).toFixed(2) + "%";
}

// 解析采集时间字符串为Date对象
// 支持多种格式：
// - "2025/12/26 17:20"
// - "2025-12-26 17:20"
// - "12-26 17:20" (使用当前年份)
// - "12/26 17:20"
// - "MM.DD HH:MM"
function parseCollectionTime(timeStr) {
    if (!timeStr) return new Date(0);

    const str = String(timeStr).trim();

    // 格式1: YYYY/MM/DD HH:mm 或 YYYY-MM-DD HH:mm
    const fullMatch = str.match(/(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})\s+(\d{1,2}):(\d{1,2})/);
    if (fullMatch) {
        return new Date(
            parseInt(fullMatch[1]),
            parseInt(fullMatch[2]) - 1,
            parseInt(fullMatch[3]),
            parseInt(fullMatch[4]),
            parseInt(fullMatch[5])
        );
    }

    // 格式2: MM-DD HH:mm 或 MM/DD HH:mm 或 MM.DD HH:mm (无年份，使用当前年)
    const shortMatch = str.match(/(\d{1,2})[\/\-\.](\d{1,2})\s+(\d{1,2}):(\d{1,2})/);
    if (shortMatch) {
        const currentYear = new Date().getFullYear();
        return new Date(
            currentYear,
            parseInt(shortMatch[1]) - 1,
            parseInt(shortMatch[2]),
            parseInt(shortMatch[3]),
            parseInt(shortMatch[4])
        );
    }

    // 尝试JavaScript原生解析
    const parsedDate = new Date(str);
    if (!isNaN(parsedDate.getTime())) {
        return parsedDate;
    }

    console.warn('[对比] 无法解析时间:', str);
    return new Date(0);
}

// =========================
// 生成文件名（对应原Python格式）
// =========================
function sanitizeFilenamePart(s, maxLen = 30) {
    if (!s) return "未知卖家";
    s = String(s).replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").trim();
    if (!s) return "未知卖家";
    return s.substring(0, maxLen);
}

function buildFilename(nick) {
    const nickS = sanitizeFilenamePart(nick);
    const now = new Date();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    const hour = String(now.getHours()).padStart(2, '0');
    const minute = String(now.getMinutes()).padStart(2, '0');
    const second = String(now.getSeconds()).padStart(2, '0');
    // 格式（不含年份）：昵称-月.日-时.分.秒
    return `${nickS}-${month}.${day}-${hour}.${minute}.${second}`;
}

function buildDailyFolderName() {
    // 同一天固定一个文件夹（不含年份）：闲鱼采集_MM.DD
    const now = new Date();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    return `闲鱼采集_${month}.${day}`;
}

async function getExportBaseName(data) {
    // 规则：
    // - 如果来源是搜索页（search），用“搜索关键词”
    // - 如果来源是个人主页（personal），用“卖家昵称(nick)”
    // - 兜底：卖家昵称
    const nickname = data?.[0]?.卖家昵称 || "未知卖家";
    try {
        const ctxResult = await chrome.storage.local.get(['exportNameContext', 'lastSearchKeyword', 'lastSearchUpdatedAt']);
        const ctx = ctxResult.exportNameContext || {};
        if (ctx.sourceType === 'search') {
            const kw = String(ctx.searchKeyword || ctxResult.lastSearchKeyword || "").trim();
            if (kw) return kw;
        }
        if (ctx.sourceType === 'personal') {
            return nickname;
        }
        // 兜底：如果最近30分钟内有搜索词，也可作为命名（防止详情页启动采集）
        const lastKw = String(ctxResult.lastSearchKeyword || "").trim();
        const lastAt = ctxResult.lastSearchUpdatedAt || 0;
        if (lastKw && (Date.now() - lastAt) < 30 * 60 * 1000) {
            return lastKw;
        }
    } catch (e) {
        // ignore
    }
    return nickname;
}

async function logToPopup(text, level = 'info') {
    try {
        chrome.runtime.sendMessage({
            type: 'log',
            text,
            level
        });
    } catch (e) {
        // ignore
    }
}

function downloadsSearchById(downloadId) {
    return new Promise((resolve) => {
        try {
            chrome.downloads.search({ id: downloadId }, (items) => resolve(items || []));
        } catch (e) {
            resolve([]);
        }
    });
}

function downloadsRename(downloadId, newFilename) {
    return new Promise((resolve, reject) => {
        try {
            // 注意：Chrome/Edge 的 downloads API 没有 rename 接口（不要使用）
            reject(new Error('chrome.downloads.rename is not supported'));
        } catch (e) {
            reject(e);
        }
    });
}

async function waitForDownloadItemReady(downloadId, timeoutMs = 15000) {
    const start = Date.now();
    let lastState = '';
    while (Date.now() - start < timeoutMs) {
        const items = await downloadsSearchById(downloadId);
        const item = items && items[0] ? items[0] : null;
        if (item) {
            const state = item.state || '';
            const filename = item.filename || '';
            const suggested = item.suggestedFilename || '';
            // 打一条低频状态日志，方便排查“字段为空”
            if (state && state !== lastState) {
                lastState = state;
                await logToPopup(`[导出] 下载状态: ${state} | bytes=${item.bytesReceived || 0}/${item.totalBytes || 0}`, 'info');
            }
            // filename/suggested 出现，或者下载完成，都认为“可用于判断/重命名”
            if (filename || suggested || state === 'complete') {
                return item;
            }
        }
        await new Promise(r => setTimeout(r, 500));
    }
    return null;
}

// =========================
// 消息监听
// =========================
// Edge浏览器兼容性：确保消息监听器正确设置
console.log('[Service Worker] 设置消息监听器...');

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    console.log('[Service Worker] 收到消息:', message.type || message.action);

    // 处理暂停/继续
    if (message.type === 'pauseCollection') {
        isPaused = true;
        // 🔧 修复：暂停时释放采集锁，允许后续重新开始
        isDetailCollecting = false;
        currentCollectionTask = null;
        console.log('[暂停] 已释放采集锁，允许重新开始');
        chrome.runtime.sendMessage({
            type: 'log',
            text: '[系统] 采集已暂停',
            level: 'info'
        });
        sendResponse({ success: true });
        return true;
    }

    if (message.type === 'resumeCollection') {
        isPaused = false;
        console.log('[继续] 已重置暂停状态');
        chrome.runtime.sendMessage({
            type: 'log',
            text: '[系统] 采集已继续',
            level: 'info'
        });
        sendResponse({ success: true });
        return true;
    }

    // 🔧 修复：处理重置采集状态的请求（用于清除死锁）
    if (message.type === 'resetCollectionState') {
        console.log('[重置] 强制重置所有采集状态');
        isDetailCollecting = false;
        isPaused = false;
        currentCollectionTask = null;
        lastCollectionId = null;
        needsVerification = false;
        verificationTabId = null;
        failedItems = [];
        activeTabs = [];
        sendResponse({ success: true });
        return true;
    }

    // 🆕 处理验证完成后继续采集
    if (message.type === 'verificationComplete') {
        console.log('[验证完成] 用户完成了验证，准备继续采集');
        needsVerification = false;
        isPaused = false;

        // 关闭验证窗口
        if (verificationTabId) {
            try {
                chrome.tabs.remove(verificationTabId);
            } catch (e) { }
            verificationTabId = null;
        }

        chrome.runtime.sendMessage({
            type: 'log',
            text: '[验证完成] ✅ 验证成功，继续采集剩余商品...',
            level: 'success'
        });

        sendResponse({ success: true });
        return true;
    }

    // 🆕 处理强制停止采集请求
    if (message.type === 'forceStopCollection') {
        console.log('[强制停止] 🛑 收到强制停止请求，正在彻底停止所有采集...');

        (async () => {
            try {
                // 🆕 首先设置强制停止标志，阻止所有采集和重试
                forceStopFlag = true;
                console.log('[强制停止] 🛑 设置强制停止标志');

                // 1. 重置所有状态变量
                isPaused = false;
                isDetailCollecting = false;
                needsVerification = false;
                currentCollectionTask = null;
                lastCollectionId = null;
                collectedDataInBackground = [];
                failedItems = [];

                // 2. 释放工作锁
                await releaseWorkerLock();

                // 3. 关闭所有自动打开的采集标签页
                if (activeTabs && activeTabs.length > 0) {
                    console.log('[强制停止] 关闭采集标签页:', activeTabs.length, '个');
                    for (const tabId of activeTabs) {
                        try {
                            await chrome.tabs.remove(tabId);
                        } catch (e) {
                            // 标签页可能已关闭，忽略错误
                        }
                    }
                    activeTabs = [];
                }

                // 4. 关闭验证窗口（如果有）
                if (verificationTabId) {
                    try {
                        await chrome.tabs.remove(verificationTabId);
                    } catch (e) { }
                    verificationTabId = null;
                }

                // 5. 查找并关闭所有可能的采集标签页（goofish.com/item 开头的）
                try {
                    const allTabs = await chrome.tabs.query({ url: '*://*.goofish.com/item*' });
                    console.log('[强制停止] 发现可能的采集标签页:', allTabs.length, '个');
                    for (const tab of allTabs) {
                        // 只关闭非活跃的标签页（避免关闭用户正在浏览的页面）
                        if (!tab.active) {
                            try {
                                await chrome.tabs.remove(tab.id);
                            } catch (e) { }
                        }
                    }
                } catch (e) {
                    console.error('[强制停止] 关闭标签页失败:', e);
                }

                // 6. 清除 storage 中的锁状态
                await chrome.storage.local.remove(['activeWorkerId', 'activeWorkerTime']);

                console.log('[强制停止] ✅ 所有采集已彻底停止');

                try {
                    chrome.runtime.sendMessage({
                        type: 'log',
                        text: '[系统] ✅ 已关闭所有采集窗口，完全停止',
                        level: 'success'
                    });
                } catch (e) { }

            } catch (error) {
                console.error('[强制停止] 停止过程中出错:', error);
            }
        })();

        sendResponse({ success: true });
        return true;
    }

    // 🆕 处理重试失败商品的请求
    if (message.type === 'retryFailedItems') {
        console.log('[重试] 开始重试失败的商品，数量:', failedItems.length);

        if (failedItems.length === 0) {
            chrome.runtime.sendMessage({
                type: 'log',
                text: '[重试] 没有需要重试的商品',
                level: 'info'
            });
            sendResponse({ success: false, error: '没有需要重试的商品' });
            return true;
        }

        // 复制失败队列并清空
        const itemsToRetry = [...failedItems];
        failedItems = [];

        chrome.runtime.sendMessage({
            type: 'log',
            text: `[重试] 🔄 开始重试 ${itemsToRetry.length} 个失败的商品...`,
            level: 'info'
        });

        // 重新采集失败的商品
        const retryItems = itemsToRetry.map(f => f.item);
        processDetailCollection(retryItems, message.config || { detailDelay: 50, useDetailPage: true });

        sendResponse({ success: true, retryCount: itemsToRetry.length });
        return true;
    }

    // 🆕 获取失败商品数量
    if (message.type === 'getFailedCount') {
        sendResponse({ failedCount: failedItems.length, needsVerification });
        return true;
    }

    // 处理详情页采集请求
    if (message.type === 'startDetailCollection') {
        console.log('[Service Worker] 收到详情页采集请求，商品数量:', message.items?.length);

        // 🆕 检查实例锁，确保只有一个实例处理
        (async () => {
            const hasLock = await acquireWorkerLock();
            if (!hasLock) {
                console.log('[Service Worker] ⚠️ 其他实例正在处理，忽略本次请求');
                return;
            }

            console.log('[Service Worker] ✅ 获取工作锁成功，开始处理采集');

            try {
                await processDetailCollection(message.items, message.config);
            } catch (error) {
                console.error('[Service Worker] 详情页采集失败:', error);
                try {
                    chrome.runtime.sendMessage({
                        type: 'error',
                        text: error.message
                    });
                } catch (e) {
                    console.error('[Service Worker] 发送错误消息失败:', e);
                }
            } finally {
                // 采集完成后释放锁
                await releaseWorkerLock();
            }
        })();

        sendResponse({ success: true });
        return true;
    }

    // 处理Excel导出请求
    if (message.action === 'exportExcel') {
        // 立即返回 true 保持消息通道开放
        (async () => {
            try {
                const data = message.data;
                const exportHtml = message.exportHtml === true;  // 🆕 是否导出HTML

                console.log('[导出] 收到导出请求，数据条数:', data?.length, '格式:', exportHtml ? 'HTML' : 'CSV');

                if (!data || data.length === 0) {
                    sendResponse({ success: false, error: '没有数据可导出' });
                    return;
                }

                // 发送日志（尝试发送，如果失败也不影响导出）
                try {
                    const formatStr = exportHtml ? 'HTML' : 'Excel';
                    chrome.runtime.sendMessage({
                        type: 'log',
                        text: `[导出] 正在生成${formatStr}文件，共 ${data.length} 条数据...`,
                        level: 'info'
                    });
                } catch (e) {
                    console.log('[导出] 日志发送失败（可能popup已关闭）:', e);
                }

                // 🆕 先计算文件名，再生成文件（HTML报告标题需要用到文件名）
                const baseName = await getExportBaseName(data);
                const baseFilename = buildFilename(baseName);

                // 生成文件
                console.log('[导出] 开始生成文件...');
                const blob = await generateExcelFile(data, exportHtml, baseFilename);

                if (!blob) {
                    console.error('[导出] 生成文件失败');
                    sendResponse({ success: false, error: '生成文件失败' });
                    return;
                }

                console.log('[导出] 文件生成成功，类型:', blob.type, '大小:', blob.size);

                // 保存本次数据为历史数据（用于下次计算流行程度）
                try {
                    const historyResult = await chrome.storage.local.get(['exportHistory']);
                    const historyData = historyResult.exportHistory || [];

                    // 更新历史数据：用本次数据覆盖相同链接的历史数据，保留其他数据
                    const updatedHistory = [...historyData];
                    data.forEach(item => {
                        const index = updatedHistory.findIndex(h => h.商品链接 === item.商品链接);
                        if (index >= 0) {
                            // 更新现有记录
                            updatedHistory[index] = { ...item };
                        } else {
                            // 添加新记录
                            updatedHistory.push({ ...item });
                        }
                    });

                    // 只保留最近1000条历史数据，避免存储过大
                    if (updatedHistory.length > 1000) {
                        updatedHistory.splice(0, updatedHistory.length - 1000);
                    }

                    await chrome.storage.local.set({ exportHistory: updatedHistory });
                    console.log('[导出] 历史数据已保存，共', updatedHistory.length, '条');
                } catch (e) {
                    console.warn('[导出] 保存历史数据失败:', e);
                }

                // 根据实际导出格式确定扩展名（文件名已在上方计算好）
                let extension;
                if (exportHtml) {
                    extension = 'html';
                } else {
                    const isExcel = blob.type.includes('spreadsheetml');
                    extension = isExcel ? 'xlsx' : 'csv';
                }
                const filename = `${baseFilename}.${extension}`;

                console.log('[导出] 文件名:', filename);
                await logToPopup(`[导出] 命名来源: ${baseName}`, 'info');
                try {
                    const ctx = await chrome.storage.local.get(['exportNameContext', 'lastSearchKeyword', 'lastSearchUpdatedAt']);
                    await logToPopup(`[导出] 命名上下文: ${JSON.stringify(ctx.exportNameContext || {})}`, 'info');
                } catch (e) { }

                // 发送日志
                try {
                    chrome.runtime.sendMessage({
                        type: 'log',
                        text: `[导出] 文件名: ${filename}`,
                        level: 'info'
                    });
                } catch (e) { }

                // 在 Service Worker 中，需要将 Blob 转换为 data URL
                // 因为 URL.createObjectURL 在 Service Worker 中不可用
                // 使用 Promise 包装 FileReader 操作
                const dataUrl = await new Promise((resolve, reject) => {
                    const reader = new FileReader();
                    reader.onloadend = () => {
                        if (reader.error) {
                            reject(new Error('读取文件失败: ' + reader.error));
                        } else {
                            resolve(reader.result);
                        }
                    };
                    reader.onerror = () => {
                        reject(new Error('读取文件失败'));
                    };
                    reader.readAsDataURL(blob);
                });

                const dailyFolder = buildDailyFolderName();
                const downloadPath = `${dailyFolder}/${filename}`;
                console.log('[导出] 准备下载到:', downloadPath);
                await logToPopup(`[导出] 下载参数: filename=${downloadPath}`, 'info');

                // Edge/部分 Chromium 对 data: 下载会忽略 downloads.download 的 filename，导致变成“下载(XX)”
                // 改为使用扩展页（downloader）创建 Blob URL + downloads.download，确保子文件夹/文件名生效
                await chrome.storage.local.set({
                    pendingDownload: {
                        filename: downloadPath,
                        dataUrl: dataUrl,
                        createdAt: Date.now()
                    }
                });

                await logToPopup(`[导出] 触发下载：${filename}`, 'info');
                const downloaderUrl = chrome.runtime.getURL('downloader.html');
                chrome.tabs.create({ url: downloaderUrl, active: false }, () => { });

                sendResponse({
                    success: true,
                    filename: filename,
                    path: `文件将保存到浏览器默认下载目录`
                });
            } catch (error) {
                console.error('[导出] 异常:', error);
                try {
                    chrome.runtime.sendMessage({
                        type: 'log',
                        text: `[导出] ❌ 错误: ${error.message}`,
                        level: 'error'
                    });
                } catch (e) { }
                sendResponse({ success: false, error: error.message });
            }
        })();

        return true; // 保持消息通道开放
    }

    // 处理对比采集请求
    if (message.action === 'startCompareCollection') {
        (async () => {
            try {
                const items = message.items;
                const total = items.length;
                const originalFileName = message.originalFileName || '数据';  // 获取原文件名

                console.log('[对比采集] 开始，共', total, '个商品，原文件名:', originalFileName);

                try {
                    chrome.runtime.sendMessage({
                        type: 'log',
                        text: `[对比采集] 开始采集 ${total} 个商品（并发10个）...`,
                        level: 'info'
                    });
                } catch (e) { }

                const results = [];
                let completed = 0;
                let failed = 0;
                let currentIndex = 0;
                const CONCURRENT_LIMIT = 10;  // 并发10个标签页

                // 并发采集函数
                const processBatch = async () => {
                    while (currentIndex < items.length) {
                        // 检查暂停状态
                        while (isPaused) {
                            await new Promise(resolve => setTimeout(resolve, 500));
                        }

                        // 获取当前批次
                        const batch = [];
                        for (let i = 0; i < CONCURRENT_LIMIT && currentIndex < items.length; i++) {
                            batch.push({ item: items[currentIndex], index: currentIndex });
                            currentIndex++;
                        }

                        if (batch.length === 0) break;

                        try {
                            chrome.runtime.sendMessage({
                                type: 'log',
                                text: `[对比采集] 正在处理第 ${currentIndex - batch.length + 1}-${currentIndex}/${total} 个商品...`,
                                level: 'info'
                            });
                        } catch (e) { }

                        // 并发处理这批
                        const batchPromises = batch.map(async ({ item, index }) => {
                            const url = item.url;

                            try {
                                // 创建标签页
                                const tab = await new Promise((resolve, reject) => {
                                    chrome.tabs.create({ url: url, active: false }, (tab) => {
                                        if (chrome.runtime.lastError) {
                                            reject(new Error(chrome.runtime.lastError.message));
                                        } else {
                                            resolve(tab);
                                        }
                                    });
                                });

                                // 移除固定等待，直接依靠 checkComplete 检测页面加载
                                // await new Promise(resolve => setTimeout(resolve, 2000));

                                // 执行采集脚本
                                const metrics = await new Promise((resolve, reject) => {
                                    const timeout = setTimeout(() => {
                                        reject(new Error('采集超时'));
                                    }, 15000);

                                    const checkComplete = () => {
                                        chrome.tabs.get(tab.id, (tabInfo) => {
                                            if (chrome.runtime.lastError) {
                                                clearTimeout(timeout);
                                                reject(new Error('标签页已关闭'));
                                                return;
                                            }
                                            if (tabInfo.status === 'complete') {
                                                // 极限优化：使用最小延迟（30ms）确保DOM渲染完成
                                                setTimeout(() => {
                                                    // 注入脚本提取数据 - 🔧 必须在 MAIN 世界执行才能访问 API 拦截数据！
                                                    chrome.scripting.executeScript({
                                                        target: { tabId: tab.id },
                                                        func: extractDetailMetricsInPage,
                                                        world: "MAIN"  // 🆕 关键！在 MAIN 世界执行
                                                    }, (results) => {
                                                        clearTimeout(timeout);
                                                        // 立即关闭标签页
                                                        chrome.tabs.remove(tab.id, () => { });

                                                        if (chrome.runtime.lastError || !results || !results[0]) {
                                                            reject(new Error('提取失败'));
                                                        } else {
                                                            resolve(results[0].result);
                                                        }
                                                    });
                                                }, 30);
                                            } else {
                                                // 极限优化：检查间隔减少到50ms
                                                setTimeout(checkComplete, 50);
                                            }
                                        });
                                    };
                                    // 立即开始检查
                                    checkComplete();
                                });

                                // 解析新数据
                                const newWant = parseCountToInt(metrics.want || '0');
                                const newView = parseCountToInt(metrics.view || '0');
                                const newRate = (newView > 0 && newWant > 0) ?
                                    ((newWant / newView) * 100).toFixed(2) + '%' : '0%';

                                // 计算差值
                                const wantDiff = newWant - item.原想要;
                                const viewDiff = newView - item.原浏览量;

                                // 计算时间差（小时）
                                const oldTime = parseCollectionTime(item.原采集时间);
                                const newTime = new Date();
                                const hoursDiff = (newTime - oldTime) / (1000 * 60 * 60);

                                console.log('[对比] 时间计算:', item.原采集时间, '→', oldTime, '时间差:', hoursDiff, '小时');

                                // 每小时增长率计算
                                // - 时间差为0时，直接显示0（无法计算增长率）
                                // - 正常计算，结果小于0.01时显示0
                                let wantPerHour = '0';
                                let viewPerHour = '0';
                                if (hoursDiff > 0.001) {  // 避免除以接近0的数
                                    const wantRate = wantDiff / hoursDiff;
                                    const viewRate = viewDiff / hoursDiff;
                                    wantPerHour = Math.abs(wantRate) < 0.01 ? '0' : wantRate.toFixed(2);
                                    viewPerHour = Math.abs(viewRate) < 0.01 ? '0' : viewRate.toFixed(2);
                                }

                                // 检测商品状态：如果想要或浏览量减少（负增长），可能已删除或下架
                                let itemStatus = '';
                                if (wantDiff < 0 || viewDiff < 0) {
                                    itemStatus = '删除或下架';
                                }

                                // 生成新采集时间
                                const month = String(newTime.getMonth() + 1).padStart(2, '0');
                                const day = String(newTime.getDate()).padStart(2, '0');
                                const hour = String(newTime.getHours()).padStart(2, '0');
                                const minute = String(newTime.getMinutes()).padStart(2, '0');
                                const newTimeStr = `${month}-${day} ${hour}:${minute}`;

                                results.push({
                                    卖家昵称: item.原卖家昵称 || metrics.sellerNickname || '',
                                    标题: item.原标题,
                                    原想要: item.原想要,
                                    新想要: newWant,
                                    想要增长: wantDiff >= 0 ? `+${wantDiff}` : String(wantDiff),
                                    原浏览量: item.原浏览量,
                                    新浏览量: newView,
                                    浏览量增长: viewDiff >= 0 ? `+${viewDiff}` : String(viewDiff),
                                    原询单率: item.原询单率,
                                    新询单率: newRate,
                                    原采集时间: item.原采集时间,
                                    新采集时间: newTimeStr,
                                    时间差小时: hoursDiff.toFixed(1),
                                    每小时想要增长: wantPerHour,
                                    每小时浏览增长: viewPerHour,
                                    商品链接: url
                                });

                                completed++;

                                try {
                                    chrome.runtime.sendMessage({
                                        type: 'log',
                                        text: `[对比采集] [${i + 1}/${total}] ✅ 想要: ${item.原想要}→${newWant} (${wantDiff >= 0 ? '+' : ''}${wantDiff})`,
                                        level: 'success'
                                    });
                                } catch (e) { }

                            } catch (error) {
                                failed++;
                                console.error('[对比采集] 商品采集失败:', url, error);

                                // 即使失败也记录原始数据
                                results.push({
                                    卖家昵称: item.原卖家昵称,
                                    标题: item.原标题,
                                    原想要: item.原想要,
                                    新想要: '采集失败',
                                    想要增长: '-',
                                    原浏览量: item.原浏览量,
                                    新浏览量: '采集失败',
                                    浏览量增长: '-',
                                    原询单率: item.原询单率,
                                    新询单率: '-',
                                    原采集时间: item.原采集时间,
                                    新采集时间: '-',
                                    时间差小时: '-',
                                    每小时想要增长: '-',
                                    每小时浏览增长: '-',
                                    商品链接: url
                                });

                                try {
                                    chrome.runtime.sendMessage({
                                        type: 'log',
                                        text: `[对比采集] [${i + 1}/${total}] ❌ 采集失败: ${error.message}`,
                                        level: 'error'
                                    });
                                } catch (e) { }
                            }

                            return { completed: true };
                        });

                        // 等待当前批次完成
                        await Promise.all(batchPromises);

                        // 🆕 等待一段时间确保所有标签页都已关闭，再开始下一批
                        if (currentIndex < items.length) {
                            try {
                                chrome.runtime.sendMessage({
                                    type: 'log',
                                    text: `[对比采集] ⏳ 批次完成，等待1秒后开始下一批...`,
                                    level: 'info'
                                });
                            } catch (e) { }
                            await new Promise(resolve => setTimeout(resolve, 1000));
                        }
                    }
                };

                // 执行并发采集
                await processBatch();

                // 生成对比结果CSV并下载
                try {
                    chrome.runtime.sendMessage({
                        type: 'log',
                        text: `[对比采集] 正在生成对比结果文件...`,
                        level: 'info'
                    });
                } catch (e) { }

                // 生成CSV
                const headers = Object.keys(results[0] || {});
                let csvContent = '\uFEFF' + headers.join(',') + '\n';

                for (const row of results) {
                    const values = headers.map(h => {
                        let val = row[h] || '';

                        // 商品链接列使用HYPERLINK公式格式
                        if (h === '商品链接' && val && val.startsWith('http')) {
                            const escapedUrl = String(val).replace(/"/g, '""');
                            return `"=HYPERLINK(""${escapedUrl}"",""点击打开"")"`;
                        }

                        val = String(val).replace(/"/g, '""');
                        if (val.includes(',') || val.includes('"') || val.includes('\n')) {
                            val = `"${val}"`;
                        }
                        return val;
                    });
                    csvContent += values.join(',') + '\n';
                }

                const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8' });

                // 生成文件名（使用原文件名）
                const filename = `对比-${originalFileName}.csv`;

                // 下载文件
                const dataUrl = await new Promise((resolve, reject) => {
                    const reader = new FileReader();
                    reader.onloadend = () => resolve(reader.result);
                    reader.onerror = () => reject(new Error('读取失败'));
                    reader.readAsDataURL(blob);
                });

                const dailyFolder = buildDailyFolderName();
                await chrome.storage.local.set({
                    pendingDownload: {
                        filename: `${dailyFolder}/${filename}`,
                        dataUrl: dataUrl,
                        createdAt: Date.now()
                    }
                });

                const downloaderUrl = chrome.runtime.getURL('downloader.html');
                chrome.tabs.create({ url: downloaderUrl, active: false }, () => { });

                try {
                    chrome.runtime.sendMessage({
                        type: 'log',
                        text: `[对比采集] ✅ 完成！成功: ${completed}，失败: ${failed}`,
                        level: 'success'
                    });
                    chrome.runtime.sendMessage({
                        type: 'log',
                        text: `[对比采集] 📁 文件已保存: ${filename}`,
                        level: 'info'
                    });
                    chrome.runtime.sendMessage({
                        type: 'compareComplete',
                        count: results.length
                    });
                } catch (e) { }

            } catch (error) {
                console.error('[对比采集] 异常:', error);
                try {
                    chrome.runtime.sendMessage({
                        type: 'log',
                        text: `[对比采集] ❌ 错误: ${error.message}`,
                        level: 'error'
                    });
                    chrome.runtime.sendMessage({
                        type: 'compareComplete',
                        count: 0
                    });
                } catch (e) { }
            }
        })();

        sendResponse({ success: true });
        return true;
    }
});
