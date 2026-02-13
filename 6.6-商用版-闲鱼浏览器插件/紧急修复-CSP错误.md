# ⚠️ 紧急修复：CSP 错误解决方案

## 🔴 问题确认

从您的截图中看到关键错误：
```
EvalError: Evaluating a string as JavaScript violates the following Content Security Policy directive because 'unsafe-eval' is not an allowed source of script: script-src 'self'
```

**根本原因：**
- Chrome Extension Manifest V3 **禁止使用** `new Function()` 和 `eval()`
- 当前代码使用了 `new Function()` 来动态加载 ExcelJS
- 违反了内容安全策略（CSP），导致加载失败
- 最终回退到 CSV 格式

## ✅ 快速解决方案（5分钟）

### 步骤 1：下载 ExcelJS 库文件

点击以下任一链接下载（选一个即可）：

1. **jsDelivr（推荐，国内速度快）**
   https://cdn.jsdelivr.net/npm/exceljs@4.4.0/dist/exceljs.min.js

2. **Cloudflare**
   https://cdnjs.cloudflare.com/ajax/libs/exceljs/4.4.0/exceljs.min.js

3. **unpkg**
   https://unpkg.com/exceljs@4.4.0/dist/exceljs.min.js

**下载方式：**
- 右键链接 → "另存为..."
- 或直接访问链接，然后 Ctrl+S 保存页面
- 文件名：`exceljs.min.js`
- 文件大小：约 950KB

### 步骤 2：放到插件目录

将下载的 `exceljs.min.js` 文件放到插件目录：
```
d:\桌面\稳定版-闲鱼浏览器插件\
└── exceljs.min.js  ← 放在这里（和 background.js 同级）
```

### 步骤 3：修改 manifest.json

用以下内容完全替换 `manifest.json`：

```json
{
  "manifest_version": 3,
  "name": "闲鱼数据采集助手 V5.3.50",
  "version": "5.3.50",
  "description": "超级雷达版 - 自动采集闲鱼商品数据 | 智能条件格式Excel导出",
  "permissions": [
    "activeTab",
    "downloads",
    "storage",
    "tabs",
    "scripting"
  ],
  "host_permissions": [
    "https://*.taobao.com/*",
    "https://*.tmall.com/*",
    "https://*.goofish.com/*"
  ],
  "action": {
    "default_popup": "popup.html"
  },
  "content_scripts": [
    {
      "matches": [
        "https://*.goofish.com/*",
        "https://*.taobao.com/*"
      ],
      "js": [
        "content.js"
      ],
      "run_at": "document_idle"
    }
  ],
  "background": {
    "service_worker": "background.js"
  },
  "web_accessible_resources": [
    {
      "resources": ["exceljs.min.js"],
      "matches": ["<all_urls>"]
    }
  ]
}
```

**重点：** 新增了最后的 `web_accessible_resources` 部分！

### 步骤 4：等我修改 background.js

我需要修改 `background.js` 中的 `loadExcelJS` 函数，使用 `importScripts` 代替 `new Function()`。

**请稍等，我会在下一步提供修改后的代码...**

---

## 🎯 完成后的效果

✅ Excel 文件（.xlsx）成功导出  
✅ 所有条件格式正常显示  
✅ 不再依赖 CDN，完全本地化  
✅ 加载速度更快  
✅ 符合 Chrome Extension 安全策略  

---

**重要提示：** 
1. 必须先下载 `exceljs.min.js` 文件
2. 必须修改 `manifest.json`
3. 然后我会提供修改后的 `loadExcelJS` 函数

准备好了吗？ 请先完成步骤1-3！
