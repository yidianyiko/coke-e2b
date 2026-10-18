import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { ProfileStore, profileDescriptor } from './profile-store.mjs';
import { vaultBrowserAction, prepareVaultContext } from './vault-browser.mjs';
import { createPublicNetworkProxy, publicHttpUrl } from './public-network.mjs';
import { chromium } from 'playwright-core';
import { captureBrowserScreenshot } from './browser-screenshot.mjs';

const token = process.env.COKE_BROWSER_TOKEN;
if (!token) throw new Error('COKE_BROWSER_TOKEN is required');

const readOnly = process.env.COKE_BROWSER_READ_ONLY === '1';
const leases = new Map();
const profiles = new ProfileStore(process.env.COKE_PROFILE_ROOT);
let browserPromise;
let publicProxyPromise;
function publicProxy() { return publicProxyPromise ||= createPublicNetworkProxy(); }

function getBrowser() {
  if (!browserPromise) {
    browserPromise = chromium.launch({
      headless: process.env.COKE_BROWSER_HEADLESS !== '0',
      executablePath: process.env.COKE_CHROMIUM_PATH || '/usr/bin/chromium-browser',
      args: ['--no-sandbox', '--disable-quic', '--force-webrtc-ip-handling-policy=disable_non_proxied_udp'],
    }).catch(error => {
      browserPromise = undefined;
      throw error;
    });
  }
  return browserPromise;
}

function reply(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
}

async function input(request) {
  const chunks = []; let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > 1_000_000) throw new Error('request is too large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks, bytes).toString('utf8') || '{}');
}

function ownedLease(args) {
  const lease = leases.get(args.leaseId);
  if (!lease) return { error: ['LEASE_NOT_FOUND', 404] };
  if (lease.userId !== args.userId || lease.taskId !== args.taskId) {
    return { error: ['LEASE_FORBIDDEN', 403] };
  }
  return { lease };
}

