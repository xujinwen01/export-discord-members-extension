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

export interface ExportAvatar {
  id: string;
  username: string;
  url: string;
}

export interface ExportContext {
  serverName: string;
  guildId: string;
  channelName: string;
  channelId: string;
}

/** 导出元信息（不含 rows，rows 由读取器按批流式提供） */
export interface ExportMeta {
  taskId: string;
  avatars: ExportAvatar[];
  context: ExportContext;
  limitReached: boolean;
  rowCount: number;
}

export interface ExportOutput {
  filename: string;
  count: number;
  avatarFailures: number;
  avatarArchives: number;
}

/** 批量行读取器：逐批回调原始行（字段名 = toExportRow 的 key），避免一次把十万行全载入内存 */
export type RowBatchReader = (onBatch: (rows: Record<string, unknown>[]) => Promise<void>) => Promise<void>;

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

// ---- 列解析与行映射 ----
function resolveColumns(settings: ExportSettings): ColumnDef[] {
  return [
    ...BASIC_COLUMNS.filter((c) => settings.enabledBasicColumns.includes(c.key)),
    ...DETAILED_COLUMNS.filter(
      (c) => settings.fetchDetailedInfo && settings.enabledDetailedColumns.includes(c.key),
    ),
  ];
}

/** 原始行（字段名 = toExportRow 的 key）→ 表头键控对象 */
function mapRow(raw: Record<string, unknown>, cols: ColumnDef[], headers: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (let i = 0; i < cols.length; i++) {
    const header = headers[i];
    if (header !== undefined) out[header] = raw[cols[i]!.key] ?? "";
  }
  return out;
}

// ---- CSV（分块拼接，避免一次拼出几十 MB 字符串）----
function csvCell(value: unknown): string {
  let s = String(value ?? "");
  if (/^[\t\r\n]*[=+\-@]/.test(s)) s = `'${s}`;
  return /[,"\n\r]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

async function buildCsvStreaming(
  headers: string[],
  cols: ColumnDef[],
  readRows: RowBatchReader,
): Promise<Blob> {
  const chunks: string[] = ["\uFEFF" + headers.join(",")];
  await readRows(async (rows) => {
    const lines = rows.map((raw) => headers.map((h) => csvCell(mapRow(raw, cols, headers)[h])).join(","));
    if (lines.length) chunks.push(lines.join("\r\n"));
  });
  return new Blob([chunks.join("\r\n")], { type: "text/csv;charset=utf-8" });
}

// ---- JSON（分块拼接，保持与原 JSON.stringify(rows, null, 2) 相同格式）----
async function buildJsonStreaming(
  headers: string[],
  cols: ColumnDef[],
  readRows: RowBatchReader,
): Promise<Blob> {
  const parts: string[] = [];
  await readRows(async (rows) => {
    for (const raw of rows) {
      const mapped = mapRow(raw, cols, headers);
      parts.push(
        JSON.stringify(mapped, null, 2)
          .split("\n")
          .map((line) => "  " + line)
          .join("\n"),
      );
    }
  });
  return new Blob(["[\n" + parts.join(",\n") + "\n]"], { type: "application/json;charset=utf-8" });
}

// ---- XLS（XML 表格，逐行拼块）----
function xlsCell(value: unknown): string {
  return `<Cell><Data ss:Type="${typeof value === "number" ? "Number" : "String"}">${escapeXml(value)}</Data></Cell>`;
}

function xlsRow(values: unknown[]): string {
  return `<Row>${values.map(xlsCell).join("")}</Row>`;
}

async function buildXlsStreaming(
  headers: string[],
  cols: ColumnDef[],
  readRows: RowBatchReader,
): Promise<Blob> {
  const chunks: string[] = [xlsRow(headers)];
  await readRows(async (rows) => {
    for (const raw of rows) {
      const mapped = mapRow(raw, cols, headers);
      chunks.push(xlsRow(headers.map((h) => mapped[h] ?? "")));
    }
  });
  const body = chunks.join("");
  return new Blob(
    [
      `<?xml version="1.0"?><Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet"><Worksheet ss:Name="Members"><Table>${body}</Table></Worksheet></Workbook>`,
    ],
    { type: "application/vnd.ms-excel" },
  );
}

// ---- XLSX（sheet XML 逐行拼块，避免先物化整张表再 map）----
function xlsxRow(row: Record<string, unknown>, headers: string[], r: number): string {
  const cells = headers
    .map((header, colIndex) => {
      const value = row[header] ?? "";
      const ref = `${colName(colIndex)}${r}`;
      if (typeof value === "number" && Number.isFinite(value)) {
        return `<c r="${ref}"><v>${value}</v></c>`;
      }
      if (typeof value === "boolean") {
        return `<c r="${ref}" t="b"><v>${+value}</v></c>`;
      }
      return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(value)}</t></is></c>`;
    })
    .join("");
  return `<row r="${r}">${cells}</row>`;
}

async function buildXlsxStreaming(
  headers: string[],
  cols: ColumnDef[],
  readRows: RowBatchReader,
): Promise<Blob> {
  const zip = new JSZip();
  const headerRow: Record<string, unknown> = {};
  for (const h of headers) headerRow[h] = h;

  const rowChunks: string[] = [xlsxRow(headerRow, headers, 1)];
  let rowNum = 2; // 第 1 行是表头
  await readRows(async (rows) => {
    for (const raw of rows) {
      rowChunks.push(xlsxRow(mapRow(raw, cols, headers), headers, rowNum));
      rowNum++;
    }
  });
  const sheetRows = rowChunks.join("");

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
  const dimension = headers.length ? `${colName(headers.length - 1)}${rowNum - 1}` : "A1";
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
export async function exportFiles(
  meta: ExportMeta,
  settings: ExportSettings,
  readRows: RowBatchReader,
): Promise<ExportOutput> {
  const cols = resolveColumns(settings);
  const headers = cols.map((c) => c.title);
  if (!headers.length) throw new Error("请至少选择一个导出字段。");

  const baseName =
    renderFilenameTemplate(settings.filenameTemplate, {
      serverName: meta.context.serverName,
      serverId: meta.context.guildId,
      channelName: meta.context.channelName,
      channelId: meta.context.channelId,
      memberCount: meta.rowCount,
    }) || `discord-members-${Date.now()}`;

  const format = settings.format;
  const filename = joinPath(settings.downloadFolder, `${baseName}.${format}`);

  let blob: Blob;
  if (format === "csv") blob = await buildCsvStreaming(headers, cols, readRows);
  else if (format === "json") blob = await buildJsonStreaming(headers, cols, readRows);
  else if (format === "xls") blob = await buildXlsStreaming(headers, cols, readRows);
  else blob = await buildXlsxStreaming(headers, cols, readRows);

  await downloadBlob(blob, filename);

  let avatarFailures = 0;
  let avatarArchives = 0;
  if (settings.downloadAvatars && meta.avatars.length) {
    const batches = Array.from({ length: Math.ceil(meta.avatars.length / 500) }, (_, i) =>
      meta.avatars.slice(i * 500, (i + 1) * 500),
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

  return { filename, count: meta.rowCount, avatarFailures, avatarArchives };
}
