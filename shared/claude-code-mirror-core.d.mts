export declare const BLOCK_SIZE: number;
export interface MirrorTuple { position: number; uuid: string; sha256: string }
export interface MirrorBlock { index: number; digest: string }
export declare function canonicalJson(value: unknown): string;
export declare function sha256Hex(text: string): string;
export declare const FILTER_VERSION: 2;
export declare const SUPPORTED_FILTER_VERSIONS: readonly number[];
export declare function filterEntry(raw: unknown, version?: number): Record<string, unknown>;
export declare function isFilterFixedPoint(entry: unknown, version?: number): boolean;
export declare function stripToV1<T>(entry: T): T;
export declare function contentSha256(entry: unknown): string;
export declare function blockIndexOf(position: number): number;
export declare function tupleKey(position: number, uuid: string | null | undefined, sha: string): string;
export declare function blockDigest(sessionId: string, tuples: MirrorTuple[]): string;
export declare function rootDigest(sessionId: string, blocks: MirrorBlock[]): string;
