// ===========================================
// 替换 background.js 中的 loadExcelJS 函数
// 找到第 228 行开始的 loadExcelJS 函数
// 用下面的代码完全替换（一直到函数结束）
// ===========================================

// 加载ExcelJS库（使用 importScripts，符合 CSP 策略）
async function loadExcelJS() {
    // 如果已经加载，直接返回
    if (cachedExcelJS) {
        console.log('[导出] 使用已缓存的ExcelJS');
        return cachedExcelJS;
    }

    // 如果正在加载，等待加载完成
    if (isExcelJSLoading && excelJSLoadPromise) {
        console.log('[导出] ExcelJS正在加载中，等待完成...');
        return await excelJSLoadPromise;
    }

    // 开始加载
    isExcelJSLoading = true;
    excelJSLoadPromise = (async () => {
        try {
            console.log('[导出] 开始加载ExcelJS库...');

            // 方法1：尝试从本地文件加载（使用 importScripts）
            try {
                const localUrl = chrome.runtime.getURL('exceljs.min.js');
                console.log('[导出] 本地库路径:', localUrl);

                // 使用 importScripts 加载本地文件（符合 CSP）
                console.log('[导出] 使用 importScripts 加载...');
                importScripts(localUrl);

                // 检查 ExcelJS 是否已加载
                if (typeof ExcelJS !== 'undefined') {
                    console.log('[导出] ✅ ExcelJS 本地库加载成功');
                    cachedExcelJS = ExcelJS;
                    isExcelJSLoading = false;
                    return ExcelJS;
                }

                throw new Error('ExcelJS 对象未定义');

            } catch (localError) {
                console.warn('[导出] 本地库加载失败:', localError.message);

                // 方法2：尝试从 CDN 下载到 Blob，然后使用 importScripts
                console.log('[导出] 尝试从CDN下载...');

                const cdnUrls = [
                    'https://cdn.jsdelivr.net/npm/exceljs@4.4.0/dist/exceljs.min.js',
                    'https://cdnjs.cloudflare.com/ajax/libs/exceljs/4.4.0/exceljs.min.js',
                    'https://unpkg.com/exceljs@4.4.0/dist/exceljs.min.js'
                ];

                let scriptText = null;

                for (let i = 0; i < cdnUrls.length; i++) {
                    const url = cdnUrls[i];
                    try {
                        console.log(`[导出] 尝试CDN ${i + 1}/${cdnUrls.length}:`, url);
                        const response = await fetch(url);

                        if (!response.ok) {
                            throw new Error(`HTTP ${response.status}`);
                        }

                        scriptText = await response.text();

                        if (!scriptText || scriptText.length < 1000) {
                            throw new Error('文件太小');
                        }

                        console.log(`[导出] ✅ CDN ${i + 1} 下载成功，大小:`, scriptText.length);
                        break;
                    } catch (error) {
                        console.warn(`[导出] ❌ CDN ${i + 1} 失败:`, error.message);
                        if (i === cdnUrls.length - 1) {
                            throw new Error('所有CDN源均无法访问: ' + error.message);
                        }
                    }
                }

                if (!scriptText) {
                    throw new Error('无法下载ExcelJS');
                }

                // 创建 Blob URL 并使用 importScripts
                const blob = new Blob([scriptText], { type: 'application/javascript' });
                const blobUrl = URL.createObjectURL(blob);

                try {
                    console.log('[导出] 使用 Blob URL 加载...');
                    importScripts(blobUrl);

                    if (typeof ExcelJS !== 'undefined') {
                        console.log('[导出] ✅ ExcelJS 从CDN加载成功');
                        console.warn('[导出] 💡 建议：将下载的库保存到插件目录的 exceljs.min.js 文件中');
                        cachedExcelJS = ExcelJS;
                        isExcelJSLoading = false;
                        return ExcelJS;
                    }

                    throw new Error('ExcelJS 对象未定义');
                } finally {
                    URL.revokeObjectURL(blobUrl);
                }
            }

        } catch (error) {
            isExcelJSLoading = false;
            console.error('[导出] ❌ ExcelJS加载彻底失败:', error);
            console.error('[导出] 错误详情:', error.message);
            throw error;
        }
    })();

    return await excelJSLoadPromise;
}
