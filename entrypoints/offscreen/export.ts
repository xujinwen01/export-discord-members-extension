import JSZip from "jszip";
import type { Browser } from "wxt/browser";

// ---- 导出列定义（与 background 的 toExportRow 字段一一对应，标题纯中文）----
interface ColumnDef {
  key: string;
  title: string;
}

const BASIC_COLUMNS: ColumnDef[] = [
  { key: "avatarUrl", title: "头像链接" },
  { key: "id", title: "用户 ID" },
  { key: "username", title: "用户名" },
  { key: "nickname", title: "昵称" },
  { key: "accountCreated", title: "账号创建时间" },
  { key: "joinedAt", title: "加入服务器时间" },
  { key: "roles", title: "角色 ID" },
  { key: "status", title: "状态" },
  { key: "activity", title: "活动" },
  { key: "discriminator", title: "标识码" },
];

const DETAILED_COLUMNS: ColumnDef[] = [
  { key: "globalName", title: "全局名称" },
  { key: "nitroTier", title: "Nitro 时长" },
  { key: "nitroType", title: "Nitro 类型" },
  { key: "nitroSince", title: "Nitro 起始时间" },
  { key: "bio", title: "简介" },
  { key: "pronouns", title: "代词" },
  { key: "serverBio", title: "服务器简介" },
  { key: "serverPronouns", title: "服务器代词" },
  { key: "serverBoostSince", title: "服务器加成起始时间" },
  { key: "accentColor", title: "主题色" },
  { key: "publicFlags", title: "公开标志" },
  { key: "primaryGuildTag", title: "主服务器标签" },
  { key: "clanTag", title: "社区标签" },
  { key: "avatarDecoration", title: "头像装饰" },
  { key: "connectedAccounts", title: "关联账户" },
  { key: "badges", title: "徽章" },
  { key: "mutualGuildsCount", title: "共同服务器" },
  { key: "mutualFriendsCount", title: "共同好友" },
  { key: "communicationDisabledUntil", title: "禁言截止时间" },
  { key: "pendingVerification", title: "待验证" },
  { key: "legacyUsername", title: "旧用户名" },
];

export interface ExportSettings {
  format: string;
  downloadFolder: string;
  downloadAvatars: boolean;
  filenameTemplate: string;
  enabledBasicColumns: string[];
  enabledDetailedColumns: string[];
  fetchDetailedInfo: boolean;
}

interface ExportAvatar {
  id: string;
  username: string;
  url: string;
}

interface ExportContext {
  serverName: string;
  guildId: string;
  channelName: string;
  channelId: string;
}

export interface ExportResult {
  taskId: string;
  rows: Record<string, unknown>[];
  avatars: ExportAvatar[];
  context: ExportContext;
  limitReached: boolean;
}

export interface ExportOutput {
  filename: string;
  count: number;
  avatarFailures: number;
  avatarArchives: number;
}

// ---- 工具函数 ----
function escapeXml(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

/** 0 基列序号 → Excel 列字母（A、B、…、Z、AA） */
function colName(index: number): string {
  let name = "";
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) {
    name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  }
  return name;
}

