const fs = require('fs');
const path = require('path');
const plist = require('plist');
const AdmZip = require('adm-zip');
const crypto = require('crypto');

const IPA_DIR = path.join(__dirname, 'ipa');
const PUBLIC_DIR = __dirname;
const PLIST_DIR = path.join(PUBLIC_DIR, 'plist');
const ICON_DIR = path.join(PUBLIC_DIR, 'icons');
const APPS_JSON = path.join(PUBLIC_DIR, 'apps.json');
const PROCESSED_JSON = path.join(PUBLIC_DIR, 'processed.json');   // 缓存文件

// 自动创建必要目录
[IPA_DIR, PLIST_DIR, ICON_DIR].forEach(dir => {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// 如果 ipa 文件夹为空，放入 .gitkeep
const ipaContents = fs.readdirSync(IPA_DIR).filter(f => f !== '.gitkeep');
if (ipaContents.length === 0) {
    const gitkeepPath = path.join(IPA_DIR, '.gitkeep');
    if (!fs.existsSync(gitkeepPath)) {
        fs.writeFileSync(gitkeepPath, '');
    }
}

// 读取已处理记录
let processed = {};
if (fs.existsSync(PROCESSED_JSON)) {
    try {
        processed = JSON.parse(fs.readFileSync(PROCESSED_JSON, 'utf8'));
    } catch (e) {
        processed = {};
    }
}

async function processIPA(ipaPath) {
    const zip = new AdmZip(ipaPath);
    const fileName = path.basename(ipaPath, '.ipa');
    const ipaName = fileName.replace(/[^a-zA-Z0-9_]/g, '_');

    // 解析 Info.plist
    const plistEntries = zip.getEntries().filter(e => e.entryName.endsWith('.app/Info.plist'));
    if (plistEntries.length === 0) throw new Error('未找到 Info.plist');
    const plistData = plist.parse(plistEntries[0].getData().toString('utf8'));

    const bundleId = plistData.CFBundleIdentifier;
    const version = plistData.CFBundleShortVersionString || '1.0';
    const displayName = plistData.CFBundleDisplayName || plistData.CFBundleName || fileName;

    // 提取图标
    let iconName = 'AppIcon60x60@2x.png';
    const icons = plistData.CFBundleIcons?.CFBundlePrimaryIcon?.CFBundleIconFiles ||
                  plistData.CFBundleIconFiles || [];
    if (icons.length > 0) iconName = icons[icons.length - 1] + '.png';

    let iconEntry = zip.getEntry(`Payload/*.app/${iconName}`);
    if (!iconEntry) {
        iconEntry = zip.getEntries().find(e => e.entryName.includes('.app/') && e.entryName.endsWith('.png'));
    }

    let iconUrl = '';
    if (iconEntry) {
        const iconFileName = `${ipaName}_icon.png`;
        const iconOutPath = path.join(ICON_DIR, iconFileName);
        fs.writeFileSync(iconOutPath, iconEntry.getData());
        iconUrl = `icons/${iconFileName}`;
    }

    // 生成 plist 文件
    const plistFileName = `${ipaName}.plist`;
    const plistPath = path.join(PLIST_DIR, plistFileName);
    // ---------- 修改为你的实际 GitHub Pages 地址 ----------
    const baseURL = 'https://你的用户名.github.io/仓库名';
    // ----------------------------------------------------
    const ipaURL = `${baseURL}/ipa/${path.basename(ipaPath)}`;
    const plistContent = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>items</key>
    <array>
        <dict>
            <key>assets</key>
            <array>
                <dict>
                    <key>kind</key>
                    <string>software-package</string>
                    <key>url</key>
                    <string>${ipaURL}</string>
                </dict>
            </array>
            <key>metadata</key>
            <dict>
                <key>bundle-identifier</key>
                <string>${bundleId}</string>
                <key>bundle-version</key>
                <string>${version}</string>
                <key>kind</key>
                <string>software</string>
                <key>title</key>
                <string>${displayName}</string>
            </dict>
        </dict>
    </array>
</dict>
</plist>`;
    fs.writeFileSync(plistPath, plistContent, 'utf8');

    return {
        id: crypto.createHash('md5').update(bundleId).digest('hex').slice(0, 8),
        name: displayName,
        bundleId,
        version,
        icon: iconUrl,
        ipaUrl: `ipa/${path.basename(ipaPath)}`,
        plistUrl: `plist/${plistFileName}`,
        apkUrl: '',
        size: (fs.statSync(ipaPath).size / (1024 * 1024)).toFixed(1) + ' MB',
        category: '应用',
        description: '由 InstallIPA 自动生成',
        minIosVersion: plistData.MinimumOSVersion || '12.0',
        screenshots: []
    };
}

async function main() {
    // 获取当前 IPA 文件列表（仅 .ipa）
    const allFiles = fs.readdirSync(IPA_DIR).filter(f => f.toLowerCase().endsWith('.ipa'));
    const currentFilesMap = new Map();
    allFiles.forEach(file => {
        const fullPath = path.join(IPA_DIR, file);
        const mtime = fs.statSync(fullPath).mtimeMs;
        currentFilesMap.set(file, mtime);
    });

    // 找出新增或修改过的 IPA
    const toProcess = [];
    for (const [file, mtime] of currentFilesMap) {
        if (!processed[file] || processed[file] !== mtime) {
            toProcess.push(file);
        }
    }

    // 处理新增/修改的 IPA
    const appsFromProcessed = [];  // 保存本次处理生成的 app 数据
    for (const file of toProcess) {
        try {
            console.log(`处理中: ${file}`);
            const app = await processIPA(path.join(IPA_DIR, file));
            appsFromProcessed.push({ file, app });
            // 更新缓存记录
            processed[file] = currentFilesMap.get(file);
        } catch (err) {
            console.error(`处理 ${file} 失败:`, err.message);
            // 如果失败，保留旧记录（不更新）
        }
    }

    // 清理缓存中已不存在的 IPA
    for (const file of Object.keys(processed)) {
        if (!currentFilesMap.has(file)) {
            delete processed[file];
        }
    }

    // 保存更新后的缓存
    fs.writeFileSync(PROCESSED_JSON, JSON.stringify(processed, null, 2));

    // 读取现有的 apps.json（如果存在）
    let apps = [];
    if (fs.existsSync(APPS_JSON)) {
        try {
            apps = JSON.parse(fs.readFileSync(APPS_JSON, 'utf8'));
        } catch (e) {
            apps = [];
        }
    }

    // 用 bundleId 作为唯一键，更新或新增应用数据
    const appsMap = new Map(apps.map(a => [a.bundleId, a]));
    for (const { app } of appsFromProcessed) {
        appsMap.set(app.bundleId, app);   // 新应用覆盖旧数据
    }

    // 移除当前 IPA 中不存在的应用
    const newApps = [];
    for (const [file, mtime] of currentFilesMap) {
        // 找到对应 bundleId（通过已处理数据匹配）
        const existingApp = apps.find(a => a.ipaUrl === `ipa/${file}`);
        if (existingApp) {
            newApps.push(existingApp);
        } else {
            // 如果不在 apps 列表中但文件存在，说明可能刚刚处理完，从 appsMap 中取
            const maybeApp = Array.from(appsMap.values()).find(a => a.ipaUrl === `ipa/${file}`);
            if (maybeApp) newApps.push(maybeApp);
        }
    }

    // 最终写入 apps.json
    fs.writeFileSync(APPS_JSON, JSON.stringify(newApps, null, 2));
    console.log(`成功更新 apps.json，共 ${newApps.length} 个应用`);
}

main();