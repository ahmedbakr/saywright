/** The @mediapipe/tasks-vision version the studio is built with (vite.config.ts). */
declare const __MEDIAPIPE_VERSION__: string;

declare module 'llama-tokenizer-js' {
  const tokenizer: {
    encode(text: string, addBosToken?: boolean, addPrecedingSpace?: boolean): number[];
    decode(tokens: number[], addBosToken?: boolean, addPrecedingSpace?: boolean): string;
  };
  export default tokenizer;
}

/** launch-editor's parts that find the editor and its arguments (server/editor.ts starts it itself, without a shell). */
declare module 'launch-editor/guess.js' {
  const guess: {
    getEditorFromMacProcesses(output: string): string | undefined;
    getEditorFromLinuxProcesses(output: string): string | undefined;
    getEditorFromWindowsProcesses(output: string): string | undefined;
  };
  export default guess;
}

declare module 'launch-editor/get-args.js' {
  export default function getArgumentsForFile(editor: string, fileName: string, lineNumber: string, columnNumber: string): string[];
}
