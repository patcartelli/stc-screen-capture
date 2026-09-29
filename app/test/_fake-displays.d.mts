export declare const PRIMARY_DISPLAY_ENV: string;
export declare function fakeDisplayIds(env?: Record<string, string | undefined>): { builtIn: number; external: number };
export declare function defaultFakeDisplays(env?: Record<string, string | undefined>): Array<{
  id: number; main: boolean; name: string; pointW: number; pointH: number;
  pixelW: number; pixelH: number; originX: number; originY: number;
}>;
