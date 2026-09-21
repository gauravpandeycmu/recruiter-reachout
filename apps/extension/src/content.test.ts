// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://www.linkedin.com/search/results/people/?keywords=Recruiter"}
import { afterEach, expect, it, vi } from "vitest";

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.innerHTML = ""; });

it.each(["Microsoft", "Google", "Figma"])("waits for LinkedIn and activates the nested first suggestion button for %s", async (company) => {
  vi.useFakeTimers();
  history.replaceState(null, "", "/search/results/people/?keywords=Recruiter");
  vi.stubGlobal("chrome", { runtime: { onMessage: { addListener: vi.fn() } } });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ width: 100, height: 30 } as DOMRect);
  const { applyCurrentCompanyFilter } = await import("./content");
  const selection = vi.fn();
  setTimeout(() => {
    const trigger = document.createElement("div");
    trigger.setAttribute("role", "button");
    trigger.setAttribute("aria-label", "Filter by Current companies");
    document.body.append(trigger);
    trigger.onclick = () => {
      const input = document.createElement("input");
      input.placeholder = "Add a company";
      document.body.append(input);
      input.oninput = () => setTimeout(() => {
        const list = document.createElement("div");
        list.setAttribute("role", "listbox");
        list.innerHTML = `<div role="option"><button>${company} Software Development</button></div>`;
        document.body.append(list);
        list.querySelector("button")!.onclick = () => {
          selection();
          const apply = document.createElement("a");
          apply.innerText = "Show results";
          apply.onclick = () => { history.replaceState(null, "", "/search/results/people/?keywords=Recruiter&currentCompany=%5B%221035%22%5D"); };
          document.body.append(apply);
        };
      }, 700);
    };
  }, 1800);
  const result = applyCurrentCompanyFilter(company);
  await vi.runAllTimersAsync();
  expect(await result).toBe(true);
  expect(selection).toHaveBeenCalledOnce();
  expect(new URL(location.href).searchParams.get("keywords")).toBe("Recruiter");
});
