// Sample fonts bundled with the app (OFL): loaded on demand, embedded in the single-file build.
import melad from './MeladDisplay-Black.ttf?b64';
import jomhuria from './Jomhuria-Regular.ttf?b64';

const decode = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

export const SAMPLES: Record<string, () => Uint8Array> = {
  'MeladDisplay-Black.ttf': () => decode(melad),
  'Jomhuria-Regular.ttf': () => decode(jomhuria),
};
