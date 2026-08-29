// Ambient declarations for bundler-virtual modules.
// Global script file on purpose: wildcard module declarations are rejected inside modules.
declare module '*?url' {
  const url: string;
  export default url;
}
