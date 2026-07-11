import { parseCurrentPage } from "./parser";

async function preparePageForCapture(): Promise<void> {
  if (!/linkedin\.com\/search\/results\/people/i.test(window.location.href)) {
    return;
  }
  const startY = window.scrollY;
  const step = Math.max(400, Math.floor(window.innerHeight * 0.75));
  for (let i = 0; i < 4; i += 1) {
    window.scrollBy(0, step);
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  window.scrollTo(0, startY);
  await new Promise((resolve) => setTimeout(resolve, 250));
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "COLLECT_RECRUITERS") {
    return false;
  }
  void (async () => {
    try {
      if (message.prepareLazyLoad === true) {
        await preparePageForCapture();
      }
      sendResponse(parseCurrentPage(document, window.location.href));
    } catch (error) {
      // A parser crash must still answer the popup — otherwise the port closes
      // and the popup shows a generic "couldn't reach this page".
      sendResponse({ candidates: [], error: error instanceof Error ? error.message : String(error) });
    }
  })();
  return true;
});