function sanitizeName(value: string): string {
  return value.replace(/[<>:"/\\|?*]/g, "_").trim();
}

function renderFilenameTemplate(
  template: string,
  ctx: { serverName: string; serverId: string; channelName: string; channelId: string; memberCount: number },
  now = new Date(),
): string {
  const date = now.toISOString().slice(0, 10);
  const time = now.toTimeString().slice(0, 8).replaceAll(":", "-");
  return template
    .replaceAll("{serverName}", sanitizeName(ctx.serverName))
    .replaceAll("{serverId}", ctx.serverId)
    .replaceAll("{channelName}", sanitizeName(ctx.channelName))
    .replaceAll("{channelId}", ctx.channelId)
    .replaceAll("{date}", date)
    .replaceAll("{time}", time)
    .replaceAll("{datetime}", `${date}_${time}`)
    .replaceAll("{timestamp}", String(now.getTime()))
    .replaceAll("{memberCount}", String(ctx.memberCount));
}

function joinPath(folder: string, filename: string): string {
  const clean = folder
    .split(/[\\/]+/)
    .map((seg) => seg.replace(/[<>:"|?*]/g, "_").trim().replace(/[. ]+$/g, ""))
    .filter((seg) => seg && seg !== "." && seg !== "..")
    .join("/");
  return clean ? `${clean}/${filename}` : filename;
}

// ---- 构造导出数据（表头 + 行）----
function buildRows(result: ExportResult, settings: ExportSettings) {
  const cols = [
    ...BASIC_COLUMNS.filter((c) => settings.enabledBasicColumns.includes(c.key)),
    ...DETAILED_COLUMNS.filter(
      (c) => settings.fetchDetailedInfo && settings.enabledDetailedColumns.includes(c.key),
    ),
  ];
  const headers = cols.map((c) => c.title);
  const rows = result.rows.map((row) => {
    const out: Record<string, unknown> = {};
    cols.forEach((col, i) => {
      const header = headers[i];
      if (header !== undefined) out[header] = row[col.key] ?? "";
    });
    return out;
  });
  return { headers, rows };
}

// ---- 各格式生成 ----
function buildCsv(headers: string[], rows: Record<string, unknown>[]): Blob {
  const cell = (value: unknown): string => {
    let s = String(value ?? "");
    if (/^[\t\r\n]*[=+\-@]/.test(s)) s = `'${s}`;
    return /[,"\n\r]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
  };
  const text =
    "﻿" +
    [headers.join(","), ...rows.map((row) => headers.map((h) => cell(row[h])).join(","))].join("\r\n");
  return new Blob([text], { type: "text/csv;charset=utf-8" });
}

function buildXls(headers: string[], rows: Record<string, unknown>[]): Blob {
  const body = [headers, ...rows.map((row) => headers.map((h) => row[h] ?? ""))]
    .map(
      (line) =>
        `<Row>${line
          .map(
            (v) =>
              `<Cell><Data ss:Type="${typeof v === "number" ? "Number" : "String"}">${escapeXml(v)}</Data></Cell>`,
          )
          .join("")}</Row>`,
    )
    .join("");
  return new Blob(
    [
      `<?xml version="1.0"?><Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet"><Worksheet ss:Name="Members"><Table>${body}</Table></Worksheet></Workbook>`,
    ],
    { type: "application/vnd.ms-excel" },
  );
}

async function buildXlsx(headers: string[], rows: Record<string, unknown>[]): Promise<Blob> {
  const zip = new JSZip();
  const headerRow: Record<string, unknown> = {};
  for (const h of headers) headerRow[h] = h;
  const allRows = [headerRow, ...rows];

  const sheetRows = allRows
    .map((row, rowIndex) => {
      const cells = headers
        .map((header, colIndex) => {
          const value = row[header] ?? "";
          const ref = `${colName(colIndex)}${rowIndex + 1}`;
          if (typeof value === "number" && Number.isFinite(value)) {
            return `<c r="${ref}"><v>${value}</v></c>`;
          }
          if (typeof value === "boolean") {
            return `<c r="${ref}" t="b"><v>${+value}</v></c>`;
          }
          return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(value)}</t></is></c>`;
        })
        .join("");
      return `<row r="${rowIndex + 1}">${cells}</row>`;
    })
    .join("");

  zip.file(
    "[Content_Types].xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`,
  );
  zip.file(
    "_rels/.rels",
    `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
  );
  zip.file(
    "xl/workbook.xml",
    `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><bookViews><workbookView/></bookViews><sheets><sheet name="Members" sheetId="1" r:id="rId1"/></sheets></workbook>`,
  );
  zip.file(
    "xl/_rels/workbook.xml.rels",
    `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
  );
  zip.file(
    "xl/styles.xml",
    `<?xml version="1.0" encoding="UTF-8"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="1"><font><sz val="11"/><name val="Calibri"/><family val="2"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`,
  );
  const dimension = headers.length ? `${colName(headers.length - 1)}${allRows.length}` : "A1";
  zip.file(
    "xl/worksheets/sheet1.xml",
    `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:${dimension}"/><sheetViews><sheetView workbookViewId="0"/></sheetViews><sheetFormatPr defaultRowHeight="15"/><sheetData>${sheetRows}</sheetData></worksheet>`,
  );

  return zip.generateAsync({
    type: "blob",
    compression: "DEFLATE",
    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
}

// ---- 下载 ----
function waitForDownload(id: number): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const finish = (err?: string) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      browser.downloads.onChanged.removeListener(onChanged);
      if (err) reject(new Error(err));
      else resolve();
    };

    const onChanged = (delta: Browser.downloads.DownloadDelta) => {
      if (delta.id !== id) return;
      if (delta.error?.current) finish(`DOWNLOAD_INTERRUPTED:${delta.error.current}`);
      else if (delta.state?.current === "complete") finish();
    };

    timer = setTimeout(() => finish("DOWNLOAD_TIMEOUT"), 9e5);
    browser.downloads.onChanged.addListener(onChanged);
    browser.downloads
      .search({ id })
      .then(([item]) => {
        if (item?.error) finish(`DOWNLOAD_INTERRUPTED:${item.error}`);
        else if (item?.state === "complete") finish();
      })
      .catch(() => void 0);
  });
}

async function downloadBlob(blob: Blob, filename: string): Promise<number> {
  const url = URL.createObjectURL(blob);
  if (!browser.downloads) {
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return 0;
  }
  try {
    const id = await browser.downloads.download({ url, filename, saveAs: false });
    await waitForDownload(id);
    return id;
  } finally {
    URL.revokeObjectURL(url);
  }
}

// ---- 主导出 ----
export async function exportFiles(result: ExportResult, settings: ExportSettings): Promise<ExportOutput> {
  const { headers, rows } = buildRows(result, settings);
  if (!headers.length) throw new Error("请至少选择一个导出字段。");

  const baseName =
    renderFilenameTemplate(settings.filenameTemplate, {
      serverName: result.context.serverName,
      serverId: result.context.guildId,
      channelName: result.context.channelName,
      channelId: result.context.channelId,
      memberCount: result.rows.length,
    }) || `discord-members-${Date.now()}`;

  const format = settings.format;
  const filename = joinPath(settings.downloadFolder, `${baseName}.${format}`);

  let blob: Blob;
  if (format === "csv") blob = buildCsv(headers, rows);
  else if (format === "json")
    blob = new Blob([JSON.stringify(rows, null, 2)], { type: "application/json;charset=utf-8" });
  else if (format === "xls") blob = buildXls(headers, rows);
  else blob = await buildXlsx(headers, rows);

  await downloadBlob(blob, filename);

  let avatarFailures = 0;
  let avatarArchives = 0;
  if (settings.downloadAvatars && result.avatars.length) {
    const batches = Array.from({ length: Math.ceil(result.avatars.length / 500) }, (_, i) =>
      result.avatars.slice(i * 500, (i + 1) * 500),
    );
    for (let i = 0; i < batches.length; i++) {
      const batch = batches[i]!;
      const zip = new JSZip();
      let cursor = 0;
      let saved = 0;
      const workers = Array.from({ length: Math.min(4, batch.length) }, async () => {
        while (cursor < batch.length) {
          const avatar = batch[cursor++]!;
          try {
            const resp = await fetch(avatar.url);
            if (!resp.ok) {
              avatarFailures++;
              continue;
            }
            const data = await resp.arrayBuffer();
            zip.file(`${avatar.id}-${avatar.username.replace(/[^a-zA-Z0-9._-]/g, "_")}.png`, data);
            saved++;
          } catch {
            avatarFailures++;
          }
        }
      });
      await Promise.all(workers);
      if (saved) {
        try {
          const archive = await zip.generateAsync({ type: "blob", compression: "STORE" });
          const suffix = batches.length > 1 ? `-${i + 1}` : "";
          await downloadBlob(archive, joinPath(settings.downloadFolder, `${baseName}-avatars${suffix}.zip`));
          avatarArchives++;
        } catch {
          avatarFailures += saved;
        }
      }
    }
  }

  return { filename, count: result.rows.length, avatarFailures, avatarArchives };
}
