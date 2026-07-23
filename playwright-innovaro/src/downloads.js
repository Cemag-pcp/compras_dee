const fs = require("fs/promises");
const path = require("path");

const DOWNLOAD_DIR = path.join(process.cwd(), "output", "downloads");

async function saveDownload(download, fileName) {
  await fs.mkdir(DOWNLOAD_DIR, { recursive: true });
  const targetPath = path.join(DOWNLOAD_DIR, fileName || download.suggestedFilename());
  await download.saveAs(targetPath);
  return targetPath;
}

module.exports = { DOWNLOAD_DIR, saveDownload };
