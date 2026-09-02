import {
  exportFiles,
  type ExportResult,
  type ExportSettings,
  type ExportOutput,
} from "./export";

const DB_NAME = "discord-member-exporter";
const DB_STORE = "results";
const ROWS_STORE = "result_rows";
const ROW_INDEX_DIGITS = 8;

function rowKey(taskId: string, index: number): string {
  return `${taskId}:${String(index).padStart(ROW_INDEX_DIGITS, "0")}`;
}

interface DownloadMessage {
  type: "DME_OFFSCREEN_DOWNLOAD";
  taskId: string;
  settings: ExportSettings;
}

type DownloadResponse = { ok: true; output: ExportOutput } | { ok: false; error: string };

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    // 版本必须与 background 保持一致（两者共用同一个 IndexedDB 库），
    // 否则 background 升到更高版本后，这里用旧版本打开会报 VersionError。
    const req = indexedDB.open(DB_NAME, 4);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(DB_STORE)) db.createObjectStore(DB_STORE, { keyPath: "taskId" });
      if (!db.objectStoreNames.contains("checkpoints")) db.createObjectStore("checkpoints", { keyPath: "taskId" });
      if (!db.objectStoreNames.contains("member_stream")) db.createObjectStore("member_stream", { keyPath: "key" });
      if (!db.objectStoreNames.contains(ROWS_STORE)) db.createObjectStore(ROWS_STORE, { keyPath: "key" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function getResult(taskId: string): Promise<ExportResult | null> {
  const db = await openDb();
  try {
    const meta = await new Promise<any | undefined>((resolve, reject) => {
      const req = db.transaction(DB_STORE, "readonly").objectStore(DB_STORE).get(taskId);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    if (!meta) return null;

    const rows = await new Promise<Record<string, unknown>[]>((resolve, reject) => {
      const tx = db.transaction(ROWS_STORE, "readonly");
      const range = IDBKeyRange.bound(rowKey(taskId, 0), rowKey(taskId, 10 ** ROW_INDEX_DIGITS - 1));
      const req = tx.objectStore(ROWS_STORE).getAll(range);
      req.onsuccess = () =>
        resolve((req.result as Array<{ row: Record<string, unknown> }>).map((r) => r.row));
      req.onerror = () => reject(req.error);
    });

    return {
      taskId,
      rows,
      avatars: meta.avatars ?? [],
      context: meta.context,
      limitReached: meta.limitReached,
    };
  } finally {
    db.close();
  }
}

async function deleteResult(taskId: string): Promise<void> {
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction([DB_STORE, ROWS_STORE], "readwrite");
      tx.objectStore(DB_STORE).delete(taskId);
      tx.objectStore(ROWS_STORE).delete(IDBKeyRange.bound(rowKey(taskId, 0), rowKey(taskId, 10 ** ROW_INDEX_DIGITS - 1)));
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error("RESULT_STORE_TRANSACTION_ABORTED"));
    });
  } finally {
    db.close();
  }
}

async function handleDownload(message: DownloadMessage): Promise<DownloadResponse> {
  const taskId = String(message.taskId || "");
  try {
    const result = await getResult(taskId);
    if (!result?.rows?.length) throw new Error("NO_MEMBERS_FOUND");
    const output = await exportFiles(result, message.settings);
    return { ok: true, output };
  } finally {
    await deleteResult(taskId).catch(() => void 0);
  }
}

browser.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const msg = message as DownloadMessage | null;
  if (!msg || msg.type !== "DME_OFFSCREEN_DOWNLOAD") return;
  handleDownload(msg)
    .then((response) => sendResponse(response))
    .catch((err) => sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) }));
  return true;
});
