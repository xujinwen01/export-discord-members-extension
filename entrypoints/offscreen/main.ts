import {
  exportFiles,
  type ExportMeta,
  type ExportSettings,
  type ExportOutput,
  type RowBatchReader,
} from "./export";

const DB_NAME = "discord-member-exporter";
const DB_STORE = "results";
const ROWS_STORE = "result_rows";
const ROW_INDEX_DIGITS = 8;
/** 每次从 result_rows 读多少行（分页读，避免 getAll 把十万行一次全载入内存） */
const ROW_READ_BATCH = 5000;

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

function requestToPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** 读取导出元信息（不含 rows） */
async function getResultMeta(taskId: string): Promise<ExportMeta | null> {
  const db = await openDb();
  try {
    const meta = await requestToPromise<any>(
      db.transaction(DB_STORE, "readonly").objectStore(DB_STORE).get(taskId),
    );
    if (!meta) return null;
    return {
      taskId,
      avatars: meta.avatars ?? [],
      context: meta.context,
      limitReached: !!meta.limitReached,
      rowCount: Number(meta.rowCount || 0),
    };
  } finally {
    db.close();
  }
}

/** 分批读取 result_rows：先取全部 key（仅字符串，体积小），再按 key 区间分页 getAll，逐批回调 */
async function readRowsInBatches(
  taskId: string,
  batchSize: number,
  onBatch: (rows: Record<string, unknown>[]) => Promise<void>,
): Promise<void> {
  const db = await openDb();
  try {
    const range = IDBKeyRange.bound(rowKey(taskId, 0), rowKey(taskId, 10 ** ROW_INDEX_DIGITS - 1));
    const keys = await requestToPromise<IDBValidKey[]>(
      db.transaction(ROWS_STORE, "readonly").objectStore(ROWS_STORE).getAllKeys(range),
    );
    for (let i = 0; i < keys.length; i += batchSize) {
      const slice = keys.slice(i, i + batchSize);
      if (!slice.length) break;
      const sliceRange = IDBKeyRange.bound(slice[0]!, slice[slice.length - 1]!);
      const records = await requestToPromise<Array<{ row: Record<string, unknown> }>>(
        db.transaction(ROWS_STORE, "readonly").objectStore(ROWS_STORE).getAll(sliceRange),
      );
      await onBatch(records.map((r) => r.row));
    }
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
    const meta = await getResultMeta(taskId);
    if (!meta || !meta.rowCount) throw new Error("NO_MEMBERS_FOUND");
    const reader: RowBatchReader = (onBatch) => readRowsInBatches(taskId, ROW_READ_BATCH, onBatch);
    const output = await exportFiles(meta, message.settings, reader);
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
