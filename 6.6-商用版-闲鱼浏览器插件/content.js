// content.js - 在闲鱼页面中运行 (ISOLATED 世界)
// 基于原Python代码逻辑重写
// 版本：6.7.7 - 修复对比采集

console.log('[闲鱼助手] Content Script 已加载 - V6.7.7');

let isCollecting = false;
let collectedItems = [];

// =========================
// 🆕 API 拦截数据缓存
// 用于存储从 MAIN 世界拦截到的精确数据
// =========================
const apiDataCache = new Map(); // key: itemId, value: { publishTime, wantNum, price, ... }
let mainWorldReady = false;

// 监听 MAIN 世界的数据
window.addEventListener('GOOFISH_API_INTERCEPTED', (event) => {
    const data = event.detail;
    if (data && data.itemId) {
        apiDataCache.set(data.itemId, data);
        console.log(`[API缓存] 📥 ID:${data.itemId} | 发布时间:${data.publishTime} | 想要:${data.wantNum} | 卖家:${data.userNick || '未知'}`);
    }
});

// 监听 MAIN 世界就绪事件
window.addEventListener('GOOFISH_MAIN_READY', () => {
    mainWorldReady = true;
    console.log('[闲鱼助手] ✅ MAIN 世界脚本已就绪，API 拦截器激活');
});

// 🆕 根据商品ID获取精确的API数据
function getApiDataByItemId(itemId) {
    if (!itemId) return null;
    return apiDataCache.get(itemId) || apiDataCache.get(String(itemId)) || null;
}

// 🆕 根据商品链接提取 itemId
function extractItemIdFromUrl(url) {
    if (!url) return null;
    try {
        const u = new URL(url);
        // 优先从 query 参数获取
        const queryId = u.searchParams.get('id');
        if (queryId) return queryId;
        // 从路径获取 /item/xxxxx
        const pathMatch = u.pathname.match(/\/item\/(\d+)/);
        if (pathMatch) return pathMatch[1];
    } catch (e) { }
    // 正则兜底
    const match = url.match(/[?&]id=(\d+)/) || url.match(/\/item\/(\d+)/);
    return match ? match[1] : null;
}

// 🆕 将时间戳转换为格式化时间 (publishTime: "1761200924000" -> "2025/10/23 15:28")
function formatTimestamp(timestamp) {
    if (!timestamp) return "";
    try {
        const ts = parseInt(timestamp);
        if (isNaN(ts) || ts <= 0) return "";
        const date = new Date(ts);
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        const hours = String(date.getHours()).padStart(2, '0');
        const minutes = String(date.getMinutes()).padStart(2, '0');
        return `${year}/${month}/${day} ${hours}:${minutes}`;
    } catch (e) {
        return "";
    }
}

// =========================
// 文本/数字工具（对应原Python代码）
// =========================
function cleanOneLine(s) {
    if (!s) return "";
    return s.replace(/\r/g, " ").replace(/\n/g, " ").replace(/\t/g, " ")
        .replace(/\s+/g, " ").trim();
}

function ensureAbsoluteUrl(url) {
    if (!url) return "";
    url = url.trim();
    if (url.startsWith("//")) return "https:" + url;
    if (url.startsWith("/")) return "https://www.goofish.com" + url;
    return url;
}

// =========================
// 列表页：提取“发布时间”（如：5小时前发布/10分钟前发布/1天前发布/刚刚发布）
// 注意：该信息进入详情页会消失，必须在列表页提前采集
// =========================
function extractPublishTimeFromAnchor(anchor) {
    if (!anchor) return "";

    const normalize = (v) => cleanOneLine(v || "");
    const isPublishText = (t) => {
        const s = normalize(t);
        if (!s) return false;
        // 常见：5小时前发布 / 10分钟前发布 / 1天前发布 / 刚刚发布
        if (/发布$/.test(s) && (/(刚刚|\d+\s*(分钟|小时|天|周|月)前)/.test(s) || /小时前/.test(s) || /分钟前/.test(s))) {
            return true;
        }
        // 兜底：包含“发布”且包含“前”
        if (s.includes("发布") && s.includes("前")) return true;
        return false;
    };

    // 1) 优先抓 title 属性（截图里的 span.title="5小时前发布"）
    const titleCandidates = anchor.querySelectorAll('[title*="发布"]');
    for (const el of titleCandidates) {
        const t = normalize(el.getAttribute("title"));
        if (isPublishText(t)) return t;
    }

    // 2) 再抓文本内容（有些页面不放在 title）
    const textCandidates = anchor.querySelectorAll('span, div, p, em, i');
    for (const el of textCandidates) {
        const t = normalize(el.innerText || el.textContent || "");
        if (isPublishText(t)) return t;
    }

    return "";
}

// =========================
// URL 判定：是否为闲鱼“商品详情页”链接
// 规则：必须是 goofish.com 域名，路径为 /item 或 /item/... 或 item.htm
// 且必须包含商品 id（query 参数 id），或路径型 id（/item/xxxx）
// =========================
function isGoofishItemDetailUrl(rawUrl) {
    if (!rawUrl) return false;
    try {
        const u = new URL(rawUrl);
        const hostOk = u.hostname === 'www.goofish.com' || u.hostname.endsWith('.goofish.com');
        if (!hostOk) return false;

        const p = u.pathname || "";
        const hasQueryId = !!u.searchParams.get('id');
        const hasPathId = /^\/item\/[^/]+/.test(p); // /item/xxxx
        const isItemPath = p === '/item' || p.startsWith('/item/');
        const isItemHtml = /item\.htm$/i.test(p);

        if (isItemHtml) return hasQueryId; // item.htm 必须带 ?id=
        if (isItemPath) return hasQueryId || hasPathId; // /item 必须带 id 或 /item/xxxx
        return false;
    } catch (e) {
        return false;
    }
}

function parseCountToInt(text) {
    // '1.7万'/'11万'/'17000' -> int
    const t = cleanOneLine(text);
    if (!t) return 0;

    const m = t.match(/(\d+(?:\.\d+)?)\s*万/);
    if (m) {
        return Math.floor(parseFloat(m[1]) * 10000);
    }

    const m2 = t.match(/(\d+)/);
    return m2 ? parseInt(m2[1]) : 0;
}

function formatCountWan(n) {
    if (n <= 0) return "";
    if (n >= 10000) {
        const v = n / 10000.0;
        let s = v.toFixed(1);
        if (s.endsWith(".0")) s = s.slice(0, -2);
        return s + "万";
    }
    return String(n);
}

function calcInquiryRate(wantInt, viewInt) {
    if (viewInt <= 0 || wantInt <= 0) return "";
    return ((wantInt / viewInt) * 100).toFixed(2) + "%";
}

function isSearchPage() {
    try {
        const u = new URL(window.location.href);
        return u.hostname.endsWith('.goofish.com') && u.pathname === '/search';
    } catch (e) {
        return window.location.href.includes('/search');
    }
}

