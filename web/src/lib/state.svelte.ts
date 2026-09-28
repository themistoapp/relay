export const auth = $state({ signedIn: null as boolean | null });

export const meta = $state({ publicBaseUrl: "", tz: "", builtAt: null as string | null, alertsOn: false, backups: [] as string[] });

export const toast = $state({ text: "", bad: false, show: false });
let timer: ReturnType<typeof setTimeout> | undefined;
export function say(text: string, bad = false) {
  toast.text = text;
  toast.bad = bad;
  toast.show = true;
  clearTimeout(timer);
  timer = setTimeout(() => (toast.show = false), bad ? 5000 : 2800);
}

/** Hand-off between pages, e.g. "Build an endpoint →" preselects its source in the Pick step. */
export const pending = $state({ sourceId: null as number | null });