async function handle(request, response) {
  if (request.headers.authorization !== `Bearer ${token}`) {
    reply(response, 401, { error: { code: 'UNAUTHORIZED' } });
    return;
  }
  if (request.method !== 'POST') {
    reply(response, 405, { error: { code: 'METHOD_NOT_ALLOWED' } });
    return;
  }

  let args;
  try {
    args = await input(request);
  } catch {
    reply(response, 400, { error: { code: 'INVALID_JSON' } });
    return;
  }

  try {
    if (request.url === '/acquire') {
      if (!args.userId || !args.taskId) {
        reply(response, 400, { error: { code: 'INVALID_INPUT' } });
        return;
      }
      const browser = await getBrowser();
      const profile = args.profile ? profileDescriptor(args.profile) : undefined;
      const saved = profile ? await profiles.load(args.userId, profile) : undefined;
      const publicOnly = args.publicOnly === true || process.env.COKE_BROWSER_PUBLIC_ONLY === '1';
      const proxy = publicOnly ? await publicProxy() : undefined;
      const context = await browser.newContext({ ...(proxy ? {proxy:{server:proxy.url,bypass:'<-loopback>'}} : {}), ...(saved && args.vault !== true ? { storageState: saved.state } : {}), ...(readOnly || publicOnly || args.vault === true ? { serviceWorkers: 'block' } : {}) });
      if (args.vault === true) {
        try { await prepareVaultContext(context, { origin: profile.origin, fixture: new URL(profile.origin).protocol === 'http:' && new URL(profile.origin).hostname === '127.0.0.1' }); }
        catch (error) { await context.close(); throw error; }
      }
      if (readOnly) await context.route('**/*', route => ['GET', 'HEAD'].includes(route.request().method()) ? route.continue() : route.abort('blockedbyclient'));
      const page = await context.newPage();
      const leaseId = randomUUID();
      leases.set(leaseId, { userId: args.userId, taskId: args.taskId, context, page, profile, generation: saved?.generation, saveOnRelease: args.saveOnRelease !== false, publicOnly, vault: args.vault === true, authenticated: false, refs: new Map() });
      reply(response, 200, { leaseId });
      return;
    }

    const { lease, error } = ownedLease(args);
    if (error) {
      reply(response, error[1], { error: { code: error[0] } });
      return;
    }
    if (request.url === '/release') {
      if (lease.vault && args.saveProfile !== false && !lease.authenticated) { reply(response, 409, { error: { code: 'LOGIN_NOT_AUTHENTICATED' } }); return; }
      leases.delete(args.leaseId);
      let profileSaved = false;
      try {
        if (lease.profile && lease.saveOnRelease && args.saveProfile !== false) {
          try { await profiles.save(lease.userId, lease.profile, await lease.context.storageState(), lease.generation); profileSaved = true; }
          catch (error) { if (error.message !== 'PROFILE_REVOKED') throw error; }
        }
      } finally { await lease.context.close(); }
      reply(response, 200, { released: true, ...(lease.profile ? { profileSaved } : {}) });
      return;
    }
    if (request.url === '/vault') {
      if (!lease.vault || readOnly || !lease.profile) { reply(response, 403, { error: { code: 'VAULT_FORBIDDEN' } }); return; }
      const origin = lease.profile.origin;
      const result = await vaultBrowserAction(lease.page, args, { origin, fixture: new URL(origin).protocol === 'http:' && new URL(origin).hostname === '127.0.0.1' });
      lease.authenticated = result.status === 'authenticated';
      reply(response, 200, result); return;
    }
    if (request.url === '/handoff') {
      if (lease.vault) { reply(response, 403, { error: { code: 'VAULT_FORBIDDEN' } }); return; }

      const { page } = lease;
      if (readOnly && args.action !== 'screenshot') { reply(response, 403, { error: { code: 'READ_ONLY_VIOLATION' } }); return; }
      const viewport = page.viewportSize();
      const integer = (value, min, max) => Number.isInteger(value) && value >= min && value <= max;
      if (args.action === 'click' && integer(args.x, 0, viewport.width - 1) && integer(args.y, 0, viewport.height - 1)) await page.mouse.click(args.x, args.y);
      else if (args.action === 'type' && typeof args.text === 'string' && args.text.length <= 4096) await page.keyboard.insertText(args.text);
      else if (args.action === 'press' && ['Enter', 'Tab', 'Backspace', 'Escape', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space', 'ControlOrMeta+A'].includes(args.key)) await page.keyboard.press(args.key);
      else if (args.action === 'scroll' && integer(args.deltaY, -2000, 2000)) await page.mouse.wheel(0, args.deltaY);
      else if (args.action !== 'screenshot') { reply(response, 400, { error: { code: 'INVALID_INPUT' } }); return; }
      lease.refs.clear();
      const bytes = await page.screenshot();
      reply(response, 200, { pngBase64: bytes.toString('base64'), width: viewport.width, height: viewport.height });
      return;
    }
    if (request.url !== '/action') {
      reply(response, 404, { error: { code: 'UNKNOWN_ROUTE' } });
      return;
    }

    const { page } = lease;
    switch (args.action) {
      case 'navigate': {
        const url = lease.publicOnly ? publicHttpUrl(args.url) : new URL(args.url);
        if (!['http:', 'https:'].includes(url.protocol)) throw new Error('URL must use HTTP or HTTPS');
        lease.refs.clear();
        try {
          // A committed document is navigated; page readiness is verified separately by read.
          // Keep this bound below the gateway's 12 second request deadline.
          await page.goto(url.href, { waitUntil: 'commit', timeout: 10_000 });
        } catch (error) {
          reply(response, 422, { error: { code: error.name === 'TimeoutError' ? 'BROWSER_NAVIGATION_TIMEOUT' : 'BROWSER_NAVIGATION_FAILED' } });
          break;
        }
        lease.refs.clear();
        reply(response, 200, { url: page.url() });
        break;
      }
      case 'read': {
        const text = await page.locator('body').innerText();
        lease.refs.clear();
        const snapshotId = randomUUID();
        const elements = [];
        const handles = await page.locator('a, button, input:not([type="hidden"]), textarea, select, [role="button"], [role="link"], [role="tab"], [role="treeitem"], [role="textbox"], [role="checkbox"], [role="radio"]').elementHandles();
        for (const handle of handles) {
          if (elements.length >= 100) break;
          if (!await handle.isVisible()) continue;
          const { role, name } = await handle.evaluate(element => {
            const tag = element.tagName.toLowerCase();
            const type = element.getAttribute('type')?.toLowerCase();
            const role = element.getAttribute('role') || (tag === 'a' ? 'link' : tag === 'button' || ['button', 'submit', 'reset'].includes(type) ? 'button' : ['checkbox', 'radio'].includes(type) ? type : tag === 'select' ? 'combobox' : 'textbox');
            const name = (element.getAttribute('aria-label')
              || ('labels' in element && element.labels?.[0]?.textContent)
              || element.textContent || element.getAttribute('placeholder') || '').trim();
            return { role, name };
          });
          if (!name) continue;
          const ref = `${snapshotId}:${elements.length}`;
          lease.refs.set(ref, handle);
          elements.push({ ref, role, name, href: role === 'link' ? await handle.getAttribute('href') : undefined });
        }
        const loading = await page.evaluate(hasElements => {
          const visible = element => element.getClientRects().length > 0;
          const busy = [...document.querySelectorAll('[aria-busy="true"],[role="progressbar"]')].some(visible);
          const text = document.body.innerText.trim().replace(/[\u200b-\u200d\ufeff]/g, '');
          const mains = [...document.querySelectorAll('main,[role="main"]')].filter(visible);
          const emptyMain = mains.length > 0 && mains.every(main => {
            const walker = document.createTreeWalker(main, NodeFilter.SHOW_TEXT);
            for (let node; (node = walker.nextNode());) {
              const parent = node.parentElement;
              if (node.textContent.trim() && parent && visible(parent) && !parent.closest('nav,[role="navigation"],script,style')) return false;
            }
            return ![...main.querySelectorAll('input:not([type="hidden"]),textarea,select,[role="textbox"]')].some(visible);
          });
          // Resource completion is not content readiness: a third-party script can remain
          // pending while useful page text is visible. Explicit busy/empty shells still wait.
          return busy || emptyMain || (!text && !hasElements) || /^(loading(?:[ .…]| your tasks)*|加载中[ .…]*|正在加载[ .…]*)$/i.test(text);
        }, elements.length > 0);
        reply(response, 200, { url: page.url(), title: await page.title(), text, elements, loading });
        break;
      }
      case 'click-link': {
        if (!args.linkText) throw new Error('linkText is required');
        await page.getByRole('link', { name: args.linkText, exact: true }).click();
        lease.refs.clear();
        reply(response, 200, { url: page.url() });
        break;
      }
      case 'click-ref': {
        const handle = lease.refs.get(args.ref);
        if (!handle) {
          reply(response, 409, { error: { code: 'STALE_ELEMENT_REFERENCE' } });
          break;
        }
        if (readOnly && await handle.evaluate(element => ['checkbox', 'radio', 'switch'].includes(element.getAttribute('role')) || ['checkbox', 'radio', 'submit', 'reset'].includes(element.getAttribute('type')?.toLowerCase()) || ((element.getAttribute('role') === 'button' || element.tagName.toLowerCase() === 'button' || element.tagName.toLowerCase() === 'input' && element.getAttribute('type')?.toLowerCase() === 'button') && /删除|移除|完成|取消完成|delete|remove|complete/i.test(element.getAttribute('aria-label') || element.textContent || '')))) {
          reply(response, 403, { error: { code: 'READ_ONLY_VIOLATION' } }); break;
        }
        lease.refs.clear();
        try {
          await handle.click();
        } catch {
          reply(response, 409, { error: { code: 'STALE_ELEMENT_REFERENCE' } });
          break;
        }
        reply(response, 200, { url: page.url() });
        break;
      }
      case 'fill-ref': {
        if (readOnly) { reply(response, 403, { error: { code: 'READ_ONLY_VIOLATION' } }); break; }
        const handle = lease.refs.get(args.ref);
        if (!handle) {
          reply(response, 409, { error: { code: 'STALE_ELEMENT_REFERENCE' } });
          break;
        }
        if (typeof args.value !== 'string') {
          reply(response, 400, { error: { code: 'INVALID_INPUT' } });
          break;
        }
        lease.refs.clear();
        try {
          await handle.fill(args.value);
        } catch {
          reply(response, 409, { error: { code: 'STALE_ELEMENT_REFERENCE' } });
          break;
        }
        reply(response, 200, { url: page.url() });
        break;
      }
      case 'current-url': {
        reply(response, 200, { url: page.url() });
        break;
      }
      case 'extract': {
        if (!args.selector) throw new Error('selector is required');
        const value = (await page.locator(args.selector).innerText()).trim();
        reply(response, 200, { url: page.url(), value });
        break;
      }
      case 'screenshot': {
        let bytes;
        try { bytes = await captureBrowserScreenshot(page); }
        catch (error) {
          reply(response, 422, {error:{code:error.message === 'BROWSER_SCREENSHOT_TIMEOUT' ? 'BROWSER_SCREENSHOT_TIMEOUT' : 'BROWSER_SCREENSHOT_FAILED'}});
          break;
        }
        reply(response, 200, { url: page.url(), pngBase64: bytes.toString('base64') });
        break;
      }
      default:
        reply(response, 400, { error: { code: 'UNKNOWN_ACTION' } });
    }
  } catch (error) {
    reply(response, 422, { error: { code: 'BROWSER_ACTION_FAILED', message: error.message } });
  }
}

const server = createServer((request, response) => { void handle(request, response); });
server.listen(0, '127.0.0.1', () => {
  process.send?.({ type: 'ready', port: server.address().port });
});

let stopping = false;
function shutdown() {
  if (stopping) return;
  stopping = true;
  void (async () => {
    server.close();
    for (const lease of leases.values()) await lease.context.close();
    leases.clear();
    if (publicProxyPromise) await publicProxyPromise.then(proxy => proxy.close(), () => {});
    if (browserPromise) await browserPromise.then(browser => browser.close(), () => {});
    process.exit(0);
  })();
}
process.on('message', message => { if (message?.type === 'shutdown') shutdown(); });
process.on('disconnect', shutdown);