function isPersonalPage() {
    try {
        const u = new URL(window.location.href);
        return u.hostname.endsWith('.goofish.com') && (u.pathname === '/personal' || u.pathname.startsWith('/personal/'));
    } catch (e) {
        return window.location.href.includes('/personal');
    }
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// =========================
// 记录“最近一次搜索关键词”（用于导出文件命名：搜索关键词 + 采集时间）
// 说明：很多场景是从搜索页点进详情页后才点击采集，此时需要从这里回溯关键词
// =========================
(function rememberLastSearchKeyword() {
    try {
        if (!isSearchPage()) return;
        const u = new URL(window.location.href);
        const q = (u.searchParams.get('q') || u.searchParams.get('keyword') || u.searchParams.get('query') || "").trim();
        // 兜底：从搜索框取值（不同版本可能 input 结构不同）
        let inputVal = "";
        const input = document.querySelector('input[type="search"], input[placeholder*="搜索"], input[class*="search"]');
        if (input) {
            inputVal = (input.value || input.getAttribute('value') || "").trim();
        }
        const keyword = q || inputVal;
        if (!keyword) return;

        chrome.storage?.local?.set?.({
            lastSearchKeyword: keyword,
            lastSearchUpdatedAt: Date.now()
        });
    } catch (e) {
        // ignore
    }
})();

// 个人主页常见为“内部滚动容器 + 虚拟列表（DOM 回收）”，需要找到主滚动容器并边滚边累计
function findMainScrollableContainer() {
    try {
        const divs = Array.from(document.querySelectorAll('div')).slice(0, 2500);
        let best = null;
        let bestScore = 0;
        for (const el of divs) {
            const cs = getComputedStyle(el);
            if (!(cs.overflowY === 'auto' || cs.overflowY === 'scroll')) continue;
            if (el.scrollHeight <= el.clientHeight + 200) continue;
            const score = el.clientHeight * el.clientWidth;
            if (score > bestScore) {
                best = el;
                bestScore = score;
            }
        }
        return best;
    } catch (e) {
        return null;
    }
}

// 尝试从个人主页页面元素中解析“总商品数/在售数”等（用于判断是否采全）
function getExpectedItemCountFromPage() {
    if (!isPersonalPage()) return 0;
    try {
        const els = Array.from(document.querySelectorAll('a,button,span,div,p')).slice(0, 3000);
        let max = 0;
        for (const el of els) {
            const t = cleanOneLine(el.innerText || el.textContent || "");
            if (!t) continue;
            // 只看可能包含数量的标签/文案，降低误判
            if (!(t.includes("在售") || t.includes("出售") || t.includes("发布") || t.includes("商品") || t.includes("宝贝") || t.includes("闲置"))) {
                continue;
            }
            const m = t.match(/(\d{1,4})/); // 1~9999
            if (!m) continue;
            const n = parseInt(m[1]);
            // 限制最大1000，避免误识别浏览量等大数字
            if (!isNaN(n) && n > max && n < 1000) {
                max = n;
            }
        }
        return max;
    } catch (e) {
        return 0;
    }
}

function getFirstVisibleItemLink() {
    try {
        const anchors = document.querySelectorAll('a');
        for (const a of anchors) {
            const href = ensureAbsoluteUrl(a.getAttribute('href') || a.href || "");
            if (isGoofishItemDetailUrl(href)) return href;
        }
    } catch (e) { }
    return "";
}

// 搜索页分页跳转：点击“页码盒子”到指定页
async function goToSearchPage(pageNumber) {
    const target = String(pageNumber);
    const prevHref = window.location.href;
    const prevKey = getFirstVisibleItemLink();

    // 页码通常是 div.search-pagination-page-box--xxxx
    const boxes = Array.from(document.querySelectorAll('div[class*="search-pagination-page-box"]'));
    const targetEl = boxes.find(el => (el.textContent || "").trim() === target);
    if (!targetEl) return false;

    try {
        // 先回到顶部，减少点击被遮挡的概率
        window.scrollTo({ top: 0, behavior: 'auto' });
        await sleep(100);
        targetEl.click();
    } catch (e) {
        return false;
    }

    const start = Date.now();
    const timeout = 15000;
    while (Date.now() - start < timeout) {
        await sleep(300);
        const nowHref = window.location.href;
        const nowKey = getFirstVisibleItemLink();
        // URL 变了或首条商品变了，都认为翻页成功
        if ((nowHref && nowHref !== prevHref) || (nowKey && prevKey && nowKey !== prevKey)) {
            return true;
        }
    }
    return false;
}

// =========================
// 解析：想要 / 浏览 / 价格（详情页）
// =========================
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
        return formatCountWan(Math.floor(parseFloat(m[1]) * 10000));
    }

    const m2 = t.match(/(\d+)\s*浏览/);
    if (m2) {
        return formatCountWan(parseInt(m2[1]));
    }
    return "";
}

function normalizePriceText(t) {
    if (!t) return "";
    return t.replace(/\r/g, "").replace(/\n/g, "").replace(/ /g, "").replace("￥", "¥");
}

function parsePriceText(t) {
    t = normalizePriceText(t);
    if (!t) return "";

    // 先区间
    const rangeMatch = t.match(/(\d+(?:\.\d+)?)\s*[-~—～至到]\s*(\d+(?:\.\d+)?)/);
    if (rangeMatch) {
        return `${rangeMatch[1]}-${rangeMatch[2]}`;
    }

    // 再单价
    const numMatch = t.match(/(\d+(?:\.\d+)?)/);
    return numMatch ? numMatch[1] : "";
}

// =========================
// 检测是否在“真实商品详情页”（必须带商品 id）
// =========================
function isDetailPage() {
    // 只有真正的商品详情页才返回 true（必须带商品 id）
    // 避免把 https://www.goofish.com/item 当成详情页误采集
    return isGoofishItemDetailUrl(window.location.href);
}

// =========================
// 从详情页提取卖家昵称（精准定位：区分昵称与地区）
// =========================
function extractSellerNicknameFromDetailPage() {
    // 核心修正：精准区分昵称与地区
    // ❌ 严禁抓取包含 item-user-info-label 的元素（这是省份/地区，如"武汉"）
    // ✅ 正确抓取：使用属性选择器精准定位昵称，类名中包含关键字 nick 才是真正的卖家名字
    // 只在 https://www.goofish.com/item 商品详情页执行

    // 首先验证：确保在“真实商品详情页”（必须带 id）
    const url = window.location.href;
    if (!isGoofishItemDetailUrl(url)) {
        console.warn('[详情页采集] 警告：不在详情页，跳过昵称提取');
        return "未知卖家";
    }

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
                                console.log('[详情页采集] ✅ 成功提取卖家昵称:', nick);
                                return nick;
                            }
                        }
                    }
                }
            }
        }
    }

    // 方法2：在 item-user-info 区域查找，但明确排除 label 元素
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
                            console.log('[详情页采集] ✅ 成功提取卖家昵称（方法2）:', nick);
                            return nick;
                        }
                    }
                }
            }
        }
    }

    console.warn('[详情页采集] ⚠️ 未能提取卖家昵称，返回"未知卖家"');
    return "未知卖家";
}

