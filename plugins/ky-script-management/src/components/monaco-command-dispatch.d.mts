export type MonacoCommandEditor = {
  getAction: (id: string) => { run: () => void | Promise<void> } | null;
  trigger: (source: string, handlerId: string, payload: unknown) => void;
};

export declare function dispatchMonacoCommand(
  editor: MonacoCommandEditor,
  id: string,
  notice?: (type: "warning" | "error", text: string) => void
): boolean;
