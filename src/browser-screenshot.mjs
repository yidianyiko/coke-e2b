// A screenshot is evidence of the current rendering, not resource readiness.
// Playwright waits for document.fonts.ready, which can stay pending indefinitely.
export async function captureBrowserScreenshot(page, {timeoutMs = 3000} = {}) {
 try {
  return await page.screenshot({fullPage:true, timeout:timeoutMs});
 } catch (error) {
  if (error.name !== 'TimeoutError') throw error;
 }
 let session, timer, expired = false;
 const deadline = new Promise((_, reject) => {
  timer = setTimeout(() => reject(new Error('BROWSER_SCREENSHOT_TIMEOUT')), timeoutMs);
 });
 try {
  const capture = (async () => {
   session = await page.context().newCDPSession(page);
   if (expired) { void session.detach().catch(() => {}); throw new Error('BROWSER_SCREENSHOT_TIMEOUT'); }
   const {cssContentSize} = await session.send('Page.getLayoutMetrics');
   const {data} = await session.send('Page.captureScreenshot', {
    format:'png', captureBeyondViewport:true,
    clip:{...cssContentSize, scale:1},
   });
   return Buffer.from(data, 'base64');
  })();
  return await Promise.race([capture, deadline]);
 } finally {
  expired = true;
  clearTimeout(timer);
  // A stalled renderer can also stall detach. Context shutdown remains the
  // final owner of the session; cleanup must not hide the screenshot deadline.
  void session?.detach().catch(() => {});
 }
}