// =========================
// 从详情页提取标题
// =========================
function extractTitleFromDetailPage() {
    // 尝试多个可能的选择器
    const titleSelectors = [
        'h1[class*="title"]',
        'div[class*="title"] h1',
        'div[class*="item-title"]',
        'div[class*="product-title"]',
        'h1',
        'div[class*="name"]'
    ];

    for (const selector of titleSelectors) {
        const el = document.querySelector(selector);
        if (el) {
            const title = el.getAttribute("title") || el.innerText || el.textContent || "";
            if (title) {
                const cleaned = cleanOneLine(title);
                if (cleaned && cleaned.length > 0) {
                    return cleaned;
                }
            }
        }
    }

    // 兜底：从document.title提取
    const docTitle = document.title || "";
    if (docTitle && !docTitle.includes('闲鱼')) {
        return cleanOneLine(docTitle);
    }

    return "";
}

// =========================
// 详情页提取（对应原Python的 extract_detail_metrics）
// =========================
function extractDetailMetrics() {
    // 等待关键区域出现
    const waitForSelector = (selector, timeout = 8000) => {
        const start = Date.now();
        while (Date.now() - start < timeout) {
            const el = document.querySelector(selector);
            if (el) return el;
            // 简单等待
            const end = Date.now() + 100;
            while (Date.now() < end) { }
        }
        return null;
    };

    waitForSelector('div[class^="item-main-info--"]');

    // 全局文本（兜底用）
    let bodyText = "";
    try {
        bodyText = cleanOneLine(document.body.innerText || "");
    } catch (e) {
        bodyText = "";
    }

    // 1) 价格（强优先：详情页大号 price--）
    let price = "";
    const priceSelectors = ['div[class^="price--"]', '*[class^="price--"]'];

    for (const sel of priceSelectors) {
        const el = document.querySelector(sel);
        if (el) {
            price = parsePriceText(el.innerText || "");
            if (price) break;
        }
    }

    // 再兜底：price-wrap
    if (!price) {
        const priceWrap = document.querySelector('div[class^="price-wrap--"]');
        if (priceWrap) {
            price = parsePriceText(priceWrap.innerText || "");
        }
    }

    // 2) 想要/浏览：只在"want--"统计区抓，不要从整个页面查找（避免误匹配）
    let statText = "";
    const wantBox = document.querySelector('div[class^="want--"]');
    if (wantBox) {
        statText = cleanOneLine(wantBox.innerText || "");
    }

    // 只在统计区域查找"想要"，不要从bodyText查找（避免误匹配其他数字）
    const want = parseWantFromText(statText);
    const view = parseViewFromText(statText) || parseViewFromText(bodyText);

    return { price, want, view };
}

// =========================
// 详情页精准采集：提取完整数据（标题、价格、想要、浏览量、询单率、卖家昵称）
// =========================
function extractFullDataFromDetailPage() {
    // 等待页面关键元素加载
    const waitForElement = (selector, timeout = 5000) => {
        const start = Date.now();
        while (Date.now() - start < timeout) {
            const el = document.querySelector(selector);
            if (el) return el;
            const end = Date.now() + 50;
            while (Date.now() < end) { }
        }
        return null;
    };

    // 等待关键区域加载
    waitForElement('div[class^="item-main-info--"]');

    // 1. 精准提取卖家昵称：class包含item-user-info-nick
    const sellerNickname = extractSellerNicknameFromDetailPage();

    // 2. 精准提取标题
    const title = extractTitleFromDetailPage();

    // 3. 精准提取价格
    let price = "";
    const priceSelectors = [
        'div[class^="price--"]',
        '*[class^="price--"]',
        'div[class^="price-wrap--"]'
    ];
    for (const sel of priceSelectors) {
        const el = document.querySelector(sel);
        if (el) {
            price = parsePriceText(el.innerText || "");
            if (price) break;
        }
    }

    // 4. 精准提取想要数和浏览量
    let statText = "";
    const wantBox = document.querySelector('div[class^="want--"]');
    if (wantBox) {
        statText = cleanOneLine(wantBox.innerText || "");
    }

    const want = parseWantFromText(statText) || "0";
    const view = parseViewFromText(statText) || "";

    // 5. 计算询单率
    const wantInt = parseCountToInt(want);
    const viewInt = parseCountToInt(view);
    let inquiryRate = "0%";

    if (wantInt > 0 && viewInt > 0) {
        // 验证：浏览量一定大于想要数
        if (viewInt >= wantInt) {
            inquiryRate = calcInquiryRate(wantInt, viewInt);
        } else {
            // 数据异常，重置为0
            inquiryRate = "0%";
        }
    }

    // 验证数据：如果询单率>100%，说明数据有误
    const rateNum = parseFloat(inquiryRate) || 0;
    if (rateNum > 100) {
        inquiryRate = "0%";
    }

    return {
        "卖家昵称": sellerNickname,
        "标题": title,
        "价格": price || "",
        "想要": want || "0",
        "浏览量": view || "",
        "询单率": inquiryRate,
        "发布时间": "", // 详情页不展示“X小时前发布”，保持为空或由列表页传入
        "商品链接": window.location.href,
        "采集时间": (() => {
            const now = new Date();
            const month = String(now.getMonth() + 1).padStart(2, '0');
            const day = String(now.getDate()).padStart(2, '0');
            const hour = String(now.getHours()).padStart(2, '0');
            const minute = String(now.getMinutes()).padStart(2, '0');
            return `${month}-${day} ${hour}:${minute}`;
        })()
    };
}

// =========================
// 列表页：提取 URL/标题/昵称（对应原Python代码）
// =========================
function extractTitleFromAnchor(anchor) {
    const tloc = anchor.querySelector('div[class^="row1-wrap-title--"]');
    if (!tloc) return "";

    const title = tloc.getAttribute("title") || tloc.innerText || "";
    return cleanOneLine(title);
}

