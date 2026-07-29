// Vite asset-URL imports for model files (see vite.config assetsInclude).
declare module '*.obj?url' {
  const url: string;
  export default url;
}
