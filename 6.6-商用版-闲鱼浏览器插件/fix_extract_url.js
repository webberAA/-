// 修复后的 extractUrlFromCell 函数
// 请将此函数替换到 popup.js 的第492-511行

// 从HYPERLINK公式或纯URL中提取真实URL
function extractUrlFromCell(cellValue) {
    if (!cellValue) return null;
    const val = String(cellValue).trim();

    console.log('[对比] 解析单元格:', val.substring(0, 60));

    // 方法1: 直接从字符串中提取goofish.com的URL（最可靠）
    // 匹配格式: https://www.goofish.com/item?id=...
    const gfMatch = val.match(/https?:\/\/[^\s\"',\)]+goofish\.com[^\s\"',\)]*/i);
    if (gfMatch) {
        console.log('[对比] 提取到URL:', gfMatch[0]);
        return gfMatch[0].trim();
    }

    // 方法2: 纯URL（以http开头）
    if (val.startsWith('http://') || val.startsWith('https://')) {
        return val;
    }

    console.log('[对比] 未能提取URL');
    return null;
}

/*
手动修复步骤：
1. 打开 popup.js
2. 找到第492行的 extractUrlFromCell 函数
3. 将整个函数（第492-511行）替换为上面的新版本
4. 保存文件
5. 重新加载插件
*/
