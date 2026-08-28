// Ambient declarations for bundler-virtual modules and untyped @ffmpeg/core.
// Global script file on purpose: wildcard module declarations are rejected inside modules.
declare module '*?url' {
  const url: string;
  export default url;
}
declare module '@ffmpeg/core' {
  export interface FFmpegCoreLoggerEvent { type: string; message: string }
  export interface FFmpegCoreFS {
    writeFile(path: string, data: Uint8Array): void;
    readFile(path: string): Uint8Array;
    unlink(path: string): void;
  }
  export interface FFmpegCoreModule {
    setLogger(callback: (event: FFmpegCoreLoggerEvent) => void): void;
    setTimeout(seconds: number): void;
    exec(...args: string[]): void;
    readonly ret: number;
    reset(): void;
    FS: FFmpegCoreFS;
  }
  export interface FFmpegCoreConfig {
    /** '#'+base64 JSON of {wasmURL, workerURL}; the factory's own resolver reads only this (it overwrites any locateFile option). */
    mainScriptUrlOrBlob?: string;
  }
  export default function createFFmpegCore(config?: FFmpegCoreConfig): Promise<FFmpegCoreModule>;
}
