export declare const PINNED_CHROME: string;
export declare function gateBrowser(env?: Record<string, string | undefined>): {
  label: string;
  launch: { executablePath: string } | { channel: string };
};