// =========================
// 从列表页/搜索页商品卡片提取"想要"数（精准值）
// 说明：列表页的"想要"数精准到个位数，优先于详情页的四舍五入值
// =========================
function extractWantFromAnchor(anchor) {
    if (!anchor) return "";

    // 方法1：尝试查找商品卡片中特定的统计区域
    const wantSelectors = [
        'div[class*="want"]',
        'span[class*="want"]',
        'div[class*="stat"]',
        'span[class*="stat"]',
        '*[class*="bottom-wrap"]',
        '*[class*="info-wrap"]'
    ];

    for (const selector of wantSelectors) {
        const el = anchor.querySelector(selector);
        if (el) {
            const text = cleanOneLine(el.innerText || el.textContent || "");
            const want = parseWantFromText(text);
            if (want && want !== "" && want !== "0") {
                console.log('[列表页精准采集] 从卡片统计区提取到想要数:', want);
                return want;
            }
        }
    }

    // 方法2：扫描整个卡片的文本内容
    const allText = anchor.innerText || anchor.textContent || "";
    const cleanText = cleanOneLine(allText);
    const want = parseWantFromText(cleanText);

    if (want && want !== "" && want !== "0") {
        console.log('[列表页精准采集] 从卡片文本提取到想要数:', want);
        return want;
    }

    return "";
}

// =========================
// 从列表页/搜索页提取卖家昵称（精准定位：避免提取省份名）
// =========================
function extractSellerNicknameFromAnchor(anchor) {
    let nick = "";

    // 方法1：定位类名包含 seller-info 或 nick 的元素
    const sellerInfoSelectors = [
        'div[class*="seller-info"]',
        '*[class*="seller-info"]',
        'div[class*="nick"]',
        '*[class*="nick"]',
        'div[class^="seller-text-wrap--"]',
        'p[class^="seller-text--"]'
    ];

    for (const selector of sellerInfoSelectors) {
        const el = anchor.querySelector(selector);
        if (el) {
            nick = el.getAttribute("title") || el.innerText || el.textContent || "";
            if (nick) {
                nick = cleanOneLine(nick);
                // 检查是否是省份名（通常很短，且可能是常见省份）
                const provinces = ['北京', '上海', '天津', '重庆', '河北', '山西', '辽宁', '吉林', '黑龙江',
                    '江苏', '浙江', '安徽', '福建', '江西', '山东', '河南', '湖北', '湖南',
                    '广东', '海南', '四川', '贵州', '云南', '陕西', '甘肃', '青海', '台湾',
                    '内蒙古', '广西', '西藏', '宁夏', '新疆', '香港', '澳门'];
                if (provinces.includes(nick) || nick.length <= 2) {
                    // 可能是省份名，检查父级或兄弟节点
                    const parent = el.parentElement;
                    if (parent) {
                        const siblingNick = parent.querySelector('a[class*="nick"], span[class*="nick"], div[class*="nick"]');
                        if (siblingNick) {
                            const siblingText = cleanOneLine(siblingNick.getAttribute("title") || siblingNick.innerText || siblingNick.textContent || "");
                            if (siblingText && siblingText.length > 2 && !provinces.includes(siblingText)) {
                                return siblingText;
                            }
                        }
                    }
                    // 继续查找，不返回省份名
                    continue;
                }
                if (nick && nick.length > 0) {
                    return nick;
                }
            }
        }
    }

    return cleanOneLine(nick) || "";
}

// =========================
// 从个人主页提取卖家昵称（顶部大背景图下方的用户ID区域）
// =========================
function extractSellerNicknameFromProfilePage() {
    // 定位顶部大背景图下方的用户ID区域（类名通常包含 user-name 或 nick-text）
    const profileSelectors = [
        '*[class*="user-name"]',
        'div[class*="user-name"]',
        'span[class*="user-name"]',
        'a[class*="user-name"]',
        '*[class*="nick-text"]',
        'div[class*="nick-text"]',
        'span[class*="nick-text"]',
        'a[class*="nick-text"]'
    ];

    for (const selector of profileSelectors) {
        const el = document.querySelector(selector);
        if (el) {
            let nick = el.getAttribute("title") || el.innerText || el.textContent || "";
            if (nick) {
                nick = cleanOneLine(nick);
                if (nick && nick.length > 0 && nick.length < 50) {
                    return nick;
                }
            }
        }
    }

    return "未知卖家";
}

// =========================
// 发送消息到 popup
// =========================
function sendLog(message, level = 'info') {
    chrome.runtime.sendMessage({
        type: 'log',
        text: message,
        level: level
    });
}

function sendData(data) {
    chrome.runtime.sendMessage({
        type: 'data',
        data: data
    });
}

// =========================
// 滚动页面
// =========================
function scrollPage(times = 40, pause = 1500) {
    return new Promise((resolve) => {
        let count = 0;
        let lastH = 0;

        const scroll = () => {
            window.scrollTo(0, document.body.scrollHeight);

            setTimeout(() => {
                const h = document.body.scrollHeight;
                count++;

                if (h === lastH && count > 5) {
                    resolve();
                    return;
                }

                if (count >= times) {
                    resolve();
                    return;
                }

                lastH = h;
                scroll();
            }, pause);
        };

        scroll();
    });
}

