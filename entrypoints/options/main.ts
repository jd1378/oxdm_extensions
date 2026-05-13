import { getSettings, setSettings, DEFAULTS, type Settings } from '@/src/shared/state';

const app = document.getElementById('app')!;
let settings: Settings;

function render() {
  app.innerHTML = `
    <style>
      :root { color-scheme: light dark; }
      body { font: 14px system-ui,-apple-system,Segoe UI,sans-serif; max-width: 640px; margin: 24px auto; padding: 0 16px; background: Canvas; color: CanvasText; }
      h1 { font-size: 18px; }
      label { display: block; margin: 12px 0 4px; font-weight: 600; }
      input[type=number], input[type=text], input[type=password], textarea {
        width: 100%; padding: 6px 8px; border: 1px solid GrayText; border-radius: 6px;
        background: Canvas; color: CanvasText; font: inherit;
      }
      textarea { min-height: 84px; resize: vertical; }
      .row { display: flex; gap: 16px; align-items: center; }
      .row > * { flex: 1; }
      .checks label { font-weight: normal; display: flex; gap: 6px; align-items: center; }
      button { padding: 6px 14px; border-radius: 6px; border: 1px solid GrayText; background: ButtonFace; color: ButtonText; cursor: pointer; }
      button.primary { background: #2563eb; color: white; border-color: transparent; }
      .hint { color: GrayText; font-size: 12px; margin-top: 4px; }
      .saved { color: #16a34a; margin-left: 12px; }
    </style>
    <h1>oxdm options</h1>

    <div class="row">
      <div>
        <label>Transport</label>
        <select id="transport">
          <option value="auto">Auto (native, fallback to WebSocket)</option>
          <option value="native">Native messaging only</option>
          <option value="ws">WebSocket only</option>
        </select>
        <div class="hint">Native skips token entry — host self-discovers from oxdm.db</div>
      </div>
      <div>
        <label>Native host name</label>
        <input type="text" id="nativeHostName" />
        <div class="hint">Must match the installed manifest's <code>name</code> field</div>
      </div>
    </div>

    <div class="row">
      <div>
        <label>IPC port (WebSocket transport)</label>
        <input type="number" id="port" min="1" max="65535" />
        <div class="hint">oxdm Settings → Browser integration → IPC port</div>
      </div>
      <div>
        <label>Extension token (WebSocket transport)</label>
        <input type="password" id="token" autocomplete="off" />
        <div class="hint">Copy from oxdm Settings → Browser integration</div>
      </div>
    </div>

    <div class="row">
      <div>
        <label>Minimum size (bytes; 0 = no minimum)</label>
        <input type="number" id="minSize" min="0" />
      </div>
      <div>
        <label>Scan interval (ms)</label>
        <input type="number" id="scanIntervalMs" min="500" />
      </div>
    </div>

    <div class="checks">
      <label><input type="checkbox" id="injectButton" /> Inject oxdm button next to download links</label>
    </div>

    <label>Skip domains (one per line)</label>
    <textarea id="skipDomains"></textarea>

    <label>Skip file extensions (comma-separated, no dot)</label>
    <input type="text" id="skipExtensions" />

    <label>Skip MIME prefixes (comma-separated)</label>
    <input type="text" id="skipMimePrefixes" />

    <div class="row" style="margin-top:20px;">
      <button class="primary" id="save">Save</button>
      <button id="reset">Reset to defaults</button>
      <span class="saved" id="saved"></span>
    </div>
  `;

  set('transport', settings.transport);
  set('nativeHostName', settings.nativeHostName);
  set('port', settings.port);
  set('token', settings.token);
  set('minSize', settings.minSize);
  set('scanIntervalMs', settings.scanIntervalMs);
  (document.getElementById('injectButton') as HTMLInputElement).checked = settings.injectButton;
  set('skipDomains', settings.skipDomains.join('\n'));
  set('skipExtensions', settings.skipExtensions.join(','));
  set('skipMimePrefixes', settings.skipMimePrefixes.join(','));

  document.getElementById('save')!.addEventListener('click', save);
  document.getElementById('reset')!.addEventListener('click', async () => {
    await setSettings(DEFAULTS);
    settings = await getSettings();
    render();
    flashSaved('Reset.');
  });
}

function set(id: string, v: string | number) {
  const el = document.getElementById(id) as
    | HTMLInputElement
    | HTMLTextAreaElement
    | HTMLSelectElement;
  el.value = String(v);
}
function get(id: string): string {
  return (document.getElementById(id) as HTMLInputElement | HTMLTextAreaElement).value;
}

async function save() {
  const transport = get('transport') as Settings['transport'];
  const patch: Partial<Settings> = {
    transport: ['auto', 'native', 'ws'].includes(transport) ? transport : 'auto',
    nativeHostName: get('nativeHostName').trim() || DEFAULTS.nativeHostName,
    port: +get('port') || DEFAULTS.port,
    token: get('token').trim(),
    minSize: Math.max(0, +get('minSize') || 0),
    scanIntervalMs: Math.max(500, +get('scanIntervalMs') || DEFAULTS.scanIntervalMs),
    injectButton: (document.getElementById('injectButton') as HTMLInputElement).checked,
    skipDomains: parseList(get('skipDomains'), /\s+/),
    skipExtensions: parseList(get('skipExtensions'), /,/).map((s) => s.toLowerCase().replace(/^\./, '')),
    skipMimePrefixes: parseList(get('skipMimePrefixes'), /,/).map((s) => s.toLowerCase()),
  };
  await setSettings(patch);
  flashSaved('Saved.');
}

function parseList(text: string, sep: RegExp): string[] {
  return text.split(sep).map((s) => s.trim()).filter(Boolean);
}

function flashSaved(text: string) {
  const el = document.getElementById('saved')!;
  el.textContent = text;
  setTimeout(() => (el.textContent = ''), 1500);
}

(async () => {
  settings = await getSettings();
  render();
})();
