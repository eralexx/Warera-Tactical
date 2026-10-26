interface ReadMessage { type: string; contextRevision?: number; [field: string]: unknown }
interface ReadReply<T = unknown> { ok: boolean; data?: T; error?: { code: string; message?: string } }
interface QueryResult<T = unknown> { data: T; cached: boolean; key: string; createdAt: number; expiresAt: number; provider: "official" | "gateway" | "official5" }
interface ContentModule { sync(options?: {shared?: Map<string, unknown>; discover?: boolean; reason?: string}): void; tick?(): void; destroy(): void; snapshotState?(): unknown; restoreState?(state: unknown): void }
declare var chrome: { runtime: { id: string; onMessage: {addListener(listener: (message: any, sender: {id:string}) => void): void}; sendMessage(message: ReadMessage): Promise<ReadReply<any>> } };

interface StorageAdapter { get(keys: string|string[]|null): Promise<Record<string, any>>; set(values:Record<string,unknown>): Promise<void>; remove(keys:string[]): Promise<void>; getKeys?():Promise<string[]> }
