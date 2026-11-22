// usage: node test/cdp.mjs <port> <js-file | -e expr | --shot out.png>
// DevTools protocol helper for test/agent-smoke.sh: evaluates in the Apple Music page (or the first page).
const port = process.argv[2];
const expr = process.argv[3] === '-e' ? process.argv[4] : process.argv[3] === '--shot' ? '' : (await import('fs')).readFileSync(process.argv[3], 'utf8');
const tabs = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const t = tabs.find(t => t.type === 'page' && /music\.apple/.test(t.url)) || tabs.find(t => t.type === 'page');
const ws = new WebSocket(t.webSocketDebuggerUrl);
await new Promise(r => ws.onopen = r);
let id = 0;
const send = (method, params) => new Promise(res => { const i = ++id; const h = (m) => { const d = JSON.parse(m.data); if (d.id === i) { ws.removeEventListener('message', h); res(d); } }; ws.addEventListener('message', h); ws.send(JSON.stringify({ id: i, method, params })); });
if (process.argv[3] === '--shot') { const r = await send('Page.captureScreenshot', { format: 'png' }); (await import('fs')).writeFileSync(process.argv[4], Buffer.from(r.result.data, 'base64')); console.log('saved'); }
else { const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); console.log(r.result.exceptionDetails ? JSON.stringify(r.result.exceptionDetails, null, 1) : typeof r.result.result.value === 'string' ? r.result.result.value : JSON.stringify(r.result.result.value, null, 1)); }
ws.close();
