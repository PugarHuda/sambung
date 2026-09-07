// pngjs arrives with Playwright and ships no types of its own.
//
// Declared here rather than added to package.json on purpose: the package is
// already on disk as a Playwright dependency, and `npm install` in this project
// wipes a hand-applied patch in @dcl/sdk-commands that the deploy cannot work
// without. This is the whole slice of the API the pad-colour check uses; if a
// future Playwright drops the dependency, the import fails loudly rather than
// silently degrading.
declare module 'pngjs' {
  export const PNG: {
    sync: {
      read(buffer: Buffer): { width: number; height: number; data: Uint8Array }
    }
  }
}
