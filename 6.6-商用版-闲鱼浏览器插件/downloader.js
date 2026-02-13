async function getLocal(keys) {
  return new Promise((resolve) => {
    try {
      chrome.storage.local.get(keys, (res) => resolve(res || {}));
    } catch (e) {
      resolve({});
    }
  });
}

async function removeLocal(keys) {
  return new Promise((resolve) => {
    try {
      chrome.storage.local.remove(keys, () => resolve());
    } catch (e) {
      resolve();
    }
  });
}

async function sendLog(text, level = "info") {
  try {
    chrome.runtime.sendMessage({ type: "log", text, level });
  } catch (e) {}
}

(async () => {
  const { pendingDownload } = await getLocal(["pendingDownload"]);
  if (!pendingDownload || !pendingDownload.dataUrl || !pendingDownload.filename) {
    await sendLog("[导出] downloader 未找到待下载任务（pendingDownload为空）", "error");
    return;
  }

  const fullPath = String(pendingDownload.filename).trim();
  const dataUrl = pendingDownload.dataUrl;

  // Edge/Chrome 对 data URL 下载会忽略 filename 参数，只能用 <a download> 触发
  // <a download> 不支持子目录，所以只取文件名部分
  const pureFilename = fullPath.includes("/") ? fullPath.split("/").pop() : fullPath;

  await sendLog(`[导出] 开始下载: ${pureFilename}`, "info");

  const a = document.createElement("a");
  a.href = dataUrl;
  a.download = pureFilename;
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);

  await sendLog(`[导出] ✅ 已触发下载: ${pureFilename}`, "success");

  // 清理
  await removeLocal(["pendingDownload"]);

  // 关闭页面
  setTimeout(() => {
    try { window.close(); } catch (e) {}
  }, 1200);
})();