// =========================
// 从列表页提取商品卡片（增强版：扩大选择器范围，增加多种商品识别方式，统计位置分布）
// =========================
function extractListItems() {
    const items = [];
    const seen = new Set();

    // 位置分布统计
    const positionStats = {
        top: 0,      // 页面顶部1/3
        middle: 0,   // 页面中间1/3
        bottom: 0    // 页面底部1/3
    };

    // 获取页面总高度
    const pageHeight = document.body.scrollHeight;
    const oneThird = pageHeight / 3;

    // 方法1：使用原Python的选择器：a:has(div[class^="feeds-content--"])
    const anchors = document.querySelectorAll('a');
    let foundByMethod1 = 0;
    let foundByMethod2 = 0;

    anchors.forEach(anchor => {
        // 方法1：检查是否包含 feeds-content-- 的div（主要方法）
        const feedsContent = anchor.querySelector('div[class^="feeds-content--"]');

        // 方法2：扩大选择器范围，尝试其他可能的商品卡片标识
        const hasItemClass = anchor.className && (
            anchor.className.includes('item') ||
            anchor.className.includes('goods') ||
            anchor.className.includes('product') ||
            anchor.className.includes('card') ||
            anchor.className.includes('feed')
        );

        // 方法3：检查href是否为“真实商品详情页”（必须带 id），避免误抓 /item 首页
        const href = ensureAbsoluteUrl(anchor.getAttribute("href") || anchor.href);
        const isItemLink = isGoofishItemDetailUrl(href);

        // 方法4：检查是否包含标题元素
        const hasTitle = anchor.querySelector('div[class*="title"], div[class*="name"], h3, h4, span[class*="title"], div[class^="row1-wrap-title--"]');

        // 至少满足一个条件才认为是商品卡片
        if (!feedsContent && !hasItemClass && !isItemLink && !hasTitle) {
            return;
        }

        // 验证href是否有效
        if (!href || !isItemLink || seen.has(href)) {
            return;
        }

        // 提取标题（使用多种方法）
        let title = extractTitleFromAnchor(anchor);

        // 如果原方法提取不到，尝试其他方法
        if (!title) {
            const titleEl = anchor.querySelector('div[class*="title"], div[class*="name"], h3, h4, span[class*="title"], div[class^="row1-wrap-title--"]');
            if (titleEl) {
                title = cleanOneLine(titleEl.getAttribute("title") || titleEl.innerText || titleEl.textContent || "");
            }
        }

        // 个人主页等场景兜底：尝试 a 的 title/aria-label、图片 alt
        if (!title) {
            title = cleanOneLine(anchor.getAttribute("title") || anchor.getAttribute("aria-label") || "");
        }
        if (!title) {
            const img = anchor.querySelector('img[alt]');
            if (img) {
                title = cleanOneLine(img.getAttribute('alt') || "");
            }
        }

        // 如果还是没有标题，跳过（可能是非商品链接）
        if (!title || title.length < 2) {
            return;
        }

        // 提取卖家昵称
        let nick = extractSellerNicknameFromAnchor(anchor);

        // 如果在列表页找不到昵称，可能是个人主页，尝试从个人主页提取
        if (!nick || nick === "") {
            nick = extractSellerNicknameFromProfilePage();
        }

        seen.add(href);

        // 统计使用哪种方法找到的
        if (feedsContent) {
            foundByMethod1++;
        } else {
            foundByMethod2++;
        }

        // ========== 统计商品位置分布 ==========
        try {
            const rect = anchor.getBoundingClientRect();
            const absoluteTop = rect.top + window.scrollY;

            if (absoluteTop < oneThird) {
                positionStats.top++;
            } else if (absoluteTop < oneThird * 2) {
                positionStats.middle++;
            } else {
                positionStats.bottom++;
            }
        } catch (e) {
            // 忽略位置计算错误
        }

        // ========== 🆕 API 拦截数据整合 ==========
        // 优先使用 API 拦截的精确数据（publishTime, wantNum）
        const itemId = extractItemIdFromUrl(href);
        const apiData = getApiDataByItemId(itemId);

        // 发布时间：优先 API 精确时间戳 > DOM 相对时间
        let publishTimeValue = "";
        if (apiData && apiData.publishTime) {
            // 🎯 使用 API 精确时间戳（毫秒 -> 格式化时间）
            publishTimeValue = formatTimestamp(apiData.publishTime);
            console.log(`[API数据] ID:${itemId} 使用精确发布时间: ${publishTimeValue}`);
        } else {
            // 回退到 DOM 解析的相对时间
            publishTimeValue = extractPublishTimeFromAnchor(anchor) || "";
        }

        // 想要数：优先 API 精确数值 > DOM 解析
        let wantValue = "";
        if (apiData && apiData.wantNum !== undefined && apiData.wantNum !== '0') {
            wantValue = apiData.wantNum;
            console.log(`[API数据] ID:${itemId} 使用精确想要数: ${wantValue}`);
        } else {
            wantValue = extractWantFromAnchor(anchor);
        }

        // 🆕 卖家昵称：优先 API 数据 > DOM 解析
        let sellerNick = "";
        if (apiData && apiData.userNick) {
            sellerNick = apiData.userNick;
            console.log(`[API数据] ID:${itemId} 使用精确卖家昵称: ${sellerNick}`);
        } else {
            sellerNick = nick || "未知卖家";
        }
        // 🆕 价格：优先 API 数据 > DOM 解析
        let priceValue = "";
        if (apiData && apiData.price) {
            priceValue = apiData.price;
        } else {
            // 如果 API 没有价格，尝试从 DOM 提取（列表页通常有价格）
            const priceEl = anchor.querySelector('span[class*="price"], div[class*="price"]');
            if (priceEl) {
                priceValue = cleanOneLine(priceEl.textContent);
            }
        }

        // ========================================

        // 计算采集时间
        const now = new Date();
        const collectYear = now.getFullYear();
        const collectMonth = String(now.getMonth() + 1).padStart(2, '0');
        const collectDay = String(now.getDate()).padStart(2, '0');
        const collectHour = String(now.getHours()).padStart(2, '0');
        const collectMinute = String(now.getMinutes()).padStart(2, '0');
        const collectTimeStr = `${collectYear}/${collectMonth}/${collectDay} ${collectHour}:${collectMinute}`;

        // 🆕 计算发布天数（采集时间 - 发布时间，精确到 0.1 天）
        let publishDays = "";
        if (publishTimeValue) {
            try {
                // 解析发布时间（格式可能是 "2025/12/13 01:18" 或 "2025-12-13 01:18:13"）
                const publishDateStr = publishTimeValue.replace(/-/g, '/');
                const publishDate = new Date(publishDateStr);
                if (!isNaN(publishDate.getTime())) {
                    const diffMs = now.getTime() - publishDate.getTime();
                    const diffDays = diffMs / (1000 * 60 * 60 * 24);
                    publishDays = diffDays.toFixed(1);  // 精确到 0.1 天
                }
            } catch (e) {
                console.warn('[发布天数] 计算失败:', publishTimeValue, e);
            }
        }

        // 🆕 提取商品封面图URL（用于HTML导出）
        // 优先使用API拦截数据中的封面图
        let coverImage = "";
        if (apiData && apiData.coverImage) {
            coverImage = apiData.coverImage.replace(/^\/\//, 'https://');
            console.log(`[API数据] ID:${itemId} 使用API封面图`);
        }
        // 如果API没有提供，从DOM提取
        if (!coverImage) try {
            // 方法1：查找商品卡片内的img标签
            const imgSelectors = [
                'img[class*="img"]',
                'img[class*="cover"]',
                'img[class*="pic"]',
                'img[class*="photo"]',
                'img[class*="thumb"]',
                'img[src*="img.alicdn"]',
                'img[src*="gw.alicdn"]',
                'img'
            ];
            for (const sel of imgSelectors) {
                const imgEl = anchor.querySelector(sel);
                if (imgEl) {
                    const imgSrc = imgEl.getAttribute('src') || imgEl.getAttribute('data-src') || imgEl.dataset?.src || '';
                    if (imgSrc && (imgSrc.includes('alicdn') || imgSrc.includes('goofish') || imgSrc.startsWith('http'))) {
                        // 确保使用https并去掉尺寸后缀，获取较大的图
                        coverImage = imgSrc.replace(/^\/\//, 'https://');
                        break;
                    }
                }
            }
        } catch (e) {
            console.warn('[封面图] 提取失败:', e);
        }

        // 🆕 提取商品文案/描述（从列表页卡片中）
        // 🔧 增加垃圾内容过滤，排除促销标签、地域、价格等非文案信息
        let itemDesc = "";

        // 判断文本是否为"垃圾描述"（非真正的商品文案）
        const isJunkDescription = (text) => {
            if (!text) return true;
            const t = text.trim();
            // 1. 太短的文本（不可能是有效文案）
            if (t.length <= 5) return true;
            // 2. "XX人想要" 模式
            if (/^\d[\d.]*万?人想要$/.test(t)) return true;
            if (/人想要/.test(t) && t.length < 15) return true;
            // 3. 降价/促销标签
            if (/累计降价|降价\d|折扣|优惠|包邮|秒杀|清仓|特价/.test(t)) return true;
            if (/^降\d+/.test(t)) return true;
            // 4. 纯地域名（省市区）
            const provinces = '北京|天津|上海|重庆|河北|山西|辽宁|吉林|黑龙江|江苏|浙江|安徽|福建|江西|山东|河南|湖北|湖南|广东|海南|四川|贵州|云南|陕西|甘肃|青海|内蒙古|广西|西藏|宁夏|新疆|台湾|香港|澳门';
            const provinceRegex = new RegExp(`^(${provinces})(省|市|自治区)?$`);
            if (provinceRegex.test(t)) return true;
            // 短地域文本（如 "浙江 杭州"）
            if (new RegExp(`^(${provinces})`).test(t) && t.length <= 8) return true;
            // 5. 纯价格（"￥5"、"¥123"、"5元"、"99.9"）
            if (/^[￥¥]\s*\d/.test(t)) return true;
            if (/^\d+(\.\d+)?\s*元?$/.test(t)) return true;
            // 6. 浏览量/想要数等统计数字
            if (/^\d+(\.\d+)?万?(次浏览|人浏览|浏览|想要|已售|付款|收藏)$/.test(t)) return true;
            // 7. 纯数字
            if (/^\d+(\.\d+)?$/.test(t)) return true;
            // 8. 只有标签类的短文本（如 "包邮"、"新品"、"急售"）
            if (t.length <= 4 && /包邮|新品|急售|自提|二手|全新|在售|已售|预售/.test(t)) return true;
            // 9. 整段都是标签碎片拼接（如 "浙江 ￥5 23人想要"）
            // 如果文本中超过一半是"标签碎片"，视为垃圾
            const cleaned = t
                .replace(/\d[\d.]*万?人想要/g, '')
                .replace(/累计降价\d+%?/g, '')
                .replace(/[￥¥]\s*\d[\d.]*/g, '')
                .replace(new RegExp(`(${provinces})(省|市)?`, 'g'), '')
                .replace(/\d+(\.\d+)?\s*元/g, '')
                .replace(/包邮|新品|急售|自提|降价/g, '')
                .replace(/\s+/g, '')
                .trim();
            if (cleaned.length < t.trim().replace(/\s+/g, '').length * 0.4) return true;

            return false;
        };

        try {
            // 只用精准的"描述"类选择器，避免匹配到促销/统计标签
            const descSelectors = [
                'div[class*="desc"]',
                'span[class*="desc"]',
                'p[class*="desc"]'
            ];
            for (const sel of descSelectors) {
                const descEl = anchor.querySelector(sel);
                if (descEl) {
                    const text = cleanOneLine(descEl.innerText || descEl.textContent || "");
                    // 排除标题本身 + 垃圾内容
                    if (text && text !== title && !isJunkDescription(text)) {
                        itemDesc = text;
                        break;
                    }
                }
            }
        } catch (e) {
            // 忽略
        }

        items.push({
            "卖家昵称": sellerNick,
            "标题": title,
            "价格": priceValue,      // 🆕 修复：填入价格
            "想要": wantValue,
            "_listPageWant": wantValue,
            "浏览量": "",    // 详情补
            "询单率": "",
            "发布时间": publishTimeValue,
            "采集时间": collectTimeStr,
            "发布天数": publishDays,  // 🆕 新增
            "商品链接": href,
            "封面图": coverImage,    // 🆕 新增：商品封面图URL
            "商品描述": itemDesc     // 🆕 新增：商品文案描述
        });
    });

    // 添加商品数量统计日志
    console.log(`[商品提取] 找到商品总数: ${items.length} (方法1: ${foundByMethod1}, 方法2: ${foundByMethod2})`);
    console.log(`[商品提取] 位置分布: 顶部=${positionStats.top}, 中部=${positionStats.middle}, 底部=${positionStats.bottom}`);

    // ========== 完整性检查：检测是否有遗漏 ==========
    const totalFromPosition = positionStats.top + positionStats.middle + positionStats.bottom;
    if (totalFromPosition > 0) {
        // 检查是否有明显的位置缺失（例如中部或底部商品为0）
        if (items.length > 10) {
            if (positionStats.middle === 0 && positionStats.bottom > 0) {
                console.warn('[商品提取] ⚠️ 警告：中部区域商品为0，可能存在遗漏！');
            }
            if (positionStats.bottom === 0 && positionStats.middle > 0) {
                console.warn('[商品提取] ⚠️ 警告：底部区域商品为0，可能存在遗漏！');
            }

            // 检查分布是否严重不均匀（某个区域占比过高）
            const topRatio = positionStats.top / totalFromPosition;
            const middleRatio = positionStats.middle / totalFromPosition;
            const bottomRatio = positionStats.bottom / totalFromPosition;

            if (topRatio > 0.8 && items.length > 20) {
                console.warn(`[商品提取] ⚠️ 警告：${Math.round(topRatio * 100)}%的商品集中在顶部，底部可能有遗漏！`);
            }
        }
    }

    return items;
}

// =========================
// 主采集函数
// =========================
async function startCollection(config) {
    if (isCollecting) return;

    isCollecting = true;
    collectedItems = [];

    // 识别详情页模式：仅当为“真实商品详情页”（必须带 id）时才激活，避免误把 /item 当详情页
    if (isDetailPage()) {
        sendLog('[详情页精准采集] 🎯 检测到商品详情页，激活详情页精准采集模式...', 'info');
        sendLog('[详情页精准采集] 正在提取：标题、价格、想要数、浏览量、询单率、卖家昵称', 'info');
        sendLog('[详情页精准采集] 使用精准选择器：item-user-info-nick', 'info');

        try {
            // =========================
            // 新功能：每次采集之前先自动滚动到页面最下面
            // =========================
            sendLog('[初始化] 📜 正在滚动到页面底部...', 'info');

            // 先快速滚动到底部，确保页面加载完整
            let lastHeight = 0;
            let scrollAttempts = 0;
            const maxScrollAttempts = 30; // 详情页最多尝试30次

            while (scrollAttempts < maxScrollAttempts) {
                // 滚动到底部
                window.scrollTo({ top: document.body.scrollHeight, behavior: 'auto' });

                // 等待一小段时间让内容加载
                await new Promise(resolve => setTimeout(resolve, 200));

                // 检查页面高度是否还在变化
                const currentHeight = document.body.scrollHeight;
                if (currentHeight === lastHeight) {
                    // 页面高度不再变化，说明已经滚动到底部
                    break;
                }
                lastHeight = currentHeight;
                scrollAttempts++;
            }

            sendLog(`[初始化] ✅ 已滚动到底部（尝试 ${scrollAttempts} 次）`, 'success');

            // 等待页面关键元素加载完成
            await new Promise(resolve => setTimeout(resolve, 500));

            // 从详情页精准提取完整数据（使用 document.querySelector('div[class*="item-user-info-nick"]')）
            const itemData = extractFullDataFromDetailPage();

            if (!itemData.标题 || itemData.标题 === "") {
                sendLog('❌ 无法提取商品标题，请确保在商品详情页', 'error');
                chrome.runtime.sendMessage({
                    type: 'error',
                    text: '无法提取商品数据'
                });
                isCollecting = false;
                return;
            }

            sendLog(`[详情页精准采集] ✅ 采集成功！`, 'success');
            sendLog(`[详情页精准采集] 标题：${itemData.标题.substring(0, 40)}...`, 'info');
            sendLog(`[详情页精准采集] 卖家昵称：${itemData.卖家昵称}`, 'info');
            sendLog(`[详情页精准采集] 价格：${itemData.价格 || '未获取'} | 想要：${itemData.想要 || '0'} | 浏览：${itemData.浏览量 || '未获取'} | 询单率：${itemData.询单率 || '0%'}`, 'info');

            // 直接发送数据
            sendData(itemData);

            // 发送完成消息
            chrome.runtime.sendMessage({
                type: 'complete',
                count: 1
            });

            sendLog('[详情页精准采集] ✅ 采集完成！', 'success');
        } catch (error) {
            sendLog(`❌ 详情页精准采集失败: ${error.message}`, 'error');
            chrome.runtime.sendMessage({
                type: 'error',
                text: error.message
            });
        }

        isCollecting = false;
        return;
    }

    // 列表页采集逻辑（保留原有功能）
    const scrolls = config.scrolls || 1;
    const pause = config.pause || 300;
    const maxItems = config.maxItems || 600;
    const pageCount = Math.max(1, parseInt(config.pageCount || 1));
    const detailDelay = config.detailDelay || 50;
    const useDetailPage = config.useDetailPage !== false; // 默认使用详情页

    // =========================
    // 分页采集（仅搜索页启用）：先采集第1页，采完再翻到第2页... 以此类推
    // 采集期间不打开详情页，等所有页列表汇总后再统一触发详情页采集（避免翻页过程中干扰）
    // =========================
    const pagesToCollect = isSearchPage() ? pageCount : 1;
    if (isSearchPage()) {
        sendLog(`[分页] 检测到搜索页，将按页采集：${pagesToCollect} 页（每页采完再翻页）`, 'info');
    }

    const allItems = [];
    const globalSeen = new Set();

    const collectCurrentPageItems = async (pageIndex, totalPages) => {
        // =========================
        // 边滚边累计（兼容虚拟列表/DOM回收）：每一步都 merge 当前可见商品到 Set
        // =========================
        const useInternalScroller = isPersonalPage();
        const scroller = useInternalScroller ? findMainScrollableContainer() : null;
        if (useInternalScroller) {
            sendLog(`[初始化] 第${pageIndex}/${totalPages}页：检测到个人主页，启用“边滚边累计 + 内部滚动容器”模式`, 'info');
            if (!scroller) {
                sendLog(`[初始化] 第${pageIndex}/${totalPages}页：未找到内部滚动容器，将使用整页滚动（document.scrollingElement）继续采集`, 'info');
            }
        } else {
            sendLog(`[初始化] 📜 第${pageIndex}/${totalPages}页：正在滚动加载商品...`, 'info');
        }

        // 滚动目标：优先内部容器；否则用 document.scrollingElement（整页滚动，personal 页更稳定）
        const pageScroller = document.scrollingElement || document.documentElement || document.body;
        const scrollTarget = scroller || pageScroller;

        const expectedCount = getExpectedItemCountFromPage();
        if (useInternalScroller && expectedCount > 0) {
            sendLog(`[初始化] 第${pageIndex}/${totalPages}页：页面显示商品数量≈${expectedCount}（用于判断是否采全）`, 'info');
        }

        const localSeen = new Set();
        const collected = [];
        const mergeNow = () => {
            const batch = extractListItems();
            let added = 0;
            for (const it of batch) {
                const url = it && it.商品链接 ? String(it.商品链接) : "";
                if (!url) continue;
                if (localSeen.has(url)) continue;
                localSeen.add(url);
                collected.push(it);
                added++;
            }
            return { batchCount: batch.length, added };
        };

        // 初次 merge
        const first = mergeNow();
        sendLog(`[采集] 第${pageIndex}/${totalPages}页：首屏可见 ${first.batchCount}，累计新增 ${first.added}，累计 ${collected.length}`, 'info');

        // 个人主页更保守：步长更小、稳定阈值更高、等待更久（虚拟列表/渲染延迟）
        // 优化：减少等待时间，更快检测是否需要继续
        const stepFactor = useInternalScroller ? 0.6 : 0.8;
        const requiredStable = useInternalScroller ? 4 : 3; // 降低稳定阈值，更快结束
        let stable = 0;
        const maxSteps = useInternalScroller ? 200 : 150; // 减少最大步数

        const scrollStep = async () => {
            const next = (scrollTarget.scrollTop || 0) + (scrollTarget.clientHeight || window.innerHeight) * stepFactor;
            scrollTarget.scrollTo({ top: next, behavior: 'auto' });
            await sleep(useInternalScroller ? 500 : 400); // 减少等待时间
        };

        const isAtBottom = () => {
            const top = scrollTarget.scrollTop || 0;
            const ch = scrollTarget.clientHeight || window.innerHeight;
            const sh = scrollTarget.scrollHeight || document.body.scrollHeight;
            return top + ch >= sh - 20;
        };

        for (let step = 0; step < maxSteps; step++) {
            // ========== 智能提前退出检查 ==========
            // 如果已采集到足够数量，立即停止滚动
            if (collected.length >= maxItems) {
                sendLog(`[采集] ✅ 已采集到 ${collected.length} 条（达到最大采集数 ${maxItems}），停止滚动`, 'success');
                break;
            }

            // 如果页面商品总数已知且已采集完，立即停止
            if (expectedCount > 0 && collected.length >= expectedCount) {
                sendLog(`[采集] ✅ 已采集到页面全部 ${collected.length} 条商品，停止滚动`, 'success');
                break;
            }
            // ==========================================

            await scrollStep();
            // 每步滚动后merge，减少rounds提高速度
            let addedTotal = 0;
            const rounds = useInternalScroller ? 2 : 1; // 减少轮数
            for (let r = 0; r < rounds; r++) {
                const { added } = mergeNow();
                addedTotal += added;
                if (added > 0 || r === 0) await sleep(useInternalScroller ? 200 : 0); // 只在有新增时等待
            }

            if (addedTotal === 0) stable++;
            else stable = 0;

            if (step % 5 === 0) { // 更频繁的日志
                sendLog(`[滚动] step ${step}/${maxSteps} | 新增 ${addedTotal} | 累计 ${collected.length}/${maxItems}${expectedCount ? ` (页面共${expectedCount})` : ""} | 稳定 ${stable}/${requiredStable}`, 'info');
            }

            // ========== 更智能的结束条件 ==========
            // 已到底部且连续无新增
            if (isAtBottom() && stable >= requiredStable) {
                sendLog(`[采集] 已到底部且稳定，结束滚动`, 'info');
                break;
            }

            // 连续多次无新增，即使没到底部也强制结束
            if (stable >= requiredStable * 3) {
                sendLog(`[采集] 连续${stable}次无新增，强制结束滚动`, 'info');
                break;
            }
            // ==========================================
        }

        // 到底部后额外等待（减少等待时间，如果已采集足够则跳过）
        if (useInternalScroller && collected.length < maxItems) {
            let settleStable = 0;
            for (let i = 0; i < 5; i++) { // 减少到~5秒
                await sleep(500); // 减少等待时间
                const { added } = mergeNow();
                if (added === 0) settleStable++;
                else settleStable = 0;
                // 如果已采集足够或连续2次无新增，提前结束
                if (collected.length >= maxItems) break;
                if (settleStable >= 2 && (!expectedCount || collected.length >= expectedCount)) break;
            }
        }

        // 顶部/底部再扫一遍（如果已采集足够则跳过）
        if (collected.length < maxItems) {
            scrollTarget.scrollTo({ top: 0, behavior: 'auto' });
            await sleep(useInternalScroller ? 400 : 300);
            mergeNow();

            scrollTarget.scrollTo({ top: scrollTarget.scrollHeight || document.body.scrollHeight, behavior: 'auto' });
            await sleep(useInternalScroller ? 500 : 400);
            mergeNow();
        }

        sendLog(`[采集] 第${pageIndex}/${totalPages}页：累计采集 ${collected.length} 条（去重）`, 'success');
        return collected;
    };

    for (let p = 1; p <= pagesToCollect; p++) {
        sendLog(`[分页] ===== 第${p}/${pagesToCollect}页 =====`, 'info');

        const pageItems = await collectCurrentPageItems(p, pagesToCollect);
        if (!pageItems || pageItems.length === 0) {
            sendLog(`[分页] 第${p}页未找到商品卡片，停止分页采集`, 'error');
            break;
        }

        let added = 0;
        for (const it of pageItems) {
            const url = it && it.商品链接 ? String(it.商品链接) : "";
            if (!url) continue;
            if (globalSeen.has(url)) continue;
            globalSeen.add(url);
            allItems.push(it);
            added++;
            if (allItems.length >= maxItems) break;
        }
        sendLog(`[分页] 第${p}页：提取 ${pageItems.length} 条，新增 ${added} 条，累计 ${allItems.length} 条`, 'success');

        if (allItems.length >= maxItems) {
            sendLog(`[分页] 已达到最多采集条数 ${maxItems}，停止继续翻页`, 'info');
            break;
        }

        if (p < pagesToCollect) {
            if (!isSearchPage()) break;
            sendLog(`[分页] 准备打开第${p + 1}页...`, 'info');
            const ok = await goToSearchPage(p + 1);
            if (!ok) {
                sendLog(`[分页] 未能跳转到第${p + 1}页（可能页码不存在/被折叠为...），提前结束`, 'error');
                break;
            }
            // 等待页面稳定
            await sleep(800);
        }
    }

    const items = allItems;
    sendLog(`[列表页] ✅ 分页采集完成，共汇总 ${items.length} 条（去重后）`, 'success');

    // =========================
    // 采集完整性验证：验证提取的商品数量
    // =========================
    if (items.length === 0) {
        sendLog('❌ 未找到商品卡片，请确保在闲鱼卖家主页或搜索页面', 'error');
        chrome.runtime.sendMessage({
            type: 'error',
            text: '未找到商品卡片'
        });
        isCollecting = false;
        return;
    }

    // 验证：如果提取的商品数量明显少于预期，输出警告
    if (items.length < maxItems && items.length < 10) {
        sendLog(`⚠️ 警告：提取的商品数量（${items.length}）较少，可能未完全加载`, 'error');
        sendLog(`💡 建议：尝试手动滚动页面或增加滚动等待时间`, 'info');
    }

    const limit = Math.min(items.length, maxItems);
    sendLog(`[列表页] ✅ 列表页采集完成，共 ${limit} 条（去重后）`, 'success');

    // 如果限制数量小于提取数量，输出提示
    if (limit < items.length) {
        sendLog(`[列表页] ℹ️ 已限制采集数量为 ${limit} 条（实际找到 ${items.length} 条）`, 'info');
    }

    // 详情补：价格/想要/浏览 + 询单率
    // 通过 background script 打开新标签页采集
    sendLog('[步骤3/3] 📦 开始采集详情页数据...', 'info');
    if (useDetailPage) {
        sendLog(`[详情页] 模式：深度采集（将打开新标签页）`, 'info');
        sendLog(`[详情页] 提示：请勿手动关闭自动打开的标签页`, 'info');
    } else {
        sendLog(`[详情页] 模式：快速采集（仅列表页数据）`, 'info');
    }

    // 🆕 个人主页始终进入详情页采集（因为列表页数据不完整）
    const onPersonalPage = isPersonalPage();
    let effectiveFastMode = config.fastMode === true;
    if (onPersonalPage && effectiveFastMode) {
        sendLog(`[个人主页] ⚠️ 检测到个人主页，自动切换为深度采集模式`, 'info');
        effectiveFastMode = false;
    }

    // 发送列表数据到 background，由 background 处理详情页采集
    chrome.runtime.sendMessage({
        type: 'startDetailCollection',
        items: items.slice(0, limit),
        config: {
            detailDelay,
            useDetailPage,
            concurrentLimit: config.concurrentLimit || 10,
            fastMode: effectiveFastMode  // 🆕 个人主页强制关闭快速采集
        }
    });

    // 注意：详情页采集由 background.js 处理
    // 这里只负责列表页采集
    isCollecting = false;
}

// =========================
// 监听来自 popup 的消息
// =========================
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    console.log('[Content Script] 收到消息:', message.action);

    // ping 消息：用于检测 content script 是否已加载
    if (message.action === 'ping') {
        sendResponse({ success: true, ready: true });
        return true;
    }

    if (message.action === 'startCollect') {
        console.log('[Content Script] 开始采集任务...');
        startCollection(message.config || {}).then(() => {
            console.log('[Content Script] 采集任务完成');
            sendResponse({ success: true });
        }).catch((error) => {
            console.error('[Content Script] 采集任务失败:', error);
            sendLog(`❌ 错误: ${error.message}`, 'error');
            sendResponse({ success: false, error: error.message });
            isCollecting = false;
        });
        return true; // 保持消息通道开放
    }

    // 处理详情页数据提取请求（从 background 发来）
    if (message.action === 'extractDetail') {
        const metrics = extractDetailMetrics();
        sendResponse({ success: true, metrics });
        return true;
    }
});
