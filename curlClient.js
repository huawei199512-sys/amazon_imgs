// curl 原生通道：Amazon 风控会对 Node(OpenSSL) 的 TLS/JA3 指纹静默降级（XHR 返回 "[object Object]"），
// 系统 curl（Schannel/Native TLS 栈）指纹与真实浏览器一致，可拿到正常 JSON。
// 设计要点：
//  - 纯代理，绝不直连
//  - multipart 文件部分通过 stdin 传入（@-），用户图片字节不写临时文件、不落盘
//  - 单请求超时强杀进程；响应头写临时文件（仅头部，不含图片数据），用完即删
const { spawn } = require('child_process');
const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const FormData = require('form-data');

const CURL_BIN = process.platform === 'win32' ? 'curl.exe' : 'curl';

function toCurlProxy(proxy) {
  if (proxy.startsWith('socks5://')) return 'socks5h://' + proxy.slice('socks5://'.length); // h=远端DNS
  if (proxy.startsWith('socks4://')) return 'socks4a://' + proxy.slice('socks4://'.length);
  return proxy.startsWith('http') ? proxy : 'http://' + proxy;
}

// 简易内存 Cookie 容器（无登录态，仅保存站点匿名会话 cookie）
class CookieJar {
  constructor() { this.map = new Map(); }
  ingest(headerDump) {
    const re = /^set-cookie:\s*([^\r\n]+)/gim;
    let m;
    while ((m = re.exec(String(headerDump || '')))) {
      const pair = m[1].split(';')[0];
      const i = pair.indexOf('=');
      if (i > 0) this.map.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
    }
  }
  toString() {
    return [...this.map].map(([k, v]) => `${k}=${v}`).join('; ');
  }
}

function parseStatus(headerDump) {
  const all = [...String(headerDump || '').matchAll(/HTTP\/[\d.]+ (\d{3})/g)];
  return all.length ? parseInt(all[all.length - 1][1], 10) : 0;
}

/**
 * @param {object} o
 * @param {string} o.proxy      代理地址（http/https/socks4/socks5）
 * @param {string} o.url
 * @param {string} [o.method]
 * @param {object} [o.headers]
 * @param {Array<{name:string,value:string}>} [o.fields] 普通文本表单字段
 * @param {{name:string,filename:string,contentType:string,buffer:Buffer}} [o.fileField] 文件字段（经stdin传输）
 * @param {string} [o.cookies]
 * @param {number} [o.timeoutMs=8000]
 * @param {boolean} [o.followRedirects=false]
 * @returns {Promise<{ok:boolean,status?:number,body:Buffer,headerDump?:string,error?:string}>}
 */
function curlRequest(o) {
  const {
    proxy, url, method = 'GET', headers = {}, fields = null, fileField = null,
    cookies = '', timeoutMs = 8000, followRedirects = false,
  } = o;

  return new Promise(resolve => {
    const hdrFile = path.join(os.tmpdir(), 'curlh_' + crypto.randomBytes(6).toString('hex'));
    const args = [
      '-s', '-S', '-g',
      '--proxy', toCurlProxy(proxy),
      '--max-time', String(Math.max(1, Math.round(timeoutMs / 1000))),
      '-D', hdrFile, '-o', '-',
      '-X', method,
      '-H', 'Accept-Encoding: identity',
    ];
    if (followRedirects) args.push('-L');
    else args.push('--max-redirs', '0');
    if (cookies) args.push('-H', 'Cookie: ' + cookies);
    for (const [k, v] of Object.entries(headers)) args.push('-H', `${k}: ${v}`);

    // multipart 在 Node 侧预组装为完整字节（Content-Length 精确），
    // 再 --data-binary @- 经 stdin 传输：
    // 不能用 -F @-（curl 对 stdin 长度未知会发 Transfer-Encoding: chunked，
    // StyleSnap 后端对 chunked 体解析为空图 -> 0识别框）
    let rawBody = null;
    if (fields || fileField) {
      const fd = new FormData();
      for (const f of (fields || [])) fd.append(f.name, f.value);
      if (fileField) {
        fd.append(fileField.name, fileField.buffer, {
          filename: fileField.filename,
          contentType: fileField.contentType,
        });
      }
      rawBody = fd.getBuffer();
      args.push('-H', 'Content-Type: ' + fd.getHeaders()['content-type']);
      args.push('-H', 'Content-Length: ' + rawBody.length);
      args.push('--data-binary', '@-');
    }
    args.push(url);

    let child;
    try {
      child = spawn(CURL_BIN, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      return resolve({ ok: false, body: Buffer.alloc(0), error: 'curl启动失败: ' + e.message });
    }

    const chunks = [];
    let stderrText = '';
    let settled = false;

    const finish = r => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      try { child.kill(); } catch { /* ignore */ }
      resolve(r);
    };

    const killTimer = setTimeout(() => finish({ ok: false, body: Buffer.concat(chunks), error: '超时' }), timeoutMs + 2000);

    child.stdout.on('data', d => chunks.push(d));
    child.stderr.on('data', d => { stderrText += d.toString(); });
    child.on('error', e => finish({ ok: false, body: Buffer.concat(chunks), error: e.code || e.message }));
    child.on('close', code => {
      let hdr = '';
      try { hdr = fs.readFileSync(hdrFile, 'utf8'); } catch { /* ignore */ }
      try { fs.unlinkSync(hdrFile); } catch { /* ignore */ }
      if (code !== 0) {
        const low = stderrText.toLowerCase();
        const error = low.includes('timed out') ? '超时'
          : low.includes('could not resolve') ? '代理DNS失败'
          : low.includes('connection refused') ? '代理拒绝连接'
          : low.includes('received http code 407') ? '代理需要认证(407)'
          : (stderrText.split('\n')[0] || `curl退出码${code}`).slice(0, 120);
        return finish({ ok: false, body: Buffer.concat(chunks), headerDump: hdr, error });
      }
      finish({ ok: true, status: parseStatus(hdr), body: Buffer.concat(chunks), headerDump: hdr });
    });

    try {
      child.stdin.on('error', () => { /* curl提前断开时stdin EOF，close事件会兜底 */ });
      if (rawBody) {
        child.stdin.write(rawBody);
        child.stdin.end();
      } else {
        child.stdin.end();
      }
    } catch { /* close事件兜底 */ }
  });
}

module.exports = { curlRequest, CookieJar, CURL_BIN, toCurlProxy };
