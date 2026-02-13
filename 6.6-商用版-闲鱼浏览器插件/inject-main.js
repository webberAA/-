// inject-main.js
// 注入到 MAIN 世界，Hook 闲鱼 API 获取精确的 publishTime、wantNum、userNick 等数据
// 版本：V6.7.2 - 修复想要数和卖家昵称路径

(function () {
    'use strict';

    console.log('[闲鱼助手] 🔧 MAIN 世界脚本已注入 - 准备拦截 API');

    // 存储已拦截的商品数据（避免重复发送）
    const interceptedItems = new Set();

    // 清理存储（5分钟后清除）
    setInterval(() => {
        interceptedItems.clear();
    }, 5 * 60 * 1000);

    // =========================
    // 从 fishTags 中提取"想要"数
    // 格式: "1176人想要" -> "1176"
    // =========================
    function extractWantNumFromFishTags(exContent) {
        try {
            // 路径: exContent.fishTags.r3.tagList[].data.content
            const tagList = exContent?.fishTags?.r3?.tagList || [];
            for (const tag of tagList) {
                const content = tag?.data?.content || '';
                // 匹配 "1176人想要" 或 "1.5万人想要"
                const match = content.match(/^([\d.]+万?)人想要$/);
                if (match) {
                    console.log('[闲鱼助手] 提取想要数:', match[1], '原文:', content);
                    return match[1];
                }
            }
        } catch (e) {
            console.warn('[闲鱼助手] 提取想要数失败:', e);
        }
        return '0';
    }

    // =========================
    // 通用的商品数据提取函数
    // =========================
    function extractItemsFromData(data) {
        let items = [];

        // 尝试多种可能的路径
        const possiblePaths = [
            data?.data?.resultList,
            data?.data?.resultList?.data?.listItem,
            data?.data?.itemList,
            data?.data?.items,
            data?.data?.list,
            data?.resultList,
        ];

        for (const arr of possiblePaths) {
            if (Array.isArray(arr) && arr.length > 0) {
                items = arr;
                console.log('[闲鱼助手] ✅ 找到商品数组，长度:', arr.length);
                break;
            }
        }

        // 深度搜索
        if (items.length === 0) {
            console.log('[闲鱼助手] ⚠️ 常规路径未找到，尝试深度搜索...');

            const searchArrays = (obj, depth = 0) => {
                if (depth > 3 || !obj || typeof obj !== 'object') return null;

                for (const key of Object.keys(obj)) {
                    const val = obj[key];
                    if (Array.isArray(val) && val.length > 0) {
                        const first = val[0];
                        if (first?.data?.item?.main?.clickParam?.args?.publishTime ||
                            first?.item?.main?.clickParam?.args?.publishTime) {
                            console.log(`[闲鱼助手] ✅ 深度搜索找到: ${key}, 长度: ${val.length}`);
                            return val;
                        }
                    } else if (typeof val === 'object') {
                        const found = searchArrays(val, depth + 1);
                        if (found) return found;
                    }
                }
                return null;
            };

            items = searchArrays(data?.data) || [];
        }

        return items;
    }

    // =========================
    // 从商品 wrapper 中提取数据
    // =========================
    function processItem(itemWrapper, index) {
        // 兼容多种结构
        const item = itemWrapper?.data?.item || itemWrapper?.item || itemWrapper;
        if (!item) return null;

        // 从 clickParam.args 提取基础数据
        const args = item?.main?.clickParam?.args || {};
        const exContent = item?.main?.exContent || {};

        const itemId = args.id || args.item_id;
        if (!itemId) return null;

        // 避免重复
        if (interceptedItems.has(itemId)) return null;
        interceptedItems.add(itemId);

        // ========== 核心数据提取 ==========

        // 1. 发布时间 (精确时间戳)
        const publishTime = args.publishTime || '';

        // 2. 想要数 - 从 fishTags.r3 提取 "1176人想要"
        const wantNum = extractWantNumFromFishTags(exContent);

        // 3. 卖家昵称 - 🆕 尝试多个可能的路径
        // 路径优先级：userNickName > userNick（多个位置都尝试）
        const userNick =
            exContent?.detailParams?.userNickName ||  // 路径1
            exContent?.userNickName ||                 // 路径2（直接在 exContent 下）
            item?.userNickName ||                      // 路径3（直接在 item 下）
            args?.userNickName ||                      // 路径4（在 args 下）
            exContent?.detailParams?.userNick ||       // 路径5（备选字段）
            exContent?.userNick ||                     // 路径6
            args?.userNick ||                          // 路径7
            '';

        // 4. 价格 - 从 args 或 detailParams 提取（备用，主要还是详情页采集）
        const price = args.price || exContent?.detailParams?.soldPrice || '';

        // 5. 标题
        const title = exContent?.detailParams?.title || item?.title || '';

        // =====================================

        const apiData = {
            itemId: itemId,
            publishTime: publishTime,
            wantNum: wantNum,
            userNick: userNick,
            price: price,
            title: title,
            sellerId: args.seller_id,
            keyword: args.keyword,
            position: args.position || args.index,
            catId: args.catId,
            area: exContent?.area || '',
            // 🆕 尝试提取封面图URL
            coverImage: exContent?.detailParams?.picUrl || exContent?.picUrl || item?.picUrl || args?.picUrl || '',
        };

        console.log(`[闲鱼助手] 📦 [${index + 1}] ID:${itemId} | 发布时间:${publishTime} | 想要:${wantNum} | 卖家:${userNick}`);

        return apiData;
    }

    // =========================
    // Hook window.fetch
    // =========================
    const originalFetch = window.fetch;

    window.fetch = async function (...args) {
        const response = await originalFetch(...args);
        const url = typeof args[0] === 'string' ? args[0] : args[0]?.url;

        // 🎯 拦截搜索页 API
        if (url && url.includes('mtop.taobao.idlemtopsearch.pc.search')) {
            try {
                const clonedResponse = response.clone();
                const text = await clonedResponse.text();

                let data;
                try {
                    data = JSON.parse(text);
                } catch (e) {
                    return response;
                }

                const items = extractItemsFromData(data);
                console.log(`[闲鱼助手] 🎯 [Fetch] 拦截到 ${items.length} 个商品数据`);

                let successCount = 0;
                items.forEach((itemWrapper, index) => {
                    try {
                        const apiData = processItem(itemWrapper, index);
                        if (apiData) {
                            successCount++;
                            window.dispatchEvent(new CustomEvent('GOOFISH_API_INTERCEPTED', {
                                detail: apiData
                            }));
                        }
                    } catch (err) {
                        console.error('[闲鱼助手] 处理商品失败:', err);
                    }
                });

                console.log(`[闲鱼助手] ✅ [Fetch] 成功处理 ${successCount} 个商品`);

            } catch (error) {
                console.error('[闲鱼助手] Fetch Hook 错误:', error);
            }
        }

        // 🆕 拦截详情页 API
        if (url && url.includes('mtop.taobao.idle.pc.detail')) {
            try {
                const clonedResponse = response.clone();
                const text = await clonedResponse.text();
                const data = JSON.parse(text);
                processDetailApiData(data, 'Fetch');
            } catch (error) {
                console.error('[闲鱼助手] [Fetch] 详情页 Hook 错误:', error);
            }
        }

        return response;
    };

    // =========================
    // Hook XMLHttpRequest
    // =========================
    const originalOpen = XMLHttpRequest.prototype.open;
    const originalSend = XMLHttpRequest.prototype.send;

    XMLHttpRequest.prototype.open = function (method, url, ...rest) {
        this._url = url;
        return originalOpen.apply(this, [method, url, ...rest]);
    };

    XMLHttpRequest.prototype.send = function (...args) {
        // 🎯 拦截搜索页 API
        if (this._url && this._url.includes('mtop.taobao.idlemtopsearch.pc.search')) {
            this.addEventListener('load', function () {
                try {
                    const data = JSON.parse(this.responseText);
                    const items = extractItemsFromData(data);

                    console.log(`[闲鱼助手] 🎯 [XHR] 拦截到 ${items.length} 个商品数据`);

                    let successCount = 0;
                    items.forEach((itemWrapper, index) => {
                        try {
                            const apiData = processItem(itemWrapper, index);
                            if (apiData) {
                                successCount++;
                                window.dispatchEvent(new CustomEvent('GOOFISH_API_INTERCEPTED', {
                                    detail: apiData
                                }));
                            }
                        } catch (err) {
                            console.error('[闲鱼助手] [XHR] 处理商品失败:', err);
                        }
                    });

                    console.log(`[闲鱼助手] ✅ [XHR] 成功处理 ${successCount} 个商品`);

                } catch (error) {
                    console.error('[闲鱼助手] [XHR] Hook 错误:', error);
                }
            });
        }

        // 🆕 拦截详情页 API
        if (this._url && this._url.includes('mtop.taobao.idle.pc.detail')) {
            this.addEventListener('load', function () {
                try {
                    const data = JSON.parse(this.responseText);
                    processDetailApiData(data, 'XHR');
                } catch (error) {
                    console.error('[闲鱼助手] [XHR] 详情页 Hook 错误:', error);
                }
            });
        }

        return originalSend.apply(this, args);
    };

    // =========================
    // 🆕 详情页 API 数据处理
    // =========================
    function processDetailApiData(data, source) {
        try {
            const itemDO = data?.data?.itemDO;
            if (!itemDO) {
                console.warn('[闲鱼助手] 详情页 API 无 itemDO 数据');
                return;
            }

            const detailData = {
                itemId: String(itemDO.itemId || ''),
                browseCnt: itemDO.browseCnt || 0,          // 精确浏览量
                wantCnt: itemDO.wantCnt || 0,              // 精确想要数
                soldPrice: itemDO.soldPrice || '',         // 价格
                title: itemDO.title || '',
                publishTime: itemDO.GMT_CREATE_DATE_KEY || '', // 精确发布时间 "2025-12-12 10:39:05"
                gmtCreate: itemDO.gmtCreate || 0,          // 时间戳
                // 🆕 提取封面图URL
                coverImage: itemDO.picUrl || itemDO.mainPicUrl || itemDO.imageUrl || '',
                // 🆕 提取商品描述
                description: itemDO.desc || itemDO.description || '',
            };

            console.log(`[闲鱼助手] 📦 [${source}] 详情页数据: ID:${detailData.itemId} | 浏览:${detailData.browseCnt} | 想要:${detailData.wantCnt} | 价格:${detailData.soldPrice} | 发布:${detailData.publishTime}`);

            // 🔧 存储到全局变量，供 extractDetailMetricsInPage 读取
            window.__GOOFISH_DETAIL_API_DATA__ = detailData;

            // 同时发送 CustomEvent
            window.dispatchEvent(new CustomEvent('GOOFISH_DETAIL_API_INTERCEPTED', {
                detail: detailData
            }));

        } catch (error) {
            console.error('[闲鱼助手] 处理详情页 API 数据失败:', error);
        }
    }

    console.log('[闲鱼助手] ✅ API 拦截器已激活（搜索页 + 详情页）');
    window.dispatchEvent(new CustomEvent('GOOFISH_MAIN_READY'));

})();
